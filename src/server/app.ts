import express from 'express';
import { CastDatabase } from './db.js';
import { correctCast, DEFAULT_PARAMETERS } from '../core/correction.js';
import type { CorrectionParameters } from '../core/types.js';

export function createApiServer(database?: CastDatabase): express.Express {
  const app = express();
  const db = database ?? new CastDatabase();
  app.locals.db = db;
  app.use(express.json({ limit: '2mb' }));

  app.post('/api/reset', (req, res) => {
    db.resetToFixture();
    db.addLog(null, 'reset', { action: 'database cleared and deterministic fixture reimported' });
    res.json({ ok: true, samples: db.getSamples().length, scenarios: db.listScenarios() });
  });

  app.post('/api/import', (req, res) => {
    db.ensureSeeded();
    res.json({ ok: true, samples: db.getSamples().length });
  });

  app.get('/api/cast', (req, res) => {
    db.ensureSeeded();
    res.json({ castId: 1, name: 'CTD-FIX-001', samples: db.getSamples(), segments: correctCast(db.getSamples()).segments });
  });

  app.get('/api/scenarios', (req, res) => {
    db.ensureSeeded();
    res.json(db.listScenarios());
  });

  app.post('/api/scenarios', (req, res) => {
    db.ensureSeeded();
    const body = req.body as Partial<CorrectionParameters>;
    const parameters = normalizeParameters(body);
    const result = correctCast(db.getSamples(), parameters);
    const record = db.createScenarioWithResult(parameters, result, 'scheme generated from operator page');
    res.status(201).json({ scenario: record, result });
  });

  app.post('/api/preview', (req, res) => {
    db.ensureSeeded();
    const parameters = normalizeParameters((req.body ?? {}) as Partial<CorrectionParameters>);
    res.json(correctCast(db.getSamples(), parameters));
  });

  app.get('/api/logs', (req, res) => {
    res.json(db.listLogs(Number(req.query.limit ?? 200)));
  });

  app.get('/api/logs/export', (req, res) => {
    const logs = db.listLogs(10000);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="ctd-operation-logs.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), logs }, null, 2));
  });

  return app;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeParameters(input: Partial<CorrectionParameters>): CorrectionParameters {
  const samplesCount = 270;
  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.slice(0, 80) : `scheme-${new Date().toISOString()}`,
    temperatureDelaySec: numberValue(input.temperatureDelaySec, DEFAULT_PARAMETERS.temperatureDelaySec, -10, 10),
    conductivityDelaySec: numberValue(input.conductivityDelaySec, DEFAULT_PARAMETERS.conductivityDelaySec, -10, 10),
    thermalAlpha: numberValue(input.thermalAlpha, DEFAULT_PARAMETERS.thermalAlpha, 0, 0.2),
    thermalTauSec: numberValue(input.thermalTauSec, DEFAULT_PARAMETERS.thermalTauSec, 1, 60),
    thermalGain: numberValue(input.thermalGain, DEFAULT_PARAMETERS.thermalGain, 0, 10),
    waterStartSec: numberValue(input.waterStartSec, DEFAULT_PARAMETERS.waterStartSec, 0, samplesCount),
    waterEndSec: numberValue(input.waterEndSec, DEFAULT_PARAMETERS.waterEndSec, 0, samplesCount),
    excludePumpOff: input.excludePumpOff !== false
  };
}
