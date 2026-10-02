import { all, get } from '../db/connection.js';
import { hashOf } from '../domain/hash.js';
import type { Db } from '../db/connection.js';
import type { SourceRow } from '../domain/pipeline.js';
import type { SourceRecord } from '../domain/types.js';

export function getSourceRows(db: Db): SourceRow[] {
  return all<{ source_key: string; payload: string }>(db, 'SELECT source_key, payload FROM source_records ORDER BY seq').map((r) => ({
    sourceKey: r.source_key,
    payload: JSON.parse(r.payload) as SourceRecord,
  }));
}

/** Computed live from the stored rows, so any change to the source data invalidates earlier dry runs and approvals. */
export function getSourceHash(db: Db): string {
  return hashOf(getSourceRows(db).map((r) => [r.sourceKey, r.payload]));
}

export function countSource(db: Db): number {
  return get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM source_records')!.n;
}

export function pageSource(db: Db, limit: number, offset: number, q?: string) {
  const like = q ? `%${q.replace(/[%_]/g, '')}%` : null;
  const where = like ? 'WHERE payload LIKE ?' : '';
  const params = like ? [like] : [];
  const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM source_records ${where}`, params)!.n;
  const rows = all<{ payload: string }>(db, `SELECT payload FROM source_records ${where} ORDER BY seq LIMIT ? OFFSET ?`, [...params, limit, offset]).map((r) => JSON.parse(r.payload) as SourceRecord);
  return { total, rows };
}
