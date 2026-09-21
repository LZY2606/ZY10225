import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PARAMETERS, correctCast } from '../core/correction.js';
import { createFixtureSamples, FIXTURE_CAST_ID, FIXTURE_START_ISO } from '../core/fixture.js';
import type { CorrectionParameters, CorrectionResult, RawSample } from '../core/types.js';

export interface ScenarioRecord {
  id: number;
  generationOrder: number;
  name: string;
  parametersJson: CorrectionParameters;
  createdAtIso: string;
  metricsJson: CorrectionResult['metrics'];
  rawSummaryJson: CorrectionResult['rawSummary'];
  validRunCount: number;
}

export interface RunLogRecord {
  id: number;
  scenarioId: number | null;
  action: string;
  detailJson: unknown;
  createdAtIso: string;
}

const scenarioRowToRecord = (row: Record<string, unknown>): ScenarioRecord => ({
  id: Number(row.id),
  generationOrder: Number(row.generation_order),
  name: String(row.name),
  parametersJson: JSON.parse(String(row.parameters_json)) as CorrectionParameters,
  createdAtIso: String(row.created_at_iso),
  metricsJson: JSON.parse(String(row.metrics_json)) as CorrectionResult['metrics'],
  rawSummaryJson: JSON.parse(String(row.raw_summary_json)) as CorrectionResult['rawSummary'],
  validRunCount: Number(row.valid_run_count)
});

const logRowToRecord = (row: Record<string, unknown>): RunLogRecord => ({
  id: Number(row.id),
  scenarioId: row.scenario_id === null ? null : Number(row.scenario_id),
  action: String(row.action),
  detailJson: JSON.parse(String(row.detail_json)) as unknown,
  createdAtIso: String(row.created_at_iso)
});

export class CastDatabase {
  private readonly db: DatabaseSync;

  constructor(filename = process.env.CTD_DB_PATH ?? 'data/ctd.sqlite') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        started_at_iso TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY,
        cast_id INTEGER NOT NULL REFERENCES casts(id),
        elapsed_sec REAL NOT NULL,
        time_iso TEXT NOT NULL,
        pressure_dbar REAL NOT NULL,
        temperature_c REAL NOT NULL,
        conductivity_s_m REAL NOT NULL,
        pump_on INTEGER NOT NULL,
        sensor_ok INTEGER NOT NULL,
        note TEXT,
        UNIQUE(cast_id, elapsed_sec)
      );
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_order INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        raw_summary_json TEXT NOT NULL,
        valid_run_count INTEGER NOT NULL,
        created_at_iso TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at_iso TEXT NOT NULL
      );
    `);
  }

  resetToFixture(): void {
    this.db.exec('DELETE FROM run_logs; DELETE FROM scenarios; DELETE FROM samples; DELETE FROM casts;');
    this.importFixtureSamples('fixture reimport after reset');
  }

  ensureSeeded(): boolean {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM samples').get() as { count: number | bigint };
    if (Number(count.count) > 0) return false;
    this.importFixtureSamples('fixed fixture auto import');
    return true;
  }

  importFixtureSamples(action: string): void {
    const samples = createFixtureSamples();
    this.insertSamples('CTD-FIX-001', samples, action);
    if (this.listScenarios().length === 0) {
      this.createScenario(DEFAULT_PARAMETERS, 'default scheme generated during fixture import');
    }
  }

  insertSamples(name: string, samples: RawSample[], action: string): void {
    const insertCast = this.db.prepare('INSERT INTO casts(id, name, started_at_iso) VALUES (?, ?, ?)');
    insertCast.run(FIXTURE_CAST_ID, name, FIXTURE_START_ISO);
    const insertSample = this.db.prepare(`
      INSERT INTO samples(
        id, cast_id, elapsed_sec, time_iso, pressure_dbar, temperature_c,
        conductivity_s_m, pump_on, sensor_ok, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const sample of samples) {
      insertSample.run(
        sample.id,
        sample.castId,
        sample.elapsedSec,
        sample.timeIso,
        sample.pressureDbar,
        sample.temperatureC,
        sample.conductivitySM,
        sample.pumpOn ? 1 : 0,
        sample.sensorOk ? 1 : 0,
        sample.note
      );
    }
    this.addLog(null, 'import', { action, castId: FIXTURE_CAST_ID, sampleCount: samples.length });
  }

  getSamples(): RawSample[] {
    const rows = this.db.prepare('SELECT * FROM samples ORDER BY elapsed_sec').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      castId: Number(row.cast_id),
      elapsedSec: Number(row.elapsed_sec),
      timeIso: String(row.time_iso),
      pressureDbar: Number(row.pressure_dbar),
      temperatureC: Number(row.temperature_c),
      conductivitySM: Number(row.conductivity_s_m),
      pumpOn: Number(row.pump_on) === 1,
      sensorOk: Number(row.sensor_ok) === 1,
      note: row.note === null ? null : String(row.note)
    }));
  }

  createScenario(parameters: CorrectionParameters, action = 'scheme created'): ScenarioRecord {
    const result = correctCast(this.getSamples(), parameters);
    return this.createScenarioWithResult(parameters, result, action);
  }

  createScenarioWithResult(
    parameters: CorrectionParameters,
    result: CorrectionResult,
    action: string
  ): ScenarioRecord {
    const computed = result;
    const orderRow = this.db.prepare('SELECT COALESCE(MAX(generation_order), 0) + 1 AS next_order FROM scenarios').get() as {
      next_order: number | bigint;
    };
    const createdAt = new Date().toISOString();
    const info = this.db.prepare(`
      INSERT INTO scenarios(
        generation_order, name, parameters_json, metrics_json,
        raw_summary_json, valid_run_count, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(orderRow.next_order),
      parameters.name,
      JSON.stringify(parameters),
      JSON.stringify(computed.metrics),
      JSON.stringify(computed.rawSummary),
      computed.validRuns.length,
      createdAt
    );
    const scenario = this.getScenario(Number(info.lastInsertRowid));
    this.addLog(scenario.id, action, { parameters, metrics: computed.metrics });
    return scenario;
  }

  getScenario(id: number): ScenarioRecord {
    const row = this.db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`scenario ${id} not found`);
    return scenarioRowToRecord(row);
  }

  listScenarios(): ScenarioRecord[] {
    const rows = this.db.prepare('SELECT * FROM scenarios ORDER BY generation_order').all() as Array<Record<string, unknown>>;
    return rows.map(scenarioRowToRecord);
  }

  addLog(scenarioId: number | null, action: string, detail: unknown): void {
    this.db.prepare(`
      INSERT INTO run_logs(scenario_id, action, detail_json, created_at_iso)
      VALUES (?, ?, ?, ?)
    `).run(scenarioId, action, JSON.stringify(detail), new Date().toISOString());
  }

  listLogs(limit = 200): RunLogRecord[] {
    const rows = this.db.prepare('SELECT * FROM run_logs ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map(logRowToRecord);
  }

  close(): void {
    this.db.close();
  }
}
