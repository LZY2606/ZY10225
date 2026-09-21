import type { RawSample } from './types.js';
import { conductivityForSalinity } from './salinity.js';

export const FIXTURE_CAST_ID = 1;
export const FIXTURE_START_ISO = '2026-05-18T00:00:00.000Z';
export const DEFAULT_WATER_START_SEC = 30;
export const DEFAULT_WATER_END_SEC = 240;

function trueTemperature(pressureDbar: number): number {
  if (pressureDbar <= 150) {
    return 21 - (14 * pressureDbar) / 150;
  }
  if (pressureDbar <= 850) {
    return 7 - (5 * (pressureDbar - 150)) / 700;
  }
  return 2;
}

function trueSalinity(pressureDbar: number): number {
  return 34.9 - (0.35 * pressureDbar) / 1000;
}

function smooth(previous: number, target: number, tauSec: number, dtSec: number): number {
  return previous + (target - previous) * (1 - Math.exp(-dtSec / tauSec));
}

export function createFixtureSamples(): RawSample[] {
  const missingTimes = new Set([95, 96, 97, 98, 99, 100, 205, 206, 207, 208, 209, 210]);
  const samples: RawSample[] = [];
  let rawTemperature = 23.4;
  let rawConductivity = 0.02;
  let filteredTemperature = 23.4;
  let lastSeenTime = 0;

  for (let elapsedSec = 0; elapsedSec < 270; elapsedSec += 1) {
    if (missingTimes.has(elapsedSec)) {
      continue;
    }

    let pressure = 0;
    let note: string | null = null;
    if (elapsedSec >= 30 && elapsedSec < 120) {
      pressure = (1000 * (elapsedSec - 29)) / 90;
    } else if (elapsedSec >= 120 && elapsedSec < 150) {
      pressure = 1000;
    } else if (elapsedSec >= 150 && elapsedSec < 240) {
      pressure = (1000 * (239 - elapsedSec)) / 90;
    }
    if (elapsedSec === 81) pressure -= 15;
    if (elapsedSec === 191) pressure += 15;

    const inWater = elapsedSec >= 30 && elapsedSec < 240;
    const targetTemperature = inWater ? trueTemperature(pressure) : 23.4;
    const targetConductivity = inWater
      ? conductivityForSalinity(trueSalinity(pressure), targetTemperature, pressure)
      : 0.02;

    const dt = elapsedSec - lastSeenTime;
    rawTemperature = smooth(rawTemperature, targetTemperature, 4, dt);
    rawConductivity = smooth(rawConductivity, targetConductivity, 3, dt);
    filteredTemperature = smooth(filteredTemperature, rawTemperature, 8, dt);

    let temperature = rawTemperature;
    let conductivity = rawConductivity;
    if (inWater) {
      conductivity += 0.04 * 8 * 0.03 * (rawTemperature - filteredTemperature);
    }

    const pumpOn = (elapsedSec >= 12 && elapsedSec < 134) || (elapsedSec >= 147 && elapsedSec < 250);
    const sensorOk = elapsedSec !== 101 && elapsedSec !== 178 && elapsedSec !== 211;
    if (!pumpOn && elapsedSec < 30) note = 'deck flushing pump stopped';
    if (!pumpOn && elapsedSec >= 120 && elapsedSec < 150) note = 'pump closed near bottom';
    if (!pumpOn && elapsedSec >= 144) note = 'pump restart settling';
    if (elapsedSec === 101 || elapsedSec === 211) note = 'telemetry reacquired after gap';
    if (elapsedSec === 178) note = 'single invalid sensor frame';

    samples.push({
      id: samples.length + 1,
      castId: FIXTURE_CAST_ID,
      elapsedSec,
      timeIso: new Date(Date.parse(FIXTURE_START_ISO) + elapsedSec * 1000).toISOString(),
      pressureDbar: Number(pressure.toFixed(3)),
      temperatureC: Number(temperature.toFixed(5)),
      conductivitySM: Number(Math.max(0.001, conductivity).toFixed(6)),
      pumpOn,
      sensorOk,
      note
    });
    lastSeenTime = elapsedSec;
  }

  return samples;
}
