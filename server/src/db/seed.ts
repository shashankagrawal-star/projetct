import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import type { SourceRecord, SourceSchema, TargetSchema } from '../domain/types.js';
import { get, run, transaction } from './connection.js';
import { targetTable } from './schema.js';
import { insertTargetRow } from '../services/targetStore.js';

const readJson = <T>(dir: string, name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

export function loadSchemas(dataDir: string): { source: SourceSchema; target: TargetSchema } {
  return { source: readJson<SourceSchema>(dataDir, 'source-schema.json'), target: readJson<TargetSchema>(dataDir, 'target-schema.json') };
}

/**
 * Idempotent: loads the bounded sample and the pre-existing target rows only into empty tables.
 * Enforces the documented maximum sample size.
 */
export function seed(ctx: AppContext): void {
  const { db, config, source, target } = ctx;
  const records = readJson<SourceRecord[]>(config.dataDir, 'sample-source-records.json');
  if (records.length > config.maxSampleSize) {
    throw new Error(`Sample has ${records.length} records, above the documented MAX_SAMPLE_SIZE of ${config.maxSampleSize}`);
  }
  const keys = new Set<string>();
  for (const r of records) {
    const key = r[source.primaryKey];
    if (typeof key !== 'string' || key === '') throw new Error(`Source record without primary key '${source.primaryKey}'`);
    if (keys.has(key)) throw new Error(`Duplicate source primary key ${key}`);
    keys.add(key);
  }

  transaction(db, () => {
    const existing = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM source_records')!.n;
    if (existing === 0) {
      records.forEach((r, i) => run(db, 'INSERT INTO source_records (seq, source_key, payload) VALUES (?, ?, ?)', [i + 1, r[source.primaryKey] as string, JSON.stringify(r)]));
    }
    const targetRows = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${targetTable(target)}`)!.n;
    const everExecuted = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM executions')!.n;
    if (targetRows === 0 && everExecuted === 0) {
      const rows = readJson<Array<Record<string, string | number | boolean | null>>>(config.dataDir, 'target-seed.json');
      for (const row of rows) insertTargetRow(db, target, row, { sourceKey: null, executionId: null, migratedAt: null });
    }
  });
}
