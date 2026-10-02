import type { AppContext } from '../context.js';
import { all, get, json, parse, run, transaction, type Param } from '../db/connection.js';
import { runPipeline, type PipelineResult } from '../domain/pipeline.js';
import type { FieldError, MappingSpec, RecordOutcome, RunCounts, SourceRecord, Scalar } from '../domain/types.js';
import { notFound } from '../errors.js';
import { audit } from './audit.js';
import { getPlan } from './plans.js';
import { getSourceHash, getSourceRows } from './sourceStore.js';
import { decideLoad } from './targetStore.js';

export interface LoadPreview {
  validated: number; // passed transform + validation + in-batch uniqueness
  wouldInsert: number;
  wouldSkipExisting: number; // already present in the target (same source key)
  wouldConflict: number; // unique value held by a different target row
  conflicts: Array<{ sourceKey: string; field: string; value: string; existingId: string }>;
}

export interface DryRunSummary {
  id: number;
  planVersion: number;
  mappingHash: string;
  sourceHash: string;
  transformHash: string;
  counts: RunCounts;
  breakdown: PipelineResult['breakdown'];
  loadPreview: LoadPreview;
  actor: string;
  createdAt: string;
}

interface DryRunRow {
  id: number;
  plan_version: number;
  mapping_hash: string;
  source_hash: string;
  transform_hash: string;
  counts: string;
  breakdown: string;
  load_preview: string;
  actor: string;
  created_at: string;
}

const fromRow = (r: DryRunRow): DryRunSummary => ({
  id: r.id,
  planVersion: r.plan_version,
  mappingHash: r.mapping_hash,
  sourceHash: r.source_hash,
  transformHash: r.transform_hash,
  counts: parse(r.counts),
  breakdown: parse(r.breakdown),
  loadPreview: parse(r.load_preview),
  actor: r.actor,
  createdAt: r.created_at,
});

export function getDryRun(ctx: AppContext, id: number): DryRunSummary {
  const row = get<DryRunRow>(ctx.db, 'SELECT * FROM dry_runs WHERE id = ?', [id]);
  if (!row) throw notFound(`Dry run ${id}`);
  return fromRow(row);
}

export function listDryRuns(ctx: AppContext, planVersion?: number): DryRunSummary[] {
  const rows = planVersion
    ? all<DryRunRow>(ctx.db, 'SELECT * FROM dry_runs WHERE plan_version = ? ORDER BY id DESC', [planVersion])
    : all<DryRunRow>(ctx.db, 'SELECT * FROM dry_runs ORDER BY id DESC');
  return rows.map(fromRow);
}

export function latestDryRun(ctx: AppContext, planVersion: number): DryRunSummary | null {
  const row = get<DryRunRow>(ctx.db, 'SELECT * FROM dry_runs WHERE plan_version = ? ORDER BY id DESC LIMIT 1', [planVersion]);
  return row ? fromRow(row) : null;
}

/** Pure part of a dry run: pipeline over the whole sample, then a read-only look at what the store would do. */
export function computeDryRun(ctx: AppContext, mapping: MappingSpec) {
  const rows = getSourceRows(ctx.db);
  const pipeline = runPipeline(rows, mapping, ctx.target);
  const preview: LoadPreview = { validated: 0, wouldInsert: 0, wouldSkipExisting: 0, wouldConflict: 0, conflicts: [] };

  for (const o of pipeline.outcomes) {
    if (o.status !== 'accepted') continue;
    preview.validated++;
    const decision = decideLoad(ctx.db, ctx.target, o.sourceKey, o.transformed);
    if (decision.kind === 'insert') preview.wouldInsert++;
    else if (decision.kind === 'exists') preview.wouldSkipExisting++;
    else {
      preview.wouldConflict++;
      preview.conflicts.push({ sourceKey: o.sourceKey, field: decision.field, value: decision.value, existingId: decision.existingId });
      applyLoadConflict(o, decision.field, decision.value, decision.existingId, mapping);
      pipeline.breakdown.byStage.load = (pipeline.breakdown.byStage.load ?? 0) + 1;
      pipeline.breakdown.byCode.TARGET_CONFLICT = (pipeline.breakdown.byCode.TARGET_CONFLICT ?? 0) + 1;
      pipeline.breakdown.byField[decision.field] = (pipeline.breakdown.byField[decision.field] ?? 0) + 1;
    }
  }
  const rejected = pipeline.outcomes.filter((o) => o.status === 'rejected').length;
  const counts: RunCounts = { source: pipeline.counts.source, transformed: pipeline.counts.transformed, accepted: pipeline.counts.source - rejected, rejected };
  return { pipeline, counts, preview };
}

export function applyLoadConflict(o: RecordOutcome, field: string, value: string, existingId: string, mapping: MappingSpec): void {
  const fm = mapping.fields.find((f) => f.target === field);
  const err: FieldError = {
    stage: 'load',
    targetField: field,
    sourceField: fm?.source ?? null,
    rule: null,
    code: 'TARGET_CONFLICT',
    message: `Target already holds '${field}' = '${value}' on row ${existingId} (a different customer). Inserting would violate the unique constraint.`,
    sourceValue: fm?.source ? (o.source[fm.source] ?? null) : null,
    transformedValue: o.transformed[field] ?? null,
    details: { existingId },
  };
  o.errors.push(err);
  o.status = 'rejected';
}

export function runDryRun(ctx: AppContext, version: number, actor: string): DryRunSummary {
  const plan = getPlan(ctx, version);
  const { pipeline, counts, preview } = computeDryRun(ctx, plan.mapping);
  const sourceHash = getSourceHash(ctx.db);

  const id = transaction(ctx.db, () => {
    const res = run(
      ctx.db,
      `INSERT INTO dry_runs (plan_version, mapping_hash, source_hash, transform_hash, counts, breakdown, load_preview, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [version, plan.mappingHash, sourceHash, pipeline.transformHash, json(counts), json(pipeline.breakdown), json(preview), actor, ctx.now()],
    );
    pipeline.outcomes.forEach((o, i) => {
      run(ctx.db, 'INSERT INTO run_records (run_kind, run_id, seq, source_key, status, source, transformed, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        'dry_run',
        res.lastInsertRowid,
        i + 1,
        o.sourceKey,
        o.status,
        json(o.source),
        json(o.transformed),
        json(o.errors),
      ]);
    });
    return res.lastInsertRowid;
  });

  const summary = getDryRun(ctx, id);
  audit(ctx, actor, 'dry_run.completed', 'dry_run', id, { planVersion: version, counts, transformHash: summary.transformHash });
  return summary;
}

// ---- record listing (shared by dry runs and executions) ------------------------------------------
export interface RunRecordView {
  seq: number;
  sourceKey: string;
  status: string;
  source: SourceRecord;
  transformed: Record<string, Scalar>;
  errors: FieldError[];
}

export function listRunRecords(
  ctx: AppContext,
  kind: 'dry_run' | 'execution',
  runId: number,
  opts: { status?: string; code?: string; q?: string; limit: number; offset: number },
) {
  const where = ['run_kind = ?', 'run_id = ?'];
  const params: Param[] = [kind, runId];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.code) {
    where.push('errors LIKE ?');
    params.push(`%"code":"${opts.code.replace(/[^A-Z_]/g, '')}"%`);
  }
  if (opts.q) {
    where.push('(source_key LIKE ? OR source LIKE ?)');
    const like = `%${opts.q.replace(/[%_]/g, '')}%`;
    params.push(like, like);
  }
  const clause = where.join(' AND ');
  const total = get<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM run_records WHERE ${clause}`, params)!.n;
  const rows = all<{ seq: number; source_key: string; status: string; source: string; transformed: string; errors: string }>(
    ctx.db,
    `SELECT seq, source_key, status, source, transformed, errors FROM run_records WHERE ${clause} ORDER BY seq LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  return {
    total,
    records: rows.map<RunRecordView>((r) => ({ seq: r.seq, sourceKey: r.source_key, status: r.status, source: parse(r.source), transformed: parse(r.transformed), errors: parse(r.errors) })),
  };
}
