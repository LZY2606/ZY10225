import { describe, expect, it } from 'vitest';
import { correctCast, DEFAULT_PARAMETERS } from './correction.js';
import { createFixtureSamples } from './fixture.js';
import { practicalSalinity } from './salinity.js';
import { segmentCast } from './segmentation.js';
import type { CorrectionParameters, CorrectedSample, RawSample } from './types.js';

const byTime = (samples: readonly CorrectedSample[], time: number): CorrectedSample =>
  samples.find((sample) => sample.elapsedSec === time)!;

describe('fixed cast segmentation', () => {
  it('splits boat, descent, bottom dwell and ascent with left-closed right-open boundaries', () => {
    const result = correctCast(createFixtureSamples());
    const phases = result.samples.map((sample) => [sample.elapsedSec, sample.phase] as const);

    expect(phases).toContainEqual([29, 'boat']);
    expect(phases).toContainEqual([30, 'downcast']);
    expect(result.segments.map((segment) => segment.phase)).toEqual([
      'boat',
      'downcast',
      'bottom_dwell',
      'upcast',
      'boat'
    ]);
    for (const segment of result.segments) {
      expect(segment.endIndex - segment.startIndex).toBe(segment.count);
      expect(result.samples[segment.endIndex - 1]!.elapsedSec).toBe(segment.endSec);
    }
  });

  it('keeps descent and ascent identities when pressure is non-monotonic', () => {
    const result = correctCast(createFixtureSamples());
    const descentWiggle = byTime(result.samples, 81);
    const ascentWiggle = byTime(result.samples, 191);

    expect(descentWiggle.pressureDbar).toBeLessThan(byTime(result.samples, 80).pressureDbar);
    expect(descentWiggle.phase).toBe('downcast');
    expect(ascentWiggle.pressureDbar).toBeGreaterThan(byTime(result.samples, 190).pressureDbar);
    expect(ascentWiggle.phase).toBe('upcast');

    const downAtFiveHundred = result.samples.filter(
      (sample) => sample.phase === 'downcast' && sample.pressureDbar >= 490 && sample.pressureDbar <= 520
    );
    const upAtFiveHundred = result.samples.filter(
      (sample) => sample.phase === 'upcast' && sample.pressureDbar >= 490 && sample.pressureDbar <= 520
    );
    expect(downAtFiveHundred.length).toBeGreaterThan(0);
    expect(upAtFiveHundred.length).toBeGreaterThan(0);
    expect(result.layers.some((layer) => layer.downcastCount > 0 && layer.upcastCount > 0)).toBe(true);
  });
});

describe('guarded alignment and filtering', () => {
  it('does not interpolate across acquisition gaps or pump closures', () => {
    const result = correctCast(createFixtureSamples(), DEFAULT_PARAMETERS);
    const afterAcquisitionGap = byTime(result.samples, 92);
    const beforePumpClosure = byTime(result.samples, 130);
    const afterPumpRestart = byTime(result.samples, 150);
    const lastBeforePumpClosure = result.samples.filter((sample) => sample.elapsedSec < 134 && sample.status === 'valid').at(-1)!;
    const invalidFrame = byTime(result.samples, 178);
    const runIds = new Set(result.samples.map((sample) => sample.validRunId).filter(Boolean));

    expect(afterAcquisitionGap.status).toBe('alignment_guard');
    expect(afterAcquisitionGap.shiftedTemperatureC).toBeNull();
    expect(afterAcquisitionGap.shiftedConductivitySM).toBeNull();
    expect(afterAcquisitionGap.diagnostics.join(' ')).toContain('guarded run');
    expect(beforePumpClosure.status).toBe('alignment_guard');
    expect(afterPumpRestart.status).toBe('valid');
    expect(afterPumpRestart.validRunId).not.toBe(lastBeforePumpClosure.validRunId);
    expect(invalidFrame.status).toBe('acquisition_break');
    expect(runIds.size).toBeGreaterThanOrEqual(3);
  });

  it('excludes pump-off samples according to the selected water window', () => {
    const result = correctCast(createFixtureSamples(), {
      ...DEFAULT_PARAMETERS,
      waterStartSec: 12,
      waterEndSec: 250
    });
    const pumpOffBottom = byTime(result.samples, 138);
    const deckAfterRecovery = byTime(result.samples, 250);

    expect(pumpOffBottom.selected).toBe(false);
    expect(pumpOffBottom.status).toBe('pump_off');
    expect(deckAfterRecovery.status).toBe('outside_water_window');
    expect(result.rawSummary.excludedPumpOff).toBeGreaterThan(0);
  });

  it('reduces common pressure layer mismatch after matching actual channel delays', () => {
    const unaligned = correctCast(createFixtureSamples(), {
      ...DEFAULT_PARAMETERS,
      name: 'raw-delays',
      temperatureDelaySec: 0,
      conductivityDelaySec: 0,
      thermalGain: 0
    });
    const corrected = correctCast(createFixtureSamples());

    expect(corrected.metrics.meanAbsoluteDifference).not.toBeNull();
    expect(unaligned.metrics.meanAbsoluteDifference).not.toBeNull();
    expect(corrected.metrics.meanAbsoluteDifference!).toBeLessThan(
      unaligned.metrics.meanAbsoluteDifference!
    );
  });
});

describe('nonphysical correction diagnostics', () => {
  it('preserves shifted intermediates when corrected salinity is nonphysical', () => {
    const samples: RawSample[] = Array.from({ length: 14 }, (_, elapsedSec) => {
      const pressureDbar = elapsedSec <= 6 ? 100 + elapsedSec * 40 : 340 - (elapsedSec - 6) * 40;
      const temperatureC = elapsedSec <= 6 ? 25 - elapsedSec * 10 : -35 + (elapsedSec - 7) * 10;
      return makeSample(elapsedSec, pressureDbar, temperatureC, 3.2);
    });
    const parameters: CorrectionParameters = {
      ...DEFAULT_PARAMETERS,
      waterStartSec: 0,
      waterEndSec: 6,
      temperatureDelaySec: 0,
      conductivityDelaySec: 0,
      thermalAlpha: 0.2,
      thermalTauSec: 1,
      thermalGain: 10
    };

    const result = correctCast(samples, parameters);
    const nonphysical = result.samples.filter((sample) => sample.status === 'nonphysical_salinity');

    expect(nonphysical.some((sample) => sample.phase === 'downcast')).toBe(true);
    expect(result.metrics.nonphysicalCount).toBeGreaterThan(0);
    expect(nonphysical[0]!.salinityPsu).toBeNull();
    expect(nonphysical[0]!.shiftedTemperatureC).not.toBeNull();
    expect(nonphysical[0]!.shiftedConductivitySM).not.toBeNull();
    expect(nonphysical[0]!.thermalConductivitySM).not.toBeNull();
    expect(nonphysical[0]!.diagnostics.join(' ')).toContain('retained shifted C');
  });
});

describe('PSS-78 salinity', () => {
  it('returns approximately 35 PSU for standard seawater at 15 C and surface pressure', () => {
    expect(practicalSalinity(42.914, 15, 0)).toBeCloseTo(35, 5);
  });
});

function makeSample(elapsedSec: number, pressureDbar: number, temperatureC: number, conductivitySM: number): RawSample {
  return {
    id: elapsedSec + 1,
    castId: 1,
    elapsedSec,
    timeIso: new Date(Date.UTC(2026, 4, 18) + elapsedSec * 1000).toISOString(),
    pressureDbar,
    temperatureC,
    conductivitySM,
    pumpOn: true,
    sensorOk: true,
    note: null
  };
}
