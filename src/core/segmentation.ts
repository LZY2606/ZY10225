import type { CastSegment, PhaseName, RawSample, SegmentedSample } from './types.js';

export const SURFACE_DBAR = 1;

export function segmentCast(samples: readonly RawSample[]): {
  samples: SegmentedSample[];
  segments: CastSegment[];
} {
  const ordered = [...samples].sort((a, b) => a.elapsedSec - b.elapsedSec);
  const firstInWater = ordered.findIndex((sample) => sample.pressureDbar >= SURFACE_DBAR);
  let descentStart = firstInWater === -1 ? ordered.length : firstInWater;
  let bottomStart = ordered.length;
  let ascentStart = ordered.length;
  let finalSurface = ordered.length;

  if (firstInWater !== -1) {
    const lastInWater = ordered.findLastIndex((sample) => sample.pressureDbar >= SURFACE_DBAR);
    const maximumPressure = Math.max(...ordered.map((sample) => sample.pressureDbar));
    bottomStart = ordered.findIndex(
      (sample) => sample.pressureDbar >= maximumPressure * 0.985
    );
    for (let index = descentStart + 1; index <= lastInWater; index += 1) {
      const current = ordered[index];
      const previous = ordered[index - 1];
      if (!current || !previous) continue;
      const sustained =
        current.pressureDbar < previous.pressureDbar - 25 &&
        current.pressureDbar >= maximumPressure * 0.9 &&
        ordered.slice(index, Math.min(index + 8, ordered.length)).every((later) =>
          later.pressureDbar <= previous.pressureDbar + 20
        );
      if (sustained) {
        ascentStart = index;
        break;
      }
    }
    if (ascentStart === ordered.length) {
      ascentStart = Math.max(descentStart + 1, Math.floor((descentStart + lastInWater) / 2));
    }
    bottomStart = Math.max(descentStart, Math.min(bottomStart, ascentStart - 1));
    for (let index = ascentStart; index < ordered.length; index += 1) {
      if (ordered[index]!.pressureDbar < SURFACE_DBAR) {
        finalSurface = index;
        break;
      }
    }
  }

  const bounds: Array<{ phase: PhaseName; start: number }> = [
    { phase: 'boat', start: 0 },
    { phase: 'downcast', start: descentStart },
    { phase: 'bottom_dwell', start: bottomStart },
    { phase: 'upcast', start: ascentStart }
  ];

  const segmented = ordered.map((sample, index) => {
    let phase: PhaseName = 'boat';
    for (const bound of bounds) {
      if (index >= bound.start) phase = bound.phase;
    }
    if (index >= finalSurface) phase = 'boat';
    return { ...sample, phase };
  });

  const rawSegments: Array<[PhaseName, number, number]> = [
    ['boat', 0, descentStart],
    ['downcast', descentStart, bottomStart],
    ['bottom_dwell', bottomStart, ascentStart],
    ['upcast', ascentStart, finalSurface],
    ['boat', finalSurface, ordered.length]
  ];
  const segments = rawSegments
    .filter(([, start, end]) => end > start)
    .map(([phase, start, end]) => {
      const first = segmented[start]!;
      const last = segmented[end - 1]!;
      return {
        phase,
        startIndex: start,
        endIndex: end,
        startSec: first.elapsedSec,
        endSec: last.elapsedSec,
        count: end - start
      };
    });
  return { samples: segmented, segments };
}
