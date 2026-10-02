import { Router } from 'express';
import type { AppContext } from '../context.js';
import { resolveAgentMode } from '../config.js';
import { describeRules } from '../domain/rules.js';
import { validateMapping } from '../domain/mapping.js';
import { z } from 'zod';
import { mappingSpecSchema } from '../domain/types.js';
import { listAudit } from '../services/audit.js';
import { listClarifications, openBlocking } from '../services/clarifications.js';
import { latestDryRun } from '../services/dryRuns.js';
import { listExecutions } from '../services/executions.js';
import { listPlans } from '../services/plans.js';
import { reconcile } from '../services/reconciliation.js';
import { countSource, pageSource } from '../services/sourceStore.js';
import { countTarget, listTarget } from '../services/targetStore.js';
import { h, pageQuery, parseBody, str } from './helpers.js';

export function dataRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/health', h(() => ({ status: 'ok', time: ctx.now() })));

  r.get('/config', h(() => {
    const mode = resolveAgentMode(ctx.config);
    return {
      agent: { mode, model: mode === 'llm' ? ctx.config.agent.model : null, available: mode === 'heuristic' || ctx.llm !== null, configuredMode: ctx.config.agent.mode },
      maxSampleSize: ctx.config.maxSampleSize,
      executionBatchSize: ctx.config.executionBatchSize,
      allowFailureInjection: ctx.config.allowFailureInjection,
      sourceRecords: countSource(ctx.db),
    };
  }));

  r.get('/source', h(() => ({ schema: ctx.source, total: countSource(ctx.db) })));
  r.get('/source/records', h((req) => pageSource(ctx.db, pageQuery(req).limit, pageQuery(req).offset, str(req.query.q))));

  r.get('/target', h(() => ({
    schema: ctx.target,
    total: countTarget(ctx.db, ctx.target),
    preExisting: countTarget(ctx.db, ctx.target, 'execution_id IS NULL'),
    migrated: countTarget(ctx.db, ctx.target, 'execution_id IS NOT NULL'),
  })));
  r.get('/target/records', h((req) => {
    const origin = str(req.query.origin);
    const { limit, offset } = pageQuery(req);
    return listTarget(ctx.db, ctx.target, { limit, offset, origin: origin === 'seed' || origin === 'migrated' ? origin : 'all' });
  }));

  r.get('/rules', h(() => describeRules()));

  /** Structural validation of an unsaved mapping (used live by the editor). */
  r.post('/validate-mapping', h((req) => {
    const { mapping } = parseBody(z.object({ mapping: z.unknown() }), req.body);
    const parsed = mappingSpecSchema.safeParse(mapping);
    if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((i) => ({ severity: 'error', code: 'MALFORMED_MAPPING', message: `${i.path.join('.') || 'mapping'}: ${i.message}` })), warnings: [] };
    return validateMapping(parsed.data, ctx.source, ctx.target);
  }));

  r.get('/history', h((req) => {
    const { limit, offset } = pageQuery(req, { limit: 50, max: 200 });
    return listAudit(ctx, { limit, offset, ...(str(req.query.prefix) ? { prefix: str(req.query.prefix)! } : {}), ...(str(req.query.entityType) ? { entityType: str(req.query.entityType)! } : {}) });
  }));

  /** One call that drives the workflow stepper on the overview page. */
  r.get('/overview', h(() => {
    const plans = listPlans(ctx);
    const latest = plans[0] ?? null;
    const approved = plans.find((p) => p.status === 'approved') ?? null;
    const focus = approved ?? latest;
    const executions = listExecutions(ctx);
    const live = executions.find((e) => e.status !== 'rolled_back') ?? executions[0] ?? null;
    return {
      sourceRecords: countSource(ctx.db),
      target: { total: countTarget(ctx.db, ctx.target), preExisting: countTarget(ctx.db, ctx.target, 'execution_id IS NULL'), migrated: countTarget(ctx.db, ctx.target, 'execution_id IS NOT NULL') },
      plans: { count: plans.length, latest: latest && { version: latest.version, status: latest.status, origin: latest.origin }, approved: approved && { version: approved.version } },
      questions: { total: listClarifications(ctx).length, openBlocking: openBlocking(ctx).length },
      dryRun: focus ? latestDryRun(ctx, focus.version) : null,
      execution: live,
      reconciliation: live ? { status: reconcile(ctx, live.id).status, executionId: live.id } : null,
    };
  }));

  return r;
}
