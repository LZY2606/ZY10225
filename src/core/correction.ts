import { isPhysicalSalinity, practicalSalinity } from './salinity.js';
import { segmentCast } from './segmentation.js';
import type {
  CorrectionParameters,
  CorrectionResult,
  CorrectedSample,
  NumericSummary,
  PressureLayerComparison,
  RawChannelSummary,
  RawSample,
  SegmentedSample
} from './types.js';

interface ValidRun {
  id: number;
  startSec: number;
  endSec: number;
  count: number;
  indices: number[];
}

export const DEFAULT_PARAMETERS: CorrectionParameters = {
  name: 'aligned-thermal-default',
  temperatureDelaySec: 4,
  conductivityDelaySec: 3,
  thermalAlpha: 0.03,
  thermalTauSec: 8,
  thermalGain: 1,
  waterStartSec: 30,
  waterEndSec: 240,
  excludePumpOff: true
};

function summarize(values: Array<number | null>): NumericSummary | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length === 0) return null;
  const sum = finite.reduce((total, value) => total + value, 0);
  return {
    count: finite.length,
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean: sum / finite.length
  };
}

function salinityOrNull(conductivity: number | null, temperature: number | null, pressure: number): number | null {
  if (conductivity === null || temperature === null) return null;
  const salinity = practicalSalinity(conductivity, temperature, pressure);
  return Number.isFinite(salinity) ? salinity : null;
}

function buildValidRuns(samples: readonly SegmentedSample[], parameters: CorrectionParameters): ValidRun[] {
  const runs: ValidRun[] = [];
  let current: number[] = [];
  let previousTime = Number.NaN;

  const close = () => {
    if (current.length === 0) return;
    const first = samples[current[0]!]!;
    const last = samples[current[current.length - 1]!]!;
    runs.push({
      id: runs.length + 1,
      startSec: first.elapsedSec,
      endSec: last.elapsedSec,
      count: current.length,
      indices: current
    });
    current = [];
  };

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const inWaterWindow =
      sample.elapsedSec >= parameters.waterStartSec &&
      sample.elapsedSec < parameters.waterEndSec;
    const eligible = inWaterWindow && sample.pumpOn && sample.sensorOk;
    const continuous = current.length === 0 || sample.elapsedSec - previousTime <= 1.5;
    if (!eligible || !continuous) close();
    if (eligible) {
      current.push(index);
      previousTime = sample.elapsedSec;
    } else {
      previousTime = Number.NaN;
    }
  }
  close();
  return runs;
}

function interpolateInRun(
  run: ValidRun,
  samples: readonly SegmentedSample[],
  targetIndex: number,
  delaySec: number,
  pick: (sample: SegmentedSample) => number
): number | null {
  const targetTime = samples[targetIndex]!.elapsedSec + delaySec;
  const first = samples[run.indices[0]!]!;
  const last = samples[run.indices[run.indices.length - 1]!]!;
  if (targetTime < first.elapsedSec || targetTime > last.elapsedSec) return null;

  for (let position = 1; position < run.indices.length; position += 1) {
    const left = samples[run.indices[position - 1]!]!;
    const right = samples[run.indices[position]!]!;
    if (targetTime >= left.elapsedSec && targetTime <= right.elapsedSec) {
      if (right.elapsedSec === left.elapsedSec) return pick(right);
      const fraction = (targetTime - left.elapsedSec) / (right.elapsedSec - left.elapsedSec);
      return pick(left) + (pick(right) - pick(left)) * fraction;
    }
  }
  return null;
}

export function correctCast(
  rawSamples: readonly RawSample[],
  parameters: CorrectionParameters = DEFAULT_PARAMETERS
): CorrectionResult {
  const { samples: segmentedSamples, segments } = segmentCast(rawSamples);
  const rawRuns = buildValidRuns(segmentedSamples, parameters);
  const runByIndex = new Map<number, number>();
  for (const run of rawRuns) {
    for (const index of run.indices) runByIndex.set(index, run.id);
  }

  const samples: CorrectedSample[] = segmentedSamples.map((sample, index) => {
    const inWindow =
      sample.elapsedSec >= parameters.waterStartSec &&
      sample.elapsedSec < parameters.waterEndSec;
    const selected = inWindow && (!parameters.excludePumpOff || sample.pumpOn) && sample.sensorOk;
    const diagnostics: string[] = [];
    let status: CorrectedSample['status'] = 'valid';
    if (!inWindow) status = 'outside_water_window';
    else if (!sample.pumpOn) status = 'pump_off';
    else if (!sample.sensorOk) status = 'acquisition_break';
    if (!sample.pumpOn) diagnostics.push('alignment is cut by pump closure');
    if (!sample.sensorOk) diagnostics.push('sensor frame marked invalid');

    return {
      ...sample,
      selected,
      validRunId: runByIndex.get(index) ?? null,
      shiftedTemperatureC: null,
      shiftedConductivitySM: null,
      filteredTemperatureC: null,
      thermalConductivitySM: null,
      correctedConductivitySM: null,
      rawSalinityPsu: salinityOrNull(sample.conductivitySM, sample.temperatureC, sample.pressureDbar),
      salinityPsu: null,
      status,
      diagnostics
    };
  });

  for (const run of rawRuns) {
    let filterInitialized = false;
    let filteredTemperature = Number.NaN;
    let previousTarget: CorrectedSample | null = null;

    for (const index of run.indices) {
      const target = samples[index]!;
      target.shiftedTemperatureC = interpolateInRun(
        run,
        segmentedSamples,
        index,
        parameters.temperatureDelaySec,
        (sample) => sample.temperatureC
      );
      target.shiftedConductivitySM = interpolateInRun(
        run,
        segmentedSamples,
        index,
        parameters.conductivityDelaySec,
        (sample) => sample.conductivitySM
      );

      if (target.shiftedTemperatureC === null || target.shiftedConductivitySM === null) {
        target.status = 'alignment_guard';
        target.diagnostics.push('delay source bracket is unavailable inside this guarded run');
        previousTarget = null;
        continue;
      }

      if (!filterInitialized) {
        filteredTemperature = target.shiftedTemperatureC;
        filterInitialized = true;
      } else if (previousTarget?.filteredTemperatureC !== null && previousTarget?.filteredTemperatureC !== undefined) {
        const dt = target.elapsedSec - previousTarget.elapsedSec;
        filteredTemperature =
          previousTarget.filteredTemperatureC +
          (target.shiftedTemperatureC - previousTarget.filteredTemperatureC) *
            (1 - Math.exp(-dt / parameters.thermalTauSec));
      }
      target.filteredTemperatureC = filteredTemperature;

      if (previousTarget?.filteredTemperatureC === null || previousTarget?.filteredTemperatureC === undefined) {
        target.thermalConductivitySM = 0;
      } else {
        const dt = target.elapsedSec - previousTarget.elapsedSec;
        const derivative = (filteredTemperature - previousTarget.filteredTemperatureC!) / dt;
        target.thermalConductivitySM =
          parameters.thermalAlpha * 8 * parameters.thermalGain * derivative;
      }

      target.correctedConductivitySM =
        target.shiftedConductivitySM - target.thermalConductivitySM;
      const correctedSalinity = practicalSalinity(
        target.correctedConductivitySM,
        target.shiftedTemperatureC,
        target.pressureDbar
      );

      if (
        !isPhysicalSalinity(
          correctedSalinity,
          target.shiftedTemperatureC,
          target.correctedConductivitySM
        )
      ) {
        target.salinityPsu = null;
        target.status = 'nonphysical_salinity';
        target.diagnostics.push(
          `rejected salinity=${Number.isFinite(correctedSalinity) ? correctedSalinity.toFixed(6) : 'NaN'}`,
          `retained shifted C=${target.shiftedConductivitySM.toFixed(6)} S/m`,
          `retained thermal correction=${target.thermalConductivitySM.toFixed(6)} S/m`,
          `retained shifted T=${target.shiftedTemperatureC.toFixed(6)} C`
        );
      } else {
        target.salinityPsu = correctedSalinity;
      }
      previousTarget = target;
    }
  }

  const selectedSamples = samples.filter((sample) => sample.selected);
  const rawSummary: RawChannelSummary = {
    selectedCount: selectedSamples.length,
    excludedPumpOff: samples.filter((sample) => {
      const inWindow =
        sample.elapsedSec >= parameters.waterStartSec &&
        sample.elapsedSec < parameters.waterEndSec;
      return inWindow && !sample.pumpOn;
    }).length,
    excludedOutsideWindow: samples.filter(
      (sample) =>
        sample.elapsedSec < parameters.waterStartSec ||
        sample.elapsedSec >= parameters.waterEndSec
    ).length,
    pressure: summarize(selectedSamples.map((sample) => sample.pressureDbar)),
    temperature: summarize(selectedSamples.map((sample) => sample.temperatureC)),
    conductivity: summarize(selectedSamples.map((sample) => sample.conductivitySM)),
    rawSalinity: summarize(selectedSamples.map((sample) => sample.rawSalinityPsu))
  };

  const bins = new Map<number, { down: number[]; up: number[] }>();
  for (const sample of samples) {
    if (!sample.selected || sample.salinityPsu === null) continue;
    if (sample.phase !== 'downcast' && sample.phase !== 'upcast') continue;
    if (sample.status === 'alignment_guard') continue;
    const bin = Math.floor(sample.pressureDbar / 100) * 100;
    if (bin < 100) continue;
    const entry = bins.get(bin) ?? { down: [], up: [] };
    entry[sample.phase === 'downcast' ? 'down' : 'up'].push(sample.salinityPsu);
    bins.set(bin, entry);
  }
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
  const layers: PressureLayerComparison[] = [...bins.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bin, values]) => {
      const downcastSalinity = mean(values.down);
      const upcastSalinity = mean(values.up);
      const difference =
        downcastSalinity === null || upcastSalinity === null
          ? null
          : upcastSalinity - downcastSalinity;
      return {
        pressureDbar: bin + 50,
        downcastCount: values.down.length,
        upcastCount: values.up.length,
        downcastSalinity,
        upcastSalinity,
        upMinusDown: difference,
        absoluteDifference: difference === null ? null : Math.abs(difference)
      };
    });
  const commonLayers = layers.filter(
    (layer) => layer.absoluteDifference !== null && layer.downcastCount > 0 && layer.upcastCount > 0
  );
  const differences = commonLayers
    .map((layer) => layer.absoluteDifference)
    .filter((value): value is number => value !== null);
  const metrics = {
    commonLayerCount: commonLayers.length,
    meanAbsoluteDifference:
      differences.length === 0
        ? null
        : differences.reduce((total, value) => total + value, 0) / differences.length,
    rmseDifference:
      differences.length === 0
        ? null
        : Math.sqrt(
            commonLayers
              .map((layer) => layer.upMinusDown)
              .filter((value): value is number => value !== null)
              .reduce((total, value) => total + value * value, 0) / differences.length
          ),
    nonphysicalCount: samples.filter((sample) => sample.status === 'nonphysical_salinity').length,
    alignmentGuardCount: samples.filter((sample) => sample.status === 'alignment_guard').length
  };

  return {
    parameters,
    samples,
    segments,
    validRuns: rawRuns.map(({ id, startSec, endSec, count }) => ({ id, startSec, endSec, count })),
    rawSummary,
    layers,
    metrics
  };
}
