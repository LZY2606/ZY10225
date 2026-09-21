import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApiServer } from './app.js';
import { CastDatabase } from './db.js';
import { DEFAULT_PARAMETERS } from '../core/correction.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const database = new CastDatabase(':memory:');
  const app = createApiServer(database);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

describe('SQLite API replay', () => {
  it('seeds fixed fixture and resets to a reproducible database', async () => {
    const cast = await request<{ samples: unknown[] }>('/api/cast');
    expect(cast.samples.length).toBe(258);

    await request('/api/scenarios', {
      method: 'POST',
      body: JSON.stringify({ ...DEFAULT_PARAMETERS, name: 'review-a' })
    });
    await request('/api/scenarios', {
      method: 'POST',
      body: JSON.stringify({ ...DEFAULT_PARAMETERS, temperatureDelaySec: 2.5, name: 'review-b' })
    });
    let scenarios = await request<Array<{ generationOrder: number }>>('/api/scenarios');
    expect(scenarios.map((scenario) => scenario.generationOrder)).toEqual([1, 2, 3]);

    const reset = await request<{ samples: number; scenarios: Array<{ generationOrder: number }> }>('/api/reset', {
      method: 'POST',
      body: '{}'
    });
    expect(reset.samples).toBe(258);
    expect(reset.scenarios.map((scenario) => scenario.generationOrder)).toEqual([1]);

    scenarios = await request<Array<{ generationOrder: number }>>('/api/scenarios');
    expect(scenarios).toHaveLength(1);
  });

  it('exports operation logs including import, generation and reset', async () => {
    const exportResponse = await fetch(`${baseUrl}/api/logs/export`);
    expect(exportResponse.headers.get('content-type')).toContain('application/json');
    const payload = await exportResponse.json() as {
      logs: Array<{ action: string; detailJson: unknown }>;
    };
    expect(payload.logs.some((log) => log.action === 'import')).toBe(true);
    expect(payload.logs.some((log) => log.action === 'reset')).toBe(true);
  });
});
