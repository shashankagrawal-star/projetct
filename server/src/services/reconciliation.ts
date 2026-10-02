import type { AppContext } from '../context.js';
import { get } from '../db/connection.js';
import { targetTable } from '../db/schema.js';
import { countSource } from './sourceStore.js';
import { countTarget, sumColumn } from './targetStore.js';
import { getExecution } from './executions.js';

export interface ReconCheck {
  id: string;
  label: string;
  expected: number | string;
  actual: number | string;
  pass: boolean;
  note?: string;
}

export interface Reconciliation {
  executionId: number;
  executionStatus: string;
  status: 'pass' | 'fail';
  totals: {
    sourceTotal: number;
    targetBefore: number; // rows in the target before this migration (baseline)
    targetNow: number;
    targetMigrated: number; // rows currently in the target that this execution inserted
    quarantined: number;
    loaded: number;
    skippedExisting: number;
    pending: number;
  };
  checks: ReconCheck[];
  checkedAt: string;
}

/**
 * Compares the source with the target after (or during, or after rollback of) an execution.
 * Every check is derived from the live database, not from counters the execution wrote about itself.
 */
export function reconcile(ctx: AppContext, executionId: number): Reconciliation {
  const exec = getExecution(ctx, executionId);
  const { db, target } = ctx;
  const c = exec.counts;
  const rolledBack = exec.status === 'rolled_back';

  const sourceTotal = countSource(db);
  const targetNow = countTarget(db, target);
  const targetMigrated = countTarget(db, target, 'execution_id = ?', [executionId]);
  const dupSourceKeys = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM (SELECT source_key FROM ${targetTable(target)} WHERE source_key IS NOT NULL GROUP BY source_key HAVING COUNT(*) > 1)`)!.n;

  const checks: ReconCheck[] = [];
  const add = (id: string, label: string, expected: number | string, actual: number | string, note?: string) =>
    checks.push({ id, label, expected, actual, pass: expected === actual, ...(note ? { note } : {}) });

  add('source_covered', 'Every source record is accounted for in the execution', sourceTotal, c.source, 'source records vs. records tracked by the execution');
  add('accounting', 'Source = loaded + skipped (already present) + pending + quarantined', sourceTotal, c.loaded + c.skippedExisting + c.pending + c.rejected, 'no record is silently lost');

  if (rolledBack) {
    add('rolled_back_rows', 'No migrated rows remain after rollback', 0, targetMigrated);
    const laterLive = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM executions WHERE id > ? AND status != 'rolled_back'", [executionId])!.n;
    if (laterLive === 0) add('baseline_restored', 'Target row count is back to its pre-migration baseline', exec.baselineTargetRows, targetNow);
  } else {
    add('target_matches_loaded', 'Rows tagged with this execution in the target = records marked loaded', c.loaded, targetMigrated, 'target-side count vs. execution ledger');
    add('target_total', 'Target total = baseline + records the ledger says were loaded', exec.baselineTargetRows + c.loaded, targetNow, 'also catches pre-existing target rows that were added or removed');
    add('no_pending', 'No accepted record is left unprocessed', 0, c.pending, c.pending > 0 ? 'Retry the execution to finish the remaining records.' : undefined);

    const ledgerSum = loadedBalanceSum(ctx, executionId);
    const targetSum = sumColumn(db, target, 'account_balance_minor', 'execution_id = ?', [executionId]);
    add('control_total_balance', 'Control total: Σ account_balance_minor (ledger vs. target)', ledgerSum, targetSum, 'detects value corruption that row counts cannot see');
  }
  add('no_duplicate_source_keys', 'No source record appears twice in the target', 0, dupSourceKeys);

  return {
    executionId,
    executionStatus: exec.status,
    status: checks.every((x) => x.pass) ? 'pass' : 'fail',
    totals: {
      sourceTotal,
      targetBefore: exec.baselineTargetRows,
      targetNow,
      targetMigrated,
      quarantined: c.rejected,
      loaded: c.loaded,
      skippedExisting: c.skippedExisting,
      pending: c.pending,
    },
    checks,
    checkedAt: ctx.now(),
  };
}

function loadedBalanceSum(ctx: AppContext, executionId: number): number {
  const rows = ctx.db.prepare("SELECT transformed FROM run_records WHERE run_kind = 'execution' AND run_id = ? AND status = 'loaded'").all(executionId) as Array<{ transformed: string }>;
  let sum = 0;
  for (const r of rows) {
    const v = (JSON.parse(r.transformed) as Record<string, unknown>).account_balance_minor;
    if (typeof v === 'number') sum += v;
  }
  return sum;
}
