export type PhaseName = 'boat' | 'downcast' | 'bottom_dwell' | 'upcast';

export interface RawSample {
  id: number;
  castId: number;
  elapsedSec: number;
  timeIso: string;
  pressureDbar: number;
  temperatureC: number;
  conductivitySM: number;
  pumpOn: boolean;
  sensorOk: boolean;
  note: string | null;
}

export interface SegmentedSample extends RawSample {
  phase: PhaseName;
}

export interface CastSegment {
  phase: PhaseName;
  startIndex: number;
  endIndex: number;
  startSec: number;
  endSec: number;
  count: number;
}

export interface CorrectionParameters {
  name: string;
  temperatureDelaySec: number;
  conductivityDelaySec: number;
  thermalAlpha: number;
  thermalTauSec: number;
  thermalGain: number;
  waterStartSec: number;
  waterEndSec: number;
  excludePumpOff: boolean;
}

export type CorrectionStatus =
  | 'valid'
  | 'outside_water_window'
  | 'pump_off'
  | 'acquisition_break'
  | 'alignment_guard'
  | 'nonphysical_salinity';

export interface CorrectedSample extends SegmentedSample {
  selected: boolean;
  validRunId: number | null;
  shiftedTemperatureC: number | null;
  shiftedConductivitySM: number | null;
  filteredTemperatureC: number | null;
  thermalConductivitySM: number | null;
  correctedConductivitySM: number | null;
  rawSalinityPsu: number | null;
  salinityPsu: number | null;
  status: CorrectionStatus;
  diagnostics: string[];
}

export interface NumericSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
}

export interface RawChannelSummary {
  selectedCount: number;
  excludedPumpOff: number;
  excludedOutsideWindow: number;
  pressure: NumericSummary | null;
  temperature: NumericSummary | null;
  conductivity: NumericSummary | null;
  rawSalinity: NumericSummary | null;
}

export interface PressureLayerComparison {
  pressureDbar: number;
  downcastCount: number;
  upcastCount: number;
  downcastSalinity: number | null;
  upcastSalinity: number | null;
  upMinusDown: number | null;
  absoluteDifference: number | null;
}

export interface CorrectionMetrics {
  commonLayerCount: number;
  meanAbsoluteDifference: number | null;
  rmseDifference: number | null;
  nonphysicalCount: number;
  alignmentGuardCount: number;
}

export interface CorrectionResult {
  parameters: CorrectionParameters;
  samples: CorrectedSample[];
  segments: CastSegment[];
  validRuns: Array<{ id: number; startSec: number; endSec: number; count: number }>;
  rawSummary: RawChannelSummary;
  layers: PressureLayerComparison[];
  metrics: CorrectionMetrics;
}
