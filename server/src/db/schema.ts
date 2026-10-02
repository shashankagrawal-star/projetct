import type { TargetField, TargetSchema } from '../domain/types.js';
import { type Db } from './connection.js';

export const targetTable = (schema: TargetSchema) => `target_${schema.name}`;

const sqlType = (f: TargetField) => (f.type === 'integer' || f.type === 'boolean' ? 'INTEGER' : 'TEXT');
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The mock target store's DDL is generated from target-schema.json so there is one source of truth.
 * The store enforces NOT NULL / UNIQUE / enum / length / boolean CHECKs itself: a second line of
 * defence behind the pipeline's own validation.
 */
export function targetDdl(schema: TargetSchema): string {
  const cols = schema.fields.map((f) => {
    const parts = [`"${f.name}" ${sqlType(f)}`];
    if (f.name === schema.primaryKey) parts.push('PRIMARY KEY');
    if (f.required) parts.push('NOT NULL');
    if (f.unique && f.name !== schema.primaryKey) parts.push('UNIQUE');
    if (f.enum) parts.push(`CHECK ("${f.name}" IN (${f.enum.map(q).join(', ')}))`);
    if (f.type === 'boolean') parts.push(`CHECK ("${f.name}" IN (0, 1))`);
    if (f.maxLength) parts.push(`CHECK ("${f.name}" IS NULL OR length("${f.name}") <= ${f.maxLength})`);
    return parts.join(' ');
  });
  cols.push('"source_key" TEXT UNIQUE', '"execution_id" INTEGER', '"migrated_at" TEXT', '"content_hash" TEXT');
  return `CREATE TABLE IF NOT EXISTS ${targetTable(schema)} (\n  ${cols.join(',\n  ')}\n);\nCREATE INDEX IF NOT EXISTS idx_${targetTable(schema)}_exec ON ${targetTable(schema)}(execution_id);`;
}

const APP_DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS source_records (
  seq INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  parent_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('proposed','draft','approved','rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('agent','user')),
  mapping TEXT NOT NULL,
  mapping_hash TEXT NOT NULL,
  analysis TEXT,
  note TEXT,
  agent_run_id INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clarifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qid TEXT NOT NULL UNIQUE,
  raised_in_version INTEGER NOT NULL,
  field TEXT,
  question TEXT NOT NULL,
  options TEXT,
  proposed_assumption TEXT,
  blocking INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','answered','dismissed')),
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('propose','revise')),
  mode TEXT NOT NULL CHECK (mode IN ('llm','heuristic')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  instructions TEXT,
  base_version INTEGER,
  result_version INTEGER,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  payload TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, seq);

CREATE TABLE IF NOT EXISTS dry_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_version INTEGER NOT NULL,
  mapping_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  transform_hash TEXT NOT NULL,
  counts TEXT NOT NULL,
  breakdown TEXT NOT NULL,
  load_preview TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- per-record evidence for both dry runs and executions
CREATE TABLE IF NOT EXISTS run_records (
  run_kind TEXT NOT NULL CHECK (run_kind IN ('dry_run','execution')),
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected','pending','loaded','skipped_existing')),
  source TEXT NOT NULL,
  transformed TEXT NOT NULL,
  errors TEXT NOT NULL,
  PRIMARY KEY (run_kind, run_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_run_records_status ON run_records(run_kind, run_id, status, seq);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_version INTEGER NOT NULL,
  mapping_hash TEXT NOT NULL,
  dry_run_id INTEGER,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  actor TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_version INTEGER NOT NULL,
  dry_run_id INTEGER NOT NULL,
  approval_id INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running','failed','completed','rolled_back')),
  mapping_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  transform_hash TEXT NOT NULL,
  baseline_target_rows INTEGER NOT NULL,
  counts TEXT NOT NULL,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES executions(id),
  attempt_no INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('initial','retry')),
  status TEXT NOT NULL CHECK (status IN ('running','failed','completed')),
  inserted INTEGER NOT NULL DEFAULT 0,
  duplicates_prevented INTEGER NOT NULL DEFAULT 0,
  load_rejected INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (execution_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS rollbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES executions(id),
  reason TEXT NOT NULL,
  rows_removed INTEGER NOT NULL,
  target_rows_after INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- append-only history of everything that matters
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- plan versions are immutable except for their review status
CREATE TRIGGER IF NOT EXISTS plan_versions_immutable BEFORE UPDATE OF mapping, mapping_hash, analysis, version, origin, parent_version ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan versions are immutable; create a new version instead'); END;
`;

export function migrate(db: Db, target: TargetSchema): void {
  db.exec(APP_DDL);
  db.exec(targetDdl(target));
}
