import { all, get, run, type Db, type Param } from '../db/connection.js';
import { targetTable } from '../db/schema.js';
import { hashOf } from '../domain/hash.js';
import type { Scalar, TargetSchema } from '../domain/types.js';

/** All access to the mock target store goes through this module. */

export interface SystemColumns {
  sourceKey: string | null;
  executionId: number | null;
  migratedAt: string | null;
}

const toParam = (v: Scalar | undefined): Param => (v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function insertTargetRow(db: Db, target: TargetSchema, row: Record<string, Scalar>, sys: SystemColumns): { inserted: boolean } {
  const cols = target.fields.map((f) => `"${f.name}"`);
  const values: Param[] = target.fields.map((f) => toParam(row[f.name]));
  cols.push('"source_key"', '"execution_id"', '"migrated_at"', '"content_hash"');
  values.push(sys.sourceKey, sys.executionId, sys.migratedAt, hashOf(row));
  const res = run(db, `INSERT INTO ${targetTable(target)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(source_key) DO NOTHING`, values);
  return { inserted: res.changes === 1 };
}

export function countTarget(db: Db, target: TargetSchema, where = '1=1', params: Param[] = []): number {
  return get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${targetTable(target)} WHERE ${where}`, params)!.n;
}

export type LoadDecision =
  | { kind: 'insert' }
  | { kind: 'exists'; existingId: string; executionId: number | null }
  | { kind: 'conflict'; field: string; value: string; existingId: string };

/**
 * Decides what the store would do with an accepted record, based on current store state:
 *  - a row with the same source_key already exists  → idempotent skip (never a second insert)
 *  - a row owned by something else holds a unique value → conflict (quarantine)
 *  - otherwise insert
 */
export function decideLoad(db: Db, target: TargetSchema, sourceKey: string, row: Record<string, Scalar>): LoadDecision {
  const table = targetTable(target);
  const same = get<{ id: string; execution_id: number | null }>(db, `SELECT "${target.primaryKey}" AS id, execution_id FROM ${table} WHERE source_key = ?`, [sourceKey]);
  if (same) return { kind: 'exists', existingId: same.id, executionId: same.execution_id };
  for (const f of target.fields.filter((x) => x.unique)) {
    const value = row[f.name];
    if (value === null || value === undefined) continue;
    const hit = get<{ id: string }>(db, `SELECT "${target.primaryKey}" AS id FROM ${table} WHERE "${f.name}" = ?`, [toParam(value)]);
    if (hit) return { kind: 'conflict', field: f.name, value: String(value), existingId: hit.id };
  }
  return { kind: 'insert' };
}

export function deleteByExecution(db: Db, target: TargetSchema, executionId: number): number {
  return run(db, `DELETE FROM ${targetTable(target)} WHERE execution_id = ?`, [executionId]).changes;
}

export function listTarget(db: Db, target: TargetSchema, opts: { limit: number; offset: number; origin?: 'seed' | 'migrated' | 'all'; executionId?: number }) {
  const where: string[] = [];
  const params: Param[] = [];
  if (opts.origin === 'seed') where.push('execution_id IS NULL');
  if (opts.origin === 'migrated') where.push('execution_id IS NOT NULL');
  if (opts.executionId !== undefined) {
    where.push('execution_id = ?');
    params.push(opts.executionId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${targetTable(target)} ${clause}`, params)!.n;
  const rows = all<Record<string, unknown>>(db, `SELECT * FROM ${targetTable(target)} ${clause} ORDER BY rowid LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset]);
  const boolFields = new Set(target.fields.filter((f) => f.type === 'boolean').map((f) => f.name));
  return {
    total,
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, boolFields.has(k) && v !== null ? v === 1 : v]))),
  };
}

export function sumColumn(db: Db, target: TargetSchema, column: string, where: string, params: Param[]): number {
  return get<{ s: number | null }>(db, `SELECT SUM("${column}") AS s FROM ${targetTable(target)} WHERE ${where}`, params)?.s ?? 0;
}
