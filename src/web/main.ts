import type { CorrectionParameters, CorrectionResult, CorrectedSample } from '../core/types.js';

type AxisMode = 'time' | 'pressure';
type ChannelKey = 'temperature' | 'conductivity' | 'salinity' | 'pressure';

interface ScenarioRecord {
  id: number;
  generationOrder: number;
  name: string;
  parametersJson: CorrectionParameters;
  createdAtIso: string;
  metricsJson: CorrectionResult['metrics'];
  rawSummaryJson: CorrectionResult['rawSummary'];
  validRunCount: number;
}

const elements = {
  scenarioName: document.querySelector<HTMLInputElement>('#scenarioName')!,
  delaySensor: document.querySelector<HTMLSelectElement>('#delaySensor')!,
  delayValue: document.querySelector<HTMLInputElement>('#delayValue')!,
  delayOutput: document.querySelector<HTMLOutputElement>('#delayOutput')!,
  temperatureDelayOutput: document.querySelector<HTMLOutputElement>('#temperatureDelayOutput')!,
  conductivityDelayOutput: document.querySelector<HTMLOutputElement>('#conductivityDelayOutput')!,
  waterStart: document.querySelector<HTMLInputElement>('#waterStart')!,
  waterEnd: document.querySelector<HTMLInputElement>('#waterEnd')!,
  excludePumpOff: document.querySelector<HTMLInputElement>('#excludePumpOff')!,
  thermalAlpha: document.querySelector<HTMLInputElement>('#thermalAlpha')!,
  thermalTauSec: document.querySelector<HTMLInputElement>('#thermalTauSec')!,
  thermalGain: document.querySelector<HTMLInputElement>('#thermalGain')!,
  preview: document.querySelector<HTMLButtonElement>('#preview')!,
  saveScenario: document.querySelector<HTMLButtonElement>('#saveScenario')!,
  resetDb: document.querySelector<HTMLButtonElement>('#resetDb')!,
  statusMessage: document.querySelector<HTMLParagraphElement>('#statusMessage')!,
  channelSelect: document.querySelector<HTMLSelectElement>('#channelSelect')!,
  chart: document.querySelector<HTMLCanvasElement>('#castChart')!,
  tooltip: document.querySelector<HTMLDivElement>('#tooltip')!,
  runSummary: document.querySelector<HTMLSpanElement>('#runSummary')!,
  metrics: document.querySelector<HTMLDivElement>('#metrics')!,
  layerTable: document.querySelector<HTMLTableElement>('#layerTable')!,
  scenarioTable: document.querySelector<HTMLTableElement>('#scenarioTable')!,
  logs: document.querySelector<HTMLPreElement>('#logs')!
};

let axisMode: AxisMode = 'time';
let result: CorrectionResult | null = null;
let chartPoints: Array<{ sample: CorrectedSample; x: number; yRaw: number | null; yCorrected: number | null }> = [];

const defaults: CorrectionParameters = {
  name: 'operator-review',
  temperatureDelaySec: 4,
  conductivityDelaySec: 3,
  thermalAlpha: 0.03,
  thermalTauSec: 8,
  thermalGain: 1,
  waterStartSec: 30,
  waterEndSec: 240,
  excludePumpOff: true
};

function readParameters(): CorrectionParameters {
  const parameters: CorrectionParameters = {
    ...defaults,
    name: elements.scenarioName.value || 'operator-review',
    waterStartSec: Number(elements.waterStart.value),
    waterEndSec: Number(elements.waterEnd.value),
    excludePumpOff: elements.excludePumpOff.checked,
    thermalAlpha: Number(elements.thermalAlpha.value),
    thermalTauSec: Number(elements.thermalTauSec.value),
    thermalGain: Number(elements.thermalGain.value)
  };
  const selectedDelay = Number(elements.delayValue.value);
  if (elements.delaySensor.value === 'temperatureDelaySec') {
    parameters.temperatureDelaySec = selectedDelay;
    parameters.conductivityDelaySec = Number(elements.conductivityDelayOutput.dataset.value ?? 3);
  } else {
    parameters.conductivityDelaySec = selectedDelay;
    parameters.temperatureDelaySec = Number(elements.temperatureDelayOutput.dataset.value ?? 4);
  }
  if (parameters.waterEndSec <= parameters.waterStartSec) {
    parameters.waterEndSec = parameters.waterStartSec + 1;
  }
  return parameters;
}

function syncDelayControls(): void {
  const temperatureDelay = elements.delaySensor.value === 'temperatureDelaySec'
    ? Number(elements.delayValue.value)
    : Number(elements.temperatureDelayOutput.dataset.value ?? 4);
  const conductivityDelay = elements.delaySensor.value === 'conductivityDelaySec'
    ? Number(elements.delayValue.value)
    : Number(elements.conductivityDelayOutput.dataset.value ?? 3);
  elements.delayOutput.textContent = `${elements.delayValue.value} s`;
  elements.temperatureDelayOutput.textContent = `${temperatureDelay.toFixed(1)} s`;
  elements.temperatureDelayOutput.dataset.value = String(temperatureDelay);
  elements.conductivityDelayOutput.textContent = `${conductivityDelay.toFixed(1)} s`;
  elements.conductivityDelayOutput.dataset.value = String(conductivityDelay);
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

async function refreshPreview(message?: string): Promise<void> {
  const parameters = readParameters();
  result = await postJson<CorrectionResult>('/api/preview', parameters);
  render();
  elements.statusMessage.textContent = message ?? `已预览：${result.validRuns.length} 个受保护连续段`;
}

async function saveScenario(): Promise<void> {
  const payload = await postJson<{ scenario: ScenarioRecord; result: CorrectionResult }>(
    '/api/scenarios',
    readParameters()
  );
  result = payload.result;
  render();
  await loadHistory();
  elements.statusMessage.textContent = `已保存为第 ${payload.scenario.generationOrder} 个方案`;
}

async function resetDatabase(): Promise<void> {
  await postJson('/api/reset', {});
  elements.scenarioName.value = 'operator-review';
  Object.assign(defaults, {
    temperatureDelaySec: 4,
    conductivityDelaySec: 3,
    thermalAlpha: 0.03,
    thermalTauSec: 8,
    thermalGain: 1,
    waterStartSec: 30,
    waterEndSec: 240
  });
  elements.delaySensor.value = 'temperatureDelaySec';
  elements.delayValue.value = '4';
  elements.temperatureDelayOutput.dataset.value = '4';
  elements.conductivityDelayOutput.dataset.value = '3';
  elements.waterStart.value = '30';
  elements.waterEnd.value = '240';
  elements.excludePumpOff.checked = true;
  elements.thermalAlpha.value = '0.03';
  elements.thermalTauSec.value = '8';
  elements.thermalGain.value = '1';
  syncDelayControls();
  await refreshPreview('数据库已清空，固定 fixture 已重新导入');
  await loadHistory();
}

function getRawValue(sample: CorrectedSample, channel: ChannelKey): number | null {
  if (channel === 'pressure') return sample.pressureDbar;
  if (channel === 'temperature') return sample.temperatureC;
  if (channel === 'conductivity') return sample.conductivitySM;
  return sample.rawSalinityPsu;
}

function getCorrectedValue(sample: CorrectedSample, channel: ChannelKey): number | null {
  if (!sample.selected) return null;
  if (channel === 'pressure') return sample.pressureDbar;
  if (channel === 'temperature') return sample.shiftedTemperatureC;
  if (channel === 'conductivity') return sample.correctedConductivitySM;
  return sample.salinityPsu;
}

function drawChart(): void {
  if (!result) return;
  const canvas = elements.chart;
  const context = canvas.getContext('2d')!;
  const width = canvas.width;
  const height = canvas.height;
  const margin = { left: 72, right: 28, top: 32, bottom: 58 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const channel = elements.channelSelect.value as ChannelKey;
  const samples = result.samples;
  const xValue = (sample: CorrectedSample): number =>
    axisMode === 'time' ? sample.elapsedSec : sample.pressureDbar;
  const rawValues = samples.map((sample) => getRawValue(sample, channel));
  const correctedValues = samples.map((sample) => getCorrectedValue(sample, channel));
  const values = [...rawValues, ...correctedValues].filter((value): value is number => value !== null);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const xMin = Math.min(...samples.map(xValue));
  const xMax = Math.max(...samples.map(xValue));
  const scaleX = (value: number): number =>
    margin.left + ((value - xMin) / Math.max(0.0001, xMax - xMin)) * innerWidth;
  const scaleY = (value: number): number =>
    margin.top + innerHeight - ((value - minValue) / Math.max(0.0001, maxValue - minValue)) * innerHeight;

  context.clearRect(0, 0, width, height);
  context.fillStyle = '#071520';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#173446';
  context.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = margin.top + (innerHeight * i) / 5;
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(width - margin.right, y);
    context.stroke();
    const value = maxValue - ((maxValue - minValue) * i) / 5;
    context.fillStyle = '#91aab7';
    context.font = '12px sans-serif';
    context.fillText(value.toFixed(2), 12, y + 4);
  }
  for (let i = 0; i <= 6; i += 1) {
    const x = margin.left + (innerWidth * i) / 6;
    const value = xMin + ((xMax - xMin) * i) / 6;
    context.strokeStyle = '#102a3a';
    context.beginPath();
    context.moveTo(x, margin.top);
    context.lineTo(x, height - margin.bottom);
    context.stroke();
    context.fillStyle = '#91aab7';
    context.fillText(value.toFixed(axisMode === 'time' ? 0 : 1), x - 18, height - 24);
  }

  const waterLeft = scaleX(axisMode === 'time' ? result.parameters.waterStartSec : 0);
  const waterRight = scaleX(axisMode === 'time' ? result.parameters.waterEndSec : xMax);
  context.fillStyle = 'rgba(57,229,168,.055)';
  context.fillRect(waterLeft, margin.top, Math.max(0, waterRight - waterLeft), innerHeight);

  if (axisMode === 'time') {
    drawSeries(context, samples, scaleX, scaleY, xValue, (sample) => getRawValue(sample, channel), '#90a4ae', 1.6);
    drawSeries(context, samples, scaleX, scaleY, xValue, (sample) => getCorrectedValue(sample, channel), '#39e5a8', 2.2, true);
  } else {
    drawSeries(context, samples, scaleX, scaleY, xValue, (sample) => getRawValue(sample, channel), '#42a5f5', 1.7, false, 'downcast');
    drawSeries(context, samples, scaleX, scaleY, xValue, (sample) => getRawValue(sample, channel), '#ffb74d', 1.7, false, 'upcast');
    drawSeries(context, samples, scaleX, scaleY, xValue, (sample) => getCorrectedValue(sample, channel), '#26c6da', 2.3, true, 'downcast');
    drawSeries(context, samples, scaleX, scaleY, xValue, (sample) => getCorrectedValue(sample, channel), '#39e5a8', 2.3, true, 'upcast');
  }

  for (const segment of result.segments) {
    const phaseSamples = samples.slice(segment.startIndex, segment.endIndex);
    if (phaseSamples.length === 0) continue;
    const color = segment.phase === 'downcast' ? 'rgba(66,165,245,.12)' : segment.phase === 'upcast' ? 'rgba(255,183,77,.10)' : 'rgba(150,170,180,.04)';
    const x1 = scaleX(xValue(phaseSamples[0]!));
    const x2 = scaleX(xValue(phaseSamples[phaseSamples.length - 1]!));
    context.fillStyle = color;
    context.fillRect(Math.min(x1, x2), margin.top, Math.abs(x2 - x1) + 2, innerHeight);
  }

  for (const sample of samples) {
    const diagnostic = !sample.pumpOn || !sample.sensorOk || sample.status === 'nonphysical_salinity' || sample.status === 'alignment_guard';
    if (!diagnostic) continue;
    context.fillStyle = sample.status === 'nonphysical_salinity' ? '#ff5252' : '#f9a825';
    context.beginPath();
    context.arc(scaleX(xValue(sample)), margin.top + 10, 3.2, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = '#d5e7ee';
  context.font = '14px sans-serif';
  context.fillText(axisMode === 'time' ? '时间（秒）' : '压力（dbar；保留上下行顺序分别绘制）', margin.left, height - 14);
  context.save();
  context.translate(18, margin.top + innerHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(elements.channelSelect.selectedOptions[0]?.textContent ?? '', -60, 0);
  context.restore();

  chartPoints = samples.map((sample) => ({
    sample,
    x: scaleX(xValue(sample)),
    yRaw: nullableScale(getRawValue(sample, channel), scaleY),
    yCorrected: nullableScale(getCorrectedValue(sample, channel), scaleY)
  }));
}

function nullableScale(value: number | null, scaleY: (value: number) => number): number | null {
  return value === null ? null : scaleY(value);
}

function drawSeries(
  context: CanvasRenderingContext2D,
  samples: CorrectedSample[],
  scaleX: (value: number) => number,
  scaleY: (value: number) => number,
  xValue: (sample: CorrectedSample) => number,
  yValue: (sample: CorrectedSample) => number | null,
  color: string,
  lineWidth: number,
  guardBreaks = false,
  phaseFilter?: CorrectedSample['phase']
): void {
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  let penDown = false;
  for (const sample of samples) {
    if (phaseFilter && sample.phase !== phaseFilter) {
      penDown = false;
      continue;
    }
    const value = yValue(sample);
    if (value === null || (guardBreaks && sample.validRunId === null)) {
      penDown = false;
      continue;
    }
    const x = scaleX(xValue(sample));
    const y = scaleY(value);
    if (!penDown) {
      context.moveTo(x, y);
      penDown = true;
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
}

function renderMetrics(): void {
  if (!result) return;
  const metrics = result.metrics;
  const summary = result.rawSummary;
  elements.runSummary.textContent = `注水样本 ${summary.selectedCount}，泵停排除 ${summary.excludedPumpOff}，非物理 ${metrics.nonphysicalCount}，边界保护 ${metrics.alignmentGuardCount}`;
  elements.metrics.innerHTML = `
    <div class="cards">
      <p><strong>共同压力层</strong>：${metrics.commonLayerCount}</p>
      <p><strong>平均绝对差</strong>：${metrics.meanAbsoluteDifference?.toFixed(5) ?? '—'} PSU</p>
      <p><strong>上下 RMSE</strong>：${metrics.rmseDifference?.toFixed(5) ?? '—'} PSU</p>
      <p><strong>非物理盐度</strong>：${metrics.nonphysicalCount}（保留中间量）</p>
    </div>
  `;
  elements.layerTable.innerHTML = `
    <thead><tr><th>压力层中值</th><th>下行 n</th><th>上行 n</th><th>下行盐度</th><th>上行盐度</th><th>上-下</th><th>绝对差</th></tr></thead>
    <tbody>${result.layers.map((layer) => `<tr>
      <td>${layer.pressureDbar.toFixed(0)} dbar</td>
      <td>${layer.downcastCount}</td>
      <td>${layer.upcastCount}</td>
      <td>${layer.downcastSalinity?.toFixed(5) ?? '—'}</td>
      <td>${layer.upcastSalinity?.toFixed(5) ?? '—'}</td>
      <td>${layer.upMinusDown?.toFixed(5) ?? '—'}</td>
      <td>${layer.absoluteDifference?.toFixed(5) ?? '—'}</td>
    </tr>`).join('')}</tbody>
  `;
}

function render(): void {
  drawChart();
  renderMetrics();
}

async function loadHistory(): Promise<void> {
  const scenarios = await fetch('/api/scenarios').then((response) => response.json() as Promise<ScenarioRecord[]>);
  const logs = await fetch('/api/logs').then((response) => response.json() as Promise<Array<{ id: number; action: string; createdAtIso: string; scenarioId: number | null; detailJson: unknown }>>);
  elements.scenarioTable.innerHTML = `
    <thead><tr><th>#</th><th>方案</th><th>T 延时</th><th>C 延时</th><th>alpha</th><th>tau</th><th>原始盐度均值</th><th>共同层 MAD</th><th>连续段</th><th>时间</th></tr></thead>
    <tbody>${scenarios.map((scenario) => {
      const parameters = scenario.parametersJson;
      return `<tr>
        <td>${scenario.generationOrder}</td>
        <td>${scenario.name}</td>
        <td>${parameters.temperatureDelaySec}</td>
        <td>${parameters.conductivityDelaySec}</td>
        <td>${parameters.thermalAlpha}</td>
        <td>${parameters.thermalTauSec}</td>
        <td>${scenario.rawSummaryJson.rawSalinity?.mean.toFixed(5) ?? '—'}</td>
        <td>${scenario.metricsJson.meanAbsoluteDifference?.toFixed(5) ?? '—'}</td>
        <td>${scenario.validRunCount}</td>
        <td>${new Date(scenario.createdAtIso).toLocaleString()}</td>
      </tr>`;
    }).join('')}</tbody>
  `;
  elements.logs.textContent = logs.map((log) => JSON.stringify({
    id: log.id,
    at: log.createdAtIso,
    scenarioId: log.scenarioId,
    action: log.action,
    detail: log.detailJson
  })).join('\n');
}

function showTooltip(event: MouseEvent): void {
  if (!result || chartPoints.length === 0) return;
  const bounds = elements.chart.getBoundingClientRect();
  const mouseX = ((event.clientX - bounds.left) / bounds.width) * elements.chart.width;
  let nearest = chartPoints[0]!;
  for (const point of chartPoints) {
    if (Math.abs(point.x - mouseX) < Math.abs(nearest.x - mouseX)) nearest = point;
  }
  const sample = nearest.sample;
  elements.tooltip.classList.remove('hidden');
  elements.tooltip.style.left = `${event.clientX + 14}px`;
  elements.tooltip.style.top = `${event.clientY + 14}px`;
  elements.tooltip.innerHTML = `
    <strong>${sample.phase}</strong> t=${sample.elapsedSec}s P=${sample.pressureDbar.toFixed(2)} dbar<br>
    pump=${sample.pumpOn ? 'on' : 'OFF'} sensor=${sample.sensorOk ? 'ok' : 'BAD'} status=${sample.status}<br>
    raw S=${sample.rawSalinityPsu?.toFixed(4) ?? '—'} corrected S=${sample.salinityPsu?.toFixed(4) ?? '—'}<br>
    ${sample.diagnostics.join('<br>')}
  `;
}

function wireEvents(): void {
  elements.delaySensor.addEventListener('change', () => {
    const key = elements.delaySensor.value as 'temperatureDelaySec' | 'conductivityDelaySec';
    elements.delayValue.value = key === 'temperatureDelaySec'
      ? elements.temperatureDelayOutput.dataset.value ?? '4'
      : elements.conductivityDelayOutput.dataset.value ?? '3';
    syncDelayControls();
  });
  elements.delayValue.addEventListener('input', () => syncDelayControls());
  elements.delayValue.addEventListener('change', () => void refreshPreview());
  elements.channelSelect.addEventListener('change', render);
  elements.waterStart.addEventListener('change', () => void refreshPreview());
  elements.waterEnd.addEventListener('change', () => void refreshPreview());
  elements.excludePumpOff.addEventListener('change', () => void refreshPreview());
  elements.thermalAlpha.addEventListener('change', () => void refreshPreview());
  elements.thermalTauSec.addEventListener('change', () => void refreshPreview());
  elements.thermalGain.addEventListener('change', () => void refreshPreview());
  elements.preview.addEventListener('click', () => void refreshPreview('手动预览完成'));
  elements.saveScenario.addEventListener('click', () => void saveScenario());
  elements.resetDb.addEventListener('click', () => void resetDatabase());
  elements.chart.addEventListener('mousemove', showTooltip);
  elements.chart.addEventListener('mouseleave', () => elements.tooltip.classList.add('hidden'));
  document.querySelectorAll<HTMLButtonElement>('.axis-option').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.axis-option').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      axisMode = button.dataset.axis as AxisMode;
      drawChart();
    });
  });
}

async function init(): Promise<void> {
  syncDelayControls();
  wireEvents();
  await refreshPreview('固定 fixture 已载入');
  await loadHistory();
}

void init();
