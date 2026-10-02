import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Db = DatabaseSync;
export type Param = string | number | bigint | null;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return db;
}

const norm = (params: readonly (Param | boolean | undefined)[]): SQLInputValue[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

export function run(db: Db, sql: string, params: readonly (Param | boolean | undefined)[] = []): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...norm(params));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function get<T>(db: Db, sql: string, params: readonly (Param | boolean | undefined)[] = []): T | undefined {
  return db.prepare(sql).get(...norm(params)) as T | undefined;
}

export function all<T>(db: Db, sql: string, params: readonly (Param | boolean | undefined)[] = []): T[] {
  return db.prepare(sql).all(...norm(params)) as T[];
}

const depth = new WeakMap<Db, number>();

/** Transaction with savepoint nesting. Rolls back on any throw and rethrows. */
export function transaction<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const name = `sp_${d}`;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth.set(db, d + 1);
  try {
    const result = fn();
    depth.set(db, d);
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    depth.set(db, d);
    db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  }
}

export const json = (v: unknown): string => JSON.stringify(v ?? null);
export const parse = <T>(s: unknown): T => JSON.parse(String(s)) as T;
