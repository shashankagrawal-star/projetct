import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { approvalReadiness, approvePlan, rejectPlan } from '../src/services/approvals.js';
import { addClarifications, answerClarification } from '../src/services/clarifications.js';
import { listAudit } from '../src/services/audit.js';
import { runDryRun, listRunRecords } from '../src/services/dryRuns.js';
import { getExecution, recoverInterruptedExecutions, retryExecution, rollbackExecution, startExecution } from '../src/services/executions.js';
import { createPlanVersion, diffPlans, getPlan } from '../src/services/plans.js';
import { reconcile } from '../src/services/reconciliation.js';
import { countTarget, listTarget } from '../src/services/targetStore.js';
import { approvedPlan, makeCtx } from './helpers.js';
import { manifest, referenceMapping } from './fixtures.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('bounded sample', () => {
  it('refuses to start when the sample exceeds the documented maximum', () => {
    expect(() => makeCtx({ config: { maxSampleSize: 100 } })).toThrow(/MAX_SAMPLE_SIZE/);
  });
  it('accepts the shipped sample at the default limit', () => {
    expect(() => makeCtx()).not.toThrow();
  });
});

describe('plan versioning', () => {
  it('creates immutable, numbered versions with a parent link and a diff', () => {
    const ctx = makeCtx();
    const v1 = createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'a' });
    const edited = clone(referenceMapping);
    edited.fields.find((f) => f.target === 'currency')!.steps = [{ rule: 'constant', params: { value: 'USD' } }];
    const v2 = createPlanVersion(ctx, { mapping: edited, origin: 'user', status: 'draft', parentVersion: 1, note: 'USD per finance', actor: 'b' });
    expect([v1.version, v2.version, v2.parentVersion]).toEqual([1, 2, 1]);
    expect(v1.mappingHash).not.toBe(v2.mappingHash);
    expect(diffPlans(v1, v2).changes).toEqual([expect.objectContaining({ target: 'currency', change: 'modified' })]);
  });

  it('the database refuses in-place edits of a version’s mapping', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'a' });
    expect(() => ctx.db.exec("UPDATE plan_versions SET mapping = '{}' WHERE version = 1")).toThrow(/immutable/);
    expect(getPlan(ctx, 1).mapping.fields.length).toBe(referenceMapping.fields.length);
  });

  it('rejects malformed mappings and unknown parents', () => {
    const ctx = makeCtx();
    expect(code(() => createPlanVersion(ctx, { mapping: { nope: true }, origin: 'user', status: 'draft', actor: 'a' }))).toBe('MALFORMED_MAPPING');
    expect(code(() => createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', parentVersion: 9, actor: 'a' }))).toBe('NOT_FOUND');
  });
});

describe('dry run', () => {
  it('is deterministic, persists evidence and never touches the target', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'a' });
    const before = countTarget(ctx.db, ctx.target);
    const a = runDryRun(ctx, 1, 'a');
    const b = runDryRun(ctx, 1, 'a');
    expect(b.transformHash).toBe(a.transformHash);
    expect(b.counts).toEqual(a.counts);
    expect(a.counts).toEqual({ source: 150, transformed: 130, accepted: 101, rejected: 49 });
    expect(a.loadPreview).toMatchObject({ validated: 104, wouldConflict: 3, wouldInsert: 101 });
    expect(countTarget(ctx.db, ctx.target)).toBe(before);

    const rejected = listRunRecords(ctx, 'dry_run', a.id, { status: 'rejected', limit: 200, offset: 0 });
    expect(rejected.total).toBe(49);
    expect(rejected.records.every((r) => r.errors.length > 0 && r.errors.every((e) => e.code && e.message && 'sourceValue' in e))).toBe(true);
    const conflicts = listRunRecords(ctx, 'dry_run', a.id, { code: 'TARGET_CONFLICT', limit: 10, offset: 0 });
    expect(conflicts.records.map((r) => r.sourceKey).sort()).toEqual([...manifest.defects.target_email_collision!].sort());
  });
});

describe('approval gate', () => {
  it('cannot approve without a dry run on the exact version, or without explicit confirmation', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'a' });
    expect(approvalReadiness(ctx, 1).blockers.map((b) => b.code)).toContain('NO_DRY_RUN');
    expect(code(() => approvePlan(ctx, 1, { confirm: true }, 'r'))).toBe('NOT_APPROVABLE');
    runDryRun(ctx, 1, 'a');
    expect(code(() => approvePlan(ctx, 1, { confirm: false }, 'r'))).toBe('CONFIRMATION_REQUIRED');
    expect(getPlan(ctx, 1).status).toBe('draft');
  });

  it('a dry run of version 1 does not satisfy version 2', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'a' });
    runDryRun(ctx, 1, 'a');
    const edited = clone(referenceMapping);
    edited.fields.find((f) => f.target === 'currency')!.steps = [{ rule: 'constant', params: { value: 'USD' } }];
    createPlanVersion(ctx, { mapping: edited, origin: 'user', status: 'draft', parentVersion: 1, actor: 'a' });
    expect(approvalReadiness(ctx, 2).blockers.map((b) => b.code)).toContain('NO_DRY_RUN');
  });

  it('blocks on unanswered blocking questions and unlocks when they are answered', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'agent', status: 'proposed', actor: 'agent' });
    runDryRun(ctx, 1, 'a');
    addClarifications(ctx, 1, [{ field: 'currency', question: 'Which currency?', options: ['INR', 'USD'], proposedAssumption: 'INR', blocking: true }, { field: null, question: 'Drop notes?', blocking: false }], 'agent');
    expect(approvalReadiness(ctx, 1).blockers.map((b) => b.code)).toEqual(['OPEN_QUESTIONS']);
    expect(code(() => answerClarification(ctx, 'Q1', {}, 'r'))).toBe('BAD_REQUEST');
    answerClarification(ctx, 'Q1', { acceptAssumption: true }, 'r');
    expect(approvalReadiness(ctx, 1).ready).toBe(true); // non-blocking Q2 may stay open
    expect(code(() => answerClarification(ctx, 'Q1', { answer: 'USD' }, 'r'))).toBe('CONFLICT'); // answers are not silently overwritten
  });

  it('does not re-ask a question that already exists', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'agent', status: 'proposed', actor: 'agent' });
    const draft = { field: 'currency', question: 'Which currency?', blocking: true };
    expect(addClarifications(ctx, 1, [draft], 'agent')).toHaveLength(1);
    expect(addClarifications(ctx, 1, [draft], 'agent')).toHaveLength(0);
  });

  it('a stale dry run (source data changed) no longer counts', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'a' });
    runDryRun(ctx, 1, 'a');
    ctx.db.exec("UPDATE source_records SET payload = json_set(payload, '$.country', 'France') WHERE source_key = 'C-0001'");
    expect(approvalReadiness(ctx, 1).blockers.map((b) => b.code)).toContain('STALE_DRY_RUN');
  });

  it('records who approved and which dry run; rejection is final for that version', () => {
    const ctx = makeCtx();
    const { approval, dry } = approvedPlan(ctx);
    expect(approval).toMatchObject({ planVersion: 1, decision: 'approved', actor: 'approver', dryRunId: dry.id });
    expect(getPlan(ctx, 1).status).toBe('approved');
    expect(code(() => rejectPlan(ctx, 1, {}, 'r'))).toBe('CONFLICT');
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', parentVersion: 1, actor: 'a' });
    rejectPlan(ctx, 2, { comment: 'no' }, 'r');
    expect(getPlan(ctx, 2).status).toBe('rejected');
    expect(code(() => runDryRun(ctx, 2, 'a') && approvePlan(ctx, 2, { confirm: true }, 'r'))).toBe('NOT_APPROVABLE');
  });
});

describe('execution safety', () => {
  it('refuses to execute an unapproved plan', () => {
    const ctx = makeCtx();
    createPlanVersion(ctx, { mapping: referenceMapping, origin: 'agent', status: 'proposed', actor: 'agent' });
    const dry = runDryRun(ctx, 1, 'a');
    expect(code(() => startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'a'))).toBe('NOT_APPROVED');
    expect(countTarget(ctx.db, ctx.target)).toBe(5);
  });

  it('refuses when the source drifted since the approved dry run', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    ctx.db.exec("UPDATE source_records SET payload = json_set(payload, '$.status_code', 'S') WHERE source_key = 'C-0001'");
    expect(code(() => startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'a'))).toBe('STALE_DRY_RUN');
  });

  it('loads exactly the accepted records and quarantines target-email collisions with evidence', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    expect(execution.status).toBe('completed');
    expect(execution.counts).toMatchObject({ source: 150, transformed: 130, accepted: 101, rejected: 49, loaded: 101, pending: 0, skippedExisting: 0, duplicatesPrevented: 0 });
    expect(countTarget(ctx.db, ctx.target)).toBe(5 + 101);
    const conflict = listRunRecords(ctx, 'execution', execution.id, { code: 'TARGET_CONFLICT', limit: 10, offset: 0 });
    expect(conflict.total).toBe(3);
    expect(conflict.records[0]!.errors.at(-1)).toMatchObject({ stage: 'load', code: 'TARGET_CONFLICT', details: expect.objectContaining({ existingId: expect.stringMatching(/^cus_LEG-90/) }) });
  });

  it('migrated rows carry correct types and the pre-existing rows are untouched', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    const first = listTarget(ctx.db, ctx.target, { limit: 1, offset: 0, origin: 'migrated' }).rows[0]!;
    expect(first.id).toMatch(/^cus_C-\d{4}$/);
    expect(typeof first.marketing_opt_in).toBe('boolean');
    expect(first.currency).toBe('INR');
    expect(Number.isInteger(first.account_balance_minor) || first.account_balance_minor === null).toBe(true);
    expect(listTarget(ctx.db, ctx.target, { limit: 10, offset: 0, origin: 'seed' }).total).toBe(5);
  });

  it('only one live execution at a time; the same idempotency key replays instead of re-running', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const first = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, idempotencyKey: 'key-00000001' }, 'op');
    const replay = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, idempotencyKey: 'key-00000001' }, 'op');
    expect(replay.replay).toBe(true);
    expect(replay.execution.id).toBe(first.execution.id);
    expect(code(() => startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op'))).toBe('EXECUTION_EXISTS');
    expect(code(() => startExecution(ctx, { planVersion: 2, dryRunId: dry.id, idempotencyKey: 'key-00000001' }, 'op'))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(countTarget(ctx.db, ctx.target, 'execution_id IS NOT NULL')).toBe(101);
  });
});

describe('retry without duplicates', () => {
  it('a mid-run failure leaves a partial load; retry finishes it and never inserts twice', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution: failed } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 40 }, 'op');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Simulated/);
    expect(failed.counts.loaded).toBe(25); // one committed batch of 25; the failing batch rolled back whole
    expect(failed.counts.pending).toBeGreaterThan(0);
    expect(countTarget(ctx.db, ctx.target, 'execution_id = ?', [failed.id])).toBe(25);

    const done = retryExecution(ctx, failed.id, {}, 'op');
    expect(done.status).toBe('completed');
    expect(done.counts).toMatchObject({ loaded: 101, pending: 0, rejected: 49 });
    expect(done.counts.duplicatesPrevented).toBe(25); // the 25 already-committed rows were re-presented and blocked
    expect(done.attempts.map((a) => [a.attemptNo, a.trigger, a.status, a.inserted, a.duplicatesPrevented])).toEqual([
      [1, 'initial', 'failed', 25, 0],
      [2, 'retry', 'completed', 76, 25],
    ]);
    expect(countTarget(ctx.db, ctx.target, 'execution_id = ?', [failed.id])).toBe(101);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM (SELECT source_key FROM target_customers WHERE source_key IS NOT NULL GROUP BY source_key HAVING COUNT(*) > 1)').get()).toEqual({ n: 0 });
    expect(reconcile(ctx, failed.id).status).toBe('pass');
  });

  it('retrying a completed execution is a safe no-op that proves the guard', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    const again = retryExecution(ctx, execution.id, {}, 'op');
    expect(again.counts.loaded).toBe(101);
    expect(again.counts.duplicatesPrevented).toBe(101);
    expect(again.attempts.at(-1)).toMatchObject({ inserted: 0, duplicatesPrevented: 101 });
    expect(countTarget(ctx.db, ctx.target)).toBe(106);
  });

  it('a retry can fail again and still be retried (state machine stays consistent)', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 30 }, 'op');
    const second = retryExecution(ctx, execution.id, { simulateFailureAfter: 60 }, 'op');
    expect(second.status).toBe('failed');
    const third = retryExecution(ctx, execution.id, {}, 'op');
    expect(third.status).toBe('completed');
    expect(third.counts.loaded).toBe(101);
    expect(third.attempts).toHaveLength(3);
  });

  it('refuses failure injection when the deployment disables it', () => {
    const ctx = makeCtx({ config: { allowFailureInjection: false } });
    const { dry } = approvedPlan(ctx);
    expect(code(() => startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 5 }, 'op'))).toBe('FAILURE_INJECTION_DISABLED');
  });

  it('recovers an execution left "running" by a crash so it can be retried', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 30 }, 'op');
    ctx.db.exec(`UPDATE executions SET status = 'running' WHERE id = ${execution.id}`);
    expect(recoverInterruptedExecutions(ctx)).toBe(1);
    expect(getExecution(ctx, execution.id).status).toBe('failed');
    expect(retryExecution(ctx, execution.id, {}, 'op').status).toBe('completed');
  });
});

describe('rollback', () => {
  it('removes only this execution’s rows, restores the baseline, keeps history, and allows a fresh run', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    expect(code(() => rollbackExecution(ctx, execution.id, { reason: ' ' }, 'op'))).toBe('BAD_REQUEST');
    const rolled = rollbackExecution(ctx, execution.id, { reason: 'currency was wrong' }, 'op');
    expect(rolled.status).toBe('rolled_back');
    expect(rolled.rollbacks[0]).toMatchObject({ rowsRemoved: 101, targetRowsAfter: 5, reason: 'currency was wrong', actor: 'op' });
    expect(countTarget(ctx.db, ctx.target)).toBe(5);
    expect(listTarget(ctx.db, ctx.target, { limit: 10, offset: 0, origin: 'seed' }).total).toBe(5);
    expect(rolled.attempts).toHaveLength(1); // history preserved
    expect(code(() => rollbackExecution(ctx, execution.id, { reason: 'again' }, 'op'))).toBe('ALREADY_ROLLED_BACK');
    expect(code(() => retryExecution(ctx, execution.id, {}, 'op'))).toBe('EXECUTION_ROLLED_BACK');
    expect(reconcile(ctx, execution.id).status).toBe('pass');

    const second = startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    expect(second.execution.id).not.toBe(execution.id);
    expect(second.execution.counts.loaded).toBe(101);
    expect(countTarget(ctx.db, ctx.target)).toBe(106);
  });

  it('can roll back a partially failed execution', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 30 }, 'op');
    expect(rollbackExecution(ctx, execution.id, { reason: 'abandon' }, 'op').rollbacks[0]!.rowsRemoved).toBe(25);
    expect(countTarget(ctx.db, ctx.target)).toBe(5);
  });
});

describe('reconciliation', () => {
  it('passes on a clean run and reports the source / target totals', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    const r = reconcile(ctx, execution.id);
    expect(r.status).toBe('pass');
    expect(r.totals).toMatchObject({ sourceTotal: 150, targetBefore: 5, targetNow: 106, targetMigrated: 101, quarantined: 49, loaded: 101 });
  });

  it('detects a deleted target row (count mismatch) and a corrupted value (control total)', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id }, 'op');
    ctx.db.exec("UPDATE target_customers SET account_balance_minor = account_balance_minor + 1 WHERE source_key = (SELECT source_key FROM target_customers WHERE account_balance_minor IS NOT NULL AND execution_id IS NOT NULL LIMIT 1)");
    const corrupted = reconcile(ctx, execution.id);
    expect(corrupted.status).toBe('fail');
    expect(corrupted.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['control_total_balance']);

    ctx.db.exec('DELETE FROM target_customers WHERE source_key = (SELECT source_key FROM target_customers WHERE execution_id IS NOT NULL LIMIT 1)');
    expect(reconcile(ctx, execution.id).checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(expect.arrayContaining(['target_matches_loaded', 'target_total']));
  });

  it('reports pending records on a partial run', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 30 }, 'op');
    const r = reconcile(ctx, execution.id);
    expect(r.status).toBe('fail');
    expect(r.checks.find((c) => c.id === 'no_pending')).toMatchObject({ pass: false });
    expect(r.checks.find((c) => c.id === 'accounting')!.pass).toBe(true); // nothing lost, just unfinished
  });
});

describe('history', () => {
  it('records approval, execution, retry and rollback in an append-only log', () => {
    const ctx = makeCtx();
    const { dry } = approvedPlan(ctx);
    const { execution } = startExecution(ctx, { planVersion: 1, dryRunId: dry.id, simulateFailureAfter: 30 }, 'op');
    retryExecution(ctx, execution.id, {}, 'op');
    rollbackExecution(ctx, execution.id, { reason: 'test' }, 'op');
    const events = listAudit(ctx, { limit: 100, offset: 0 }).entries.map((e) => e.event).reverse();
    expect(events).toEqual(['plan.created', 'dry_run.completed', 'plan.approved', 'execution.started', 'execution.failed', 'execution.retried', 'execution.completed', 'execution.rolled_back']);
    expect(listAudit(ctx, { limit: 10, offset: 0, event: 'plan.approved' }).entries[0]).toMatchObject({ actor: 'approver', entityType: 'plan_version' });
    expect(() => ctx.db.exec("UPDATE audit_log SET actor = 'someone-else'")).toThrow(/append-only/);
    expect(() => ctx.db.exec('DELETE FROM audit_log')).toThrow(/append-only/);
  });
});
