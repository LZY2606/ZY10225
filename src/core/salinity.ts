const A = [0.008, -0.1692, 25.3851, 14.0941, -7.0261, 2.7081] as const;
const B = [0.0005, -0.0056, -0.0066, -0.0375, 0.0636, -0.00192] as const;
const C = [0.6766097, 0.0200564, 0.0001104259, -6.9698e-7, 1.0031e-9] as const;
const D = [0.03426, 0.0004464, 0.4215, -0.003107] as const;
const E = [0.000207, -6.37e-8, 3.989e-12] as const;

export function practicalSalinity(
  conductivitySM: number,
  temperatureC: number,
  pressureDbar: number
): number {
  const conductivityRatio = conductivitySM / 42.914;
  const t = temperatureC;
  const p = pressureDbar;
  const rtTemperature =
    C[0] + C[1] * t + C[2] * t * t + C[3] * t * t * t + C[4] * t ** 4;
  const pressureTerm =
    (p * (E[0] + E[1] * p + E[2] * p * p)) /
    (1 +
      D[0] * t +
      D[1] * t * t +
      D[2] * conductivityRatio +
      D[3] * t * conductivityRatio);
  const rt = conductivityRatio / (rtTemperature * (1 - pressureTerm));
  if (!Number.isFinite(rt) || rt <= 0) {
    return Number.NaN;
  }

  const r = Math.sqrt(rt);
  const salinityPoly =
    A[0] +
    A[1] * r +
    A[2] * rt +
    A[3] * r ** 3 +
    A[4] * rt * rt +
    A[5] * r ** 5;
  const temperatureDelta = ((t - 15) / (1 + 0.0162 * (t - 15))) *
    (B[0] +
      B[1] * r +
      B[2] * rt +
      B[3] * r ** 3 +
      B[4] * rt * rt +
      B[5] * r ** 5);
  return salinityPoly + temperatureDelta;
}

export function conductivityForSalinity(
  salinity: number,
  temperatureC: number,
  pressureDbar: number
): number {
  let low = 0.001;
  let high = 80;
  for (let i = 0; i < 60; i += 1) {
    const middle = (low + high) / 2;
    const estimated = practicalSalinity(middle, temperatureC, pressureDbar);
    if (Number.isNaN(estimated) || estimated < salinity) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

export function isPhysicalSalinity(
  salinity: number,
  temperatureC: number,
  conductivitySM: number
): boolean {
  return (
    Number.isFinite(salinity) &&
    salinity >= 0 &&
    salinity <= 50 &&
    conductivitySM > 0 &&
    temperatureC >= -5 &&
    temperatureC <= 45
  );
}
