import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getAgentEvents, getAgentRun, listAgentRuns, startAgentRun } from '../agent/runner.js';
import { getExecution, listExecutions, retryExecution, rollbackExecution, startExecution } from '../services/executions.js';
import { listRunRecords } from '../services/dryRuns.js';
import { reconcile } from '../services/reconciliation.js';
import { h, intParam, pageQuery, parseBody, str } from './helpers.js';

export function runRoutes(ctx: AppContext): Router {
  const r = Router();

  // ---- agent ---------------------------------------------------------------------------------
  r.post('/agent/runs', h((req, res) => {
    const body = parseBody(z.object({ kind: z.enum(['propose', 'revise']).default('propose'), instructions: z.string().max(2000).optional(), baseVersion: z.number().int().positive().optional() }), req.body);
    const run = startAgentRun(ctx, { kind: body.kind, ...(body.instructions ? { instructions: body.instructions } : {}), ...(body.baseVersion ? { baseVersion: body.baseVersion } : {}) }, req.actor);
    res.status(202).json(run);
  }));
  r.get('/agent/runs', h(() => listAgentRuns(ctx)));
  r.get('/agent/runs/:id', h((req) => {
    const id = intParam(req.params.id, 'id');
    return { run: getAgentRun(ctx, id), events: getAgentEvents(ctx, id, Number(req.query.after ?? 0) || 0) };
  }));

  // ---- executions ----------------------------------------------------------------------------
  r.get('/executions', h(() => listExecutions(ctx)));

  r.post('/executions', h((req, res) => {
    const body = parseBody(
      z.object({
        planVersion: z.number().int().positive(),
        dryRunId: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(100).optional(),
        simulateFailureAfter: z.number().int().min(1).max(10000).optional(),
      }),
      req.body,
    );
    const headerKey = str(req.header('idempotency-key'));
    const { execution, replay } = startExecution(ctx, { ...body, ...(body.idempotencyKey ? {} : headerKey ? { idempotencyKey: headerKey } : {}) }, req.actor);
    res.status(replay ? 200 : 201).json({ execution, idempotentReplay: replay });
  }));

  r.get('/executions/:id', h((req) => getExecution(ctx, intParam(req.params.id, 'id'))));

  r.get('/executions/:id/records', h((req) => {
    const { limit, offset } = pageQuery(req);
    const id = intParam(req.params.id, 'id');
    getExecution(ctx, id);
    return listRunRecords(ctx, 'execution', id, { limit, offset, ...(str(req.query.status) ? { status: str(req.query.status)! } : {}), ...(str(req.query.code) ? { code: str(req.query.code)! } : {}), ...(str(req.query.q) ? { q: str(req.query.q)! } : {}) });
  }));

  r.post('/executions/:id/retry', h((req) => {
    const body = parseBody(z.object({ simulateFailureAfter: z.number().int().min(1).max(10000).optional() }), req.body);
    return { execution: retryExecution(ctx, intParam(req.params.id, 'id'), body, req.actor) };
  }));

  r.post('/executions/:id/rollback', h((req) => {
    const body = parseBody(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return { execution: rollbackExecution(ctx, intParam(req.params.id, 'id'), body, req.actor) };
  }));

  r.get('/executions/:id/reconciliation', h((req) => reconcile(ctx, intParam(req.params.id, 'id'))));

  return r;
}
