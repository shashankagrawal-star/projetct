import type { AppContext } from '../context.js';
import { all, get, json, parse, run, transaction } from '../db/connection.js';
import { runPipeline } from '../domain/pipeline.js';
import type { FieldError, Scalar } from '../domain/types.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from './audit.js';
import { currentApproval } from './approvals.js';
import { getDryRun } from './dryRuns.js';
import { getPlan } from './plans.js';
import { getSourceHash, getSourceRows } from './sourceStore.js';
import { countTarget, decideLoad, deleteByExecution, insertTargetRow } from './targetStore.js';

export type ExecutionStatus = 'running' | 'failed' | 'completed' | 'rolled_back';

export interface ExecutionCounts {
  source: number;
  transformed: number;
  accepted: number; // validated and not (yet) rejected by the store: loaded + skippedExisting + pending
  rejected: number; // quarantined at any stage, including load conflicts
  loaded: number; // rows this execution put into the target
  skippedExisting: number;
  pending: number;
  duplicatesPrevented: number; // insert attempts blocked by the idempotency guard, across all attempts
  rolledBack: number;
}

export interface Attempt {
  attemptNo: number;
  trigger: 'initial' | 'retry';
  status: 'running' | 'failed' | 'completed';
  inserted: number;
  duplicatesPrevented: number;
  loadRejected: number;
  error: string | null;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface Rollback {
  id: number;
  reason: string;
  rowsRemoved: number;
  targetRowsAfter: number;
  actor: string;
  createdAt: string;
}

export interface Execution {
  id: number;
  planVersion: number;
  dryRunId: number;
  approvalId: number;
  idempotencyKey: string | null;
  status: ExecutionStatus;
  mappingHash: string;
  sourceHash: string;
  transformHash: string;
  baselineTargetRows: number;
  counts: ExecutionCounts;
  attempts: Attempt[];
  rollbacks: Rollback[];
  error: string | null;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
}

interface Row {
  id: number;
  plan_version: number;
  dry_run_id: number;
  approval_id: number;
  idempotency_key: string | null;
  status: ExecutionStatus;
  mapping_hash: string;
  source_hash: string;
  transform_hash: string;
  baseline_target_rows: number;
  counts: string;
  error: string | null;
  created_by: string;
  created_at: string;
  finished_at: string | null;
}

export class SimulatedFailure extends Error {
  constructor(public readonly afterRecords: number) {
    super(`Simulated target failure after ${afterRecords} record(s) (failure injection requested by the operator)`);
    this.name = 'SimulatedFailure';
  }
}

function liveCounts(ctx: AppContext, row: Row): ExecutionCounts {
  const stored = parse<{ transformed?: number }>(row.counts);
  const byStatus = new Map(
    all<{ status: string; n: number }>(ctx.db, "SELECT status, COUNT(*) AS n FROM run_records WHERE run_kind = 'execution' AND run_id = ? GROUP BY status", [row.id]).map((r) => [r.status, r.n]),
  );
  const n = (s: string) => byStatus.get(s) ?? 0;
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const prevented = get<{ s: number | null }>(ctx.db, 'SELECT SUM(duplicates_prevented) AS s FROM execution_attempts WHERE execution_id = ?', [row.id])?.s ?? 0;
  const rolledBack = get<{ s: number | null }>(ctx.db, 'SELECT SUM(rows_removed) AS s FROM rollbacks WHERE execution_id = ?', [row.id])?.s ?? 0;
  return {
    source: total,
    transformed: stored.transformed ?? 0,
    accepted: n('loaded') + n('skipped_existing') + n('pending'),
    rejected: n('rejected'),
    loaded: n('loaded'),
    skippedExisting: n('skipped_existing'),
    pending: n('pending'),
    duplicatesPrevented: prevented,
    rolledBack,
  };
}

function toExecution(ctx: AppContext, r: Row): Execution {
  const attempts = all<{
    attempt_no: number;
    trigger: 'initial' | 'retry';
    status: Attempt['status'];
    inserted: number;
    duplicates_prevented: number;
    load_rejected: number;
    error: string | null;
    actor: string;
    started_at: string;
    finished_at: string | null;
  }>(ctx.db, 'SELECT * FROM execution_attempts WHERE execution_id = ? ORDER BY attempt_no', [r.id]).map<Attempt>((a) => ({
    attemptNo: a.attempt_no,
    trigger: a.trigger,
    status: a.status,
    inserted: a.inserted,
    duplicatesPrevented: a.duplicates_prevented,
    loadRejected: a.load_rejected,
    error: a.error,
    actor: a.actor,
    startedAt: a.started_at,
    finishedAt: a.finished_at,
  }));
  const rollbacks = all<{ id: number; reason: string; rows_removed: number; target_rows_after: number; actor: string; created_at: string }>(
    ctx.db,
    'SELECT * FROM rollbacks WHERE execution_id = ? ORDER BY id',
    [r.id],
  ).map<Rollback>((b) => ({ id: b.id, reason: b.reason, rowsRemoved: b.rows_removed, targetRowsAfter: b.target_rows_after, actor: b.actor, createdAt: b.created_at }));
  return {
    id: r.id,
    planVersion: r.plan_version,
    dryRunId: r.dry_run_id,
    approvalId: r.approval_id,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    mappingHash: r.mapping_hash,
    sourceHash: r.source_hash,
    transformHash: r.transform_hash,
    baselineTargetRows: r.baseline_target_rows,
    counts: liveCounts(ctx, r),
    attempts,
    rollbacks,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

const rawRow = (ctx: AppContext, id: number): Row => {
  const row = get<Row>(ctx.db, 'SELECT * FROM executions WHERE id = ?', [id]);
  if (!row) throw notFound(`Execution ${id}`);
  return row;
};

export const getExecution = (ctx: AppContext, id: number): Execution => toExecution(ctx, rawRow(ctx, id));
export const listExecutions = (ctx: AppContext): Execution[] => all<Row>(ctx.db, 'SELECT * FROM executions ORDER BY id DESC').map((r) => toExecution(ctx, r));

/**
 * Everything that must still be true at the moment of (re)execution. Execution never trusts an
 * earlier check: it re-derives the pipeline result and compares it with the one the human approved.
 */
function assertExecutable(ctx: AppContext, planVersion: number, dryRunId: number) {
  const plan = getPlan(ctx, planVersion);
  if (plan.status !== 'approved') throw conflict(`Plan version ${planVersion} is ${plan.status}, not approved. A human must approve it before execution.`, undefined, 'NOT_APPROVED');
  const approval = currentApproval(ctx, planVersion, plan.mappingHash);
  if (!approval) throw conflict(`No valid approval on record for plan version ${planVersion}`, undefined, 'NOT_APPROVED');

  const dry = getDryRun(ctx, dryRunId);
  if (dry.planVersion !== planVersion || dry.mappingHash !== plan.mappingHash) throw conflict('The dry run does not belong to this exact plan version', undefined, 'DRY_RUN_MISMATCH');
  if (dry.sourceHash !== getSourceHash(ctx.db)) throw conflict('The source data changed since the dry run; run a new dry run and re-approve', undefined, 'STALE_DRY_RUN');

  const pipeline = runPipeline(getSourceRows(ctx.db), plan.mapping, ctx.target);
  if (pipeline.transformHash !== dry.transformHash) {
    throw conflict('Re-running the transform produced different results than the approved dry run (drift). Execution refused.', { expected: dry.transformHash, actual: pipeline.transformHash }, 'DRY_RUN_DRIFT');
  }
  return { plan, approval, dry, pipeline };
}

export interface StartInput {
  planVersion: number;
  dryRunId: number;
  idempotencyKey?: string;
  simulateFailureAfter?: number;
}

export function startExecution(ctx: AppContext, input: StartInput, actor: string): { execution: Execution; replay: boolean } {
  if (input.simulateFailureAfter !== undefined && !ctx.config.allowFailureInjection) throw badRequest('Failure injection is disabled on this deployment', undefined, 'FAILURE_INJECTION_DISABLED');

  if (input.idempotencyKey) {
    const existing = get<Row>(ctx.db, 'SELECT * FROM executions WHERE idempotency_key = ?', [input.idempotencyKey]);
    if (existing) {
      if (existing.plan_version !== input.planVersion || existing.dry_run_id !== input.dryRunId) {
        throw conflict('Idempotency key was already used for a different request', undefined, 'IDEMPOTENCY_KEY_REUSED');
      }
      ctx.logger.info({ event: 'execution.idempotent_replay', executionId: existing.id, idempotencyKey: input.idempotencyKey }, 'idempotent replay of execution request');
      return { execution: toExecution(ctx, existing), replay: true };
    }
  }

  const live = get<{ id: number; status: string }>(ctx.db, "SELECT id, status FROM executions WHERE status IN ('running','failed','completed') ORDER BY id DESC LIMIT 1");
  if (live) {
    throw conflict(
      `Execution #${live.id} is ${live.status} and has not been rolled back. ${live.status === 'failed' ? 'Retry it' : 'Roll it back first'} instead of starting a second migration of the same dataset.`,
      { executionId: live.id, status: live.status },
      'EXECUTION_EXISTS',
    );
  }

  const { plan, approval, dry, pipeline } = assertExecutable(ctx, input.planVersion, input.dryRunId);
  const sourceHash = getSourceHash(ctx.db);

  const id = transaction(ctx.db, () => {
    const res = run(
      ctx.db,
      `INSERT INTO executions (plan_version, dry_run_id, approval_id, idempotency_key, status, mapping_hash, source_hash, transform_hash, baseline_target_rows, counts, created_by, created_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      [plan.version, dry.id, approval.id, input.idempotencyKey ?? null, plan.mappingHash, sourceHash, pipeline.transformHash, countTarget(ctx.db, ctx.target), json({ transformed: pipeline.counts.transformed }), actor, ctx.now()],
    );
    pipeline.outcomes.forEach((o, i) => {
      run(ctx.db, 'INSERT INTO run_records (run_kind, run_id, seq, source_key, status, source, transformed, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        'execution',
        res.lastInsertRowid,
        i + 1,
        o.sourceKey,
        o.status === 'accepted' ? 'pending' : 'rejected',
        json(o.source),
        json(o.transformed),
        json(o.errors),
      ]);
    });
    return res.lastInsertRowid;
  });

  audit(ctx, actor, 'execution.started', 'execution', id, { planVersion: plan.version, dryRunId: dry.id, approvalId: approval.id, idempotencyKey: input.idempotencyKey ?? null });
  return { execution: runAttempt(ctx, id, 'initial', actor, input.simulateFailureAfter), replay: false };
}

export function retryExecution(ctx: AppContext, id: number, input: { simulateFailureAfter?: number }, actor: string): Execution {
  if (input.simulateFailureAfter !== undefined && !ctx.config.allowFailureInjection) throw badRequest('Failure injection is disabled on this deployment', undefined, 'FAILURE_INJECTION_DISABLED');
  const row = rawRow(ctx, id);
  if (row.status === 'running') throw conflict(`Execution ${id} is already running`, undefined, 'EXECUTION_RUNNING');
  if (row.status === 'rolled_back') throw conflict(`Execution ${id} was rolled back and cannot be retried. Start a new execution.`, undefined, 'EXECUTION_ROLLED_BACK');
  const { pipeline } = assertExecutable(ctx, row.plan_version, row.dry_run_id);
  if (pipeline.transformHash !== row.transform_hash) throw conflict('Transform results differ from the ones this execution was started with', undefined, 'DRY_RUN_DRIFT');
  return runAttempt(ctx, id, 'retry', actor, input.simulateFailureAfter);
}

type RecRow = { source_key: string; status: string; transformed: string; errors: string };

function runAttempt(ctx: AppContext, executionId: number, trigger: 'initial' | 'retry', actor: string, simulateFailureAfter?: number): Execution {
  const { db, target } = ctx;
  const attemptNo = (get<{ n: number | null }>(db, 'SELECT MAX(attempt_no) AS n FROM execution_attempts WHERE execution_id = ?', [executionId])?.n ?? 0) + 1;
  const attemptId = run(db, "INSERT INTO execution_attempts (execution_id, attempt_no, trigger, status, actor, started_at) VALUES (?, ?, ?, 'running', ?, ?)", [executionId, attemptNo, trigger, actor, ctx.now()]).lastInsertRowid;
  run(db, "UPDATE executions SET status = 'running', error = NULL, finished_at = NULL WHERE id = ?", [executionId]);
  if (trigger === 'retry') audit(ctx, actor, 'execution.retried', 'execution', executionId, { attemptNo, simulateFailureAfter: simulateFailureAfter ?? null });
  ctx.logger.info({ event: 'execution.attempt_started', executionId, attemptNo, trigger }, 'execution attempt started');

  const totals = { inserted: 0, prevented: 0, loadRejected: 0 };
  let processed = 0;

  try {
    // On a retry every accepted record is re-presented to the store — including ones a previous attempt
    // may already have committed. The source_key guard, not bookkeeping, is what prevents duplicates.
    const todo = all<RecRow>(db, "SELECT source_key, status, transformed, errors FROM run_records WHERE run_kind = 'execution' AND run_id = ? AND status IN ('pending','loaded','skipped_existing') ORDER BY seq", [executionId]);
    const batchSize = ctx.config.executionBatchSize;

    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const local = transaction(db, () => {
        const l = { inserted: 0, prevented: 0, loadRejected: 0 };
        for (const rec of batch) {
          if (simulateFailureAfter !== undefined && processed + (l.inserted + l.prevented + l.loadRejected) >= simulateFailureAfter) throw new SimulatedFailure(simulateFailureAfter);
          const transformed = parse<Record<string, Scalar>>(rec.transformed);
          const decision = decideLoad(db, target, rec.source_key, transformed);
          let status: 'loaded' | 'skipped_existing' | 'rejected' = 'loaded';
          let errors = parse<FieldError[]>(rec.errors);

          if (decision.kind === 'exists') {
            l.prevented++;
            status = decision.executionId === executionId ? 'loaded' : 'skipped_existing';
          } else if (decision.kind === 'conflict') {
            l.loadRejected++;
            status = 'rejected';
            errors = [...errors, loadError(decision.field, decision.value, decision.existingId, transformed)];
          } else {
            try {
              const { inserted } = insertTargetRow(db, target, transformed, { sourceKey: rec.source_key, executionId, migratedAt: ctx.now() });
              if (inserted) l.inserted++;
              else l.prevented++; // lost a race on source_key: the guard held
            } catch (err) {
              l.loadRejected++;
              status = 'rejected';
              errors = [...errors, { stage: 'load', targetField: target.primaryKey, sourceField: null, rule: null, code: 'STORE_CONSTRAINT', message: (err as Error).message, sourceValue: null }];
            }
          }
          run(db, "UPDATE run_records SET status = ?, errors = ? WHERE run_kind = 'execution' AND run_id = ? AND source_key = ?", [status, json(errors), executionId, rec.source_key]);
        }
        return l;
      });
      processed += batch.length;
      totals.inserted += local.inserted;
      totals.prevented += local.prevented;
      totals.loadRejected += local.loadRejected;
      run(db, 'UPDATE execution_attempts SET inserted = ?, duplicates_prevented = ?, load_rejected = ? WHERE id = ?', [totals.inserted, totals.prevented, totals.loadRejected, attemptId]);
    }

    run(db, "UPDATE execution_attempts SET status = 'completed', finished_at = ? WHERE id = ?", [ctx.now(), attemptId]);
    run(db, "UPDATE executions SET status = 'completed', finished_at = ? WHERE id = ?", [ctx.now(), executionId]);
    const execution = getExecution(ctx, executionId);
    audit(ctx, actor, 'execution.completed', 'execution', executionId, { attemptNo, counts: execution.counts, attempt: totals });
    return execution;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(db, 'UPDATE execution_attempts SET inserted = ?, duplicates_prevented = ?, load_rejected = ? WHERE id = ?', [totals.inserted, totals.prevented, totals.loadRejected, attemptId]);
    run(db, "UPDATE execution_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [message, ctx.now(), attemptId]);
    run(db, "UPDATE executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [message, ctx.now(), executionId]);
    const execution = getExecution(ctx, executionId);
    ctx.logger.error({ event: 'execution.attempt_failed', executionId, attemptNo, error: message, counts: execution.counts }, 'execution attempt failed');
    audit(ctx, actor, 'execution.failed', 'execution', executionId, { attemptNo, error: message, counts: execution.counts });
    return execution;
  }
}

function loadError(field: string, value: string, existingId: string, transformed: Record<string, Scalar>): FieldError {
  return {
    stage: 'load',
    targetField: field,
    sourceField: null,
    rule: null,
    code: 'TARGET_CONFLICT',
    message: `Target already holds '${field}' = '${value}' on row ${existingId} (a different customer). Inserting would violate the unique constraint.`,
    sourceValue: null,
    transformedValue: transformed[field] ?? null,
    details: { existingId },
  };
}

export function rollbackExecution(ctx: AppContext, id: number, input: { reason: string }, actor: string): Execution {
  const row = rawRow(ctx, id);
  if (row.status === 'running') throw conflict(`Execution ${id} is running`, undefined, 'EXECUTION_RUNNING');
  if (row.status === 'rolled_back') throw conflict(`Execution ${id} is already rolled back`, undefined, 'ALREADY_ROLLED_BACK');
  const reason = input.reason?.trim();
  if (!reason) throw badRequest('A rollback reason is required');

  transaction(ctx.db, () => {
    // Only rows this execution inserted carry its id. Pre-existing target rows have execution_id NULL and are never touched.
    const removed = deleteByExecution(ctx.db, ctx.target, id);
    const after = countTarget(ctx.db, ctx.target);
    run(ctx.db, 'INSERT INTO rollbacks (execution_id, reason, rows_removed, target_rows_after, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, reason, removed, after, actor, ctx.now()]);
    run(ctx.db, "UPDATE executions SET status = 'rolled_back', finished_at = ? WHERE id = ?", [ctx.now(), id]);
    audit(ctx, actor, 'execution.rolled_back', 'execution', id, { reason, rowsRemoved: removed, targetRowsAfter: after, baselineTargetRows: row.baseline_target_rows });
  });
  return getExecution(ctx, id);
}

/** On boot: anything still marked running was interrupted by a crash/restart. Mark it failed so it can be retried. */
export function recoverInterruptedExecutions(ctx: AppContext): number {
  const stuck = all<{ id: number }>(ctx.db, "SELECT id FROM executions WHERE status = 'running'");
  for (const { id } of stuck) {
    const msg = 'Interrupted: the server restarted while this attempt was running';
    run(ctx.db, "UPDATE execution_attempts SET status = 'failed', error = ?, finished_at = ? WHERE execution_id = ? AND status = 'running'", [msg, ctx.now(), id]);
    run(ctx.db, "UPDATE executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [msg, ctx.now(), id]);
    audit(ctx, 'system', 'execution.failed', 'execution', id, { error: msg });
  }
  return stuck.length;
}
