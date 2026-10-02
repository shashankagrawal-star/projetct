import { createContext } from '../src/bootstrap.js';
import { loadConfig, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import type { AgentLlm } from '../src/agent/llm.js';
import { createLogger } from '../src/logger.js';
import { approvePlan } from '../src/services/approvals.js';
import { runDryRun } from '../src/services/dryRuns.js';
import { createPlanVersion } from '../src/services/plans.js';
import { referenceMapping } from './fixtures.js';

let clock = Date.parse('2026-01-01T00:00:00.000Z');
/** Deterministic, strictly increasing clock so ordering assertions are stable. */
export const tick = () => new Date((clock += 1000)).toISOString();

export function makeCtx(opts: { config?: Partial<Config>; llm?: AgentLlm | null } = {}): AppContext {
  const config = loadConfig({}, { databasePath: ':memory:', logLevel: 'silent', executionBatchSize: 25, ...opts.config });
  return createContext({ config, logger: createLogger('silent'), llm: opts.llm ?? null, now: tick });
}

/** Creates v1 from the reference mapping, dry-runs it and approves it. */
export function approvedPlan(ctx: AppContext) {
  const plan = createPlanVersion(ctx, { mapping: referenceMapping, origin: 'user', status: 'draft', actor: 'tester' });
  const dry = runDryRun(ctx, plan.version, 'tester');
  const approval = approvePlan(ctx, plan.version, { confirm: true, comment: 'ok' }, 'approver');
  return { plan, dry, approval };
}
