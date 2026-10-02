import type { AppContext } from '../context.js';
import { all, get, run, transaction } from '../db/connection.js';
import { conflict, unprocessable } from '../errors.js';
import { audit } from './audit.js';
import { openBlocking } from './clarifications.js';
import { latestDryRun } from './dryRuns.js';
import { getPlan, setPlanStatus, validatePlan } from './plans.js';
import { getSourceHash } from './sourceStore.js';

export interface Approval {
  id: number;
  planVersion: number;
  mappingHash: string;
  dryRunId: number | null;
  decision: 'approved' | 'rejected';
  actor: string;
  comment: string | null;
  createdAt: string;
}

interface Row {
  id: number;
  plan_version: number;
  mapping_hash: string;
  dry_run_id: number | null;
  decision: 'approved' | 'rejected';
  actor: string;
  comment: string | null;
  created_at: string;
}
const fromRow = (r: Row): Approval => ({ id: r.id, planVersion: r.plan_version, mappingHash: r.mapping_hash, dryRunId: r.dry_run_id, decision: r.decision, actor: r.actor, comment: r.comment, createdAt: r.created_at });

export function listApprovals(ctx: AppContext, planVersion?: number): Approval[] {
  const rows = planVersion ? all<Row>(ctx.db, 'SELECT * FROM approvals WHERE plan_version = ? ORDER BY id DESC', [planVersion]) : all<Row>(ctx.db, 'SELECT * FROM approvals ORDER BY id DESC');
  return rows.map(fromRow);
}

export function currentApproval(ctx: AppContext, planVersion: number, mappingHash: string): Approval | null {
  const row = get<Row>(ctx.db, "SELECT * FROM approvals WHERE plan_version = ? AND mapping_hash = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1", [planVersion, mappingHash]);
  return row ? fromRow(row) : null;
}

/** What still stands between a plan version and approval. Used by the UI and enforced by approvePlan. */
export function approvalReadiness(ctx: AppContext, version: number) {
  const plan = getPlan(ctx, version);
  const validation = validatePlan(ctx, plan);
  const dry = latestDryRun(ctx, version);
  const sourceHash = getSourceHash(ctx.db);
  const blockers: Array<{ code: string; message: string }> = [];

  if (plan.status === 'approved') blockers.push({ code: 'ALREADY_APPROVED', message: 'This version is already approved.' });
  if (plan.status === 'rejected') blockers.push({ code: 'REJECTED', message: 'This version was rejected. Create a new version instead.' });
  if (!validation.valid) blockers.push({ code: 'INVALID_MAPPING', message: `Mapping has ${validation.errors.length} structural error(s); fix them in a new version.` });
  if (!dry) blockers.push({ code: 'NO_DRY_RUN', message: 'Run a dry run on this exact version before approving.' });
  else if (dry.mappingHash !== plan.mappingHash || dry.sourceHash !== sourceHash) blockers.push({ code: 'STALE_DRY_RUN', message: 'The latest dry run does not match this mapping or the current source data. Run it again.' });
  const open = openBlocking(ctx);
  if (open.length > 0) blockers.push({ code: 'OPEN_QUESTIONS', message: `${open.length} blocking clarification question(s) are unanswered: ${open.map((q) => q.qid).join(', ')}.` });

  return { ready: blockers.length === 0, blockers, validation, dryRunId: dry?.id ?? null };
}

export function approvePlan(ctx: AppContext, version: number, input: { comment?: string; confirm: boolean }, actor: string): Approval {
  if (input.confirm !== true) throw unprocessable('Approval must be explicitly confirmed', undefined, 'CONFIRMATION_REQUIRED');
  const readiness = approvalReadiness(ctx, version);
  if (!readiness.ready) throw conflict('Plan cannot be approved yet', readiness.blockers, 'NOT_APPROVABLE');
  const plan = getPlan(ctx, version);

  return transaction(ctx.db, () => {
    const res = run(ctx.db, 'INSERT INTO approvals (plan_version, mapping_hash, dry_run_id, decision, actor, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      version,
      plan.mappingHash,
      readiness.dryRunId,
      'approved',
      actor,
      input.comment?.trim() || null,
      ctx.now(),
    ]);
    setPlanStatus(ctx, version, 'approved');
    audit(ctx, actor, 'plan.approved', 'plan_version', version, { mappingHash: plan.mappingHash, dryRunId: readiness.dryRunId, comment: input.comment ?? null });
    return fromRow(get<Row>(ctx.db, 'SELECT * FROM approvals WHERE id = ?', [res.lastInsertRowid])!);
  });
}

export function rejectPlan(ctx: AppContext, version: number, input: { comment?: string }, actor: string): Approval {
  const plan = getPlan(ctx, version);
  if (plan.status === 'approved') throw conflict('An approved version cannot be rejected; roll back any execution and create a new version');
  if (plan.status === 'rejected') throw conflict('Version is already rejected');
  return transaction(ctx.db, () => {
    const res = run(ctx.db, 'INSERT INTO approvals (plan_version, mapping_hash, dry_run_id, decision, actor, comment, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)', [
      version,
      plan.mappingHash,
      'rejected',
      actor,
      input.comment?.trim() || null,
      ctx.now(),
    ]);
    setPlanStatus(ctx, version, 'rejected');
    audit(ctx, actor, 'plan.rejected', 'plan_version', version, { comment: input.comment ?? null });
    return fromRow(get<Row>(ctx.db, 'SELECT * FROM approvals WHERE id = ?', [res.lastInsertRowid])!);
  });
}
