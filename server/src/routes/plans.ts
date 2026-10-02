import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { approvePlan, approvalReadiness, listApprovals, rejectPlan } from '../services/approvals.js';
import { answerClarification, listClarifications } from '../services/clarifications.js';
import { getDryRun, latestDryRun, listDryRuns, listRunRecords, runDryRun } from '../services/dryRuns.js';
import { createPlanVersion, diffPlans, getPlan, listPlans, validatePlan } from '../services/plans.js';
import { h, intParam, pageQuery, parseBody, str } from './helpers.js';

export function planRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/plans', h(() =>
    listPlans(ctx).map((p) => {
      const v = validatePlan(ctx, p);
      const dry = latestDryRun(ctx, p.version);
      return { ...p, validation: { valid: v.valid, errors: v.errors.length, warnings: v.warnings.length }, latestDryRun: dry && { id: dry.id, counts: dry.counts, createdAt: dry.createdAt } };
    }),
  ));

  r.get('/plans/:version', h((req) => {
    const plan = getPlan(ctx, intParam(req.params.version, 'version'));
    return { plan, validation: validatePlan(ctx, plan), readiness: approvalReadiness(ctx, plan.version), dryRuns: listDryRuns(ctx, plan.version), approvals: listApprovals(ctx, plan.version) };
  }));

  r.get('/plans/:version/readiness', h((req) => approvalReadiness(ctx, intParam(req.params.version, 'version'))));

  r.get('/plans/:from/diff/:to', h((req) => diffPlans(getPlan(ctx, intParam(req.params.from, 'from')), getPlan(ctx, intParam(req.params.to, 'to')))));

  r.post('/plans', h((req, res) => {
    const body = parseBody(z.object({ mapping: z.unknown(), parentVersion: z.number().int().positive().optional(), note: z.string().max(500).optional() }), req.body);
    const parent = body.parentVersion ? getPlan(ctx, body.parentVersion) : null;
    const plan = createPlanVersion(ctx, { mapping: body.mapping, analysis: parent?.analysis ?? null, origin: 'user', status: 'draft', parentVersion: body.parentVersion ?? null, note: body.note ?? null, actor: req.actor });
    res.status(201).json({ plan, validation: validatePlan(ctx, plan) });
  }));

  r.post('/plans/:version/dry-run', h((req, res) => {
    const summary = runDryRun(ctx, intParam(req.params.version, 'version'), req.actor);
    res.status(201).json(summary);
  }));

  r.post('/plans/:version/approve', h((req) => {
    const body = parseBody(z.object({ comment: z.string().max(1000).optional(), confirm: z.boolean() }), req.body);
    return approvePlan(ctx, intParam(req.params.version, 'version'), body, req.actor);
  }));

  r.post('/plans/:version/reject', h((req) => {
    const body = parseBody(z.object({ comment: z.string().max(1000).optional() }), req.body);
    return rejectPlan(ctx, intParam(req.params.version, 'version'), body, req.actor);
  }));

  r.get('/clarifications', h(() => listClarifications(ctx)));
  r.post('/clarifications/:qid/answer', h((req) => {
    const body = parseBody(z.object({ answer: z.string().max(1000).optional(), acceptAssumption: z.boolean().optional(), dismiss: z.boolean().optional() }), req.body);
    return answerClarification(ctx, String(req.params.qid), body, req.actor);
  }));

  r.get('/dry-runs', h((req) => listDryRuns(ctx, req.query.planVersion ? intParam(req.query.planVersion, 'planVersion') : undefined)));
  r.get('/dry-runs/:id', h((req) => getDryRun(ctx, intParam(req.params.id, 'id'))));
  r.get('/dry-runs/:id/records', h((req) => {
    const { limit, offset } = pageQuery(req);
    const id = intParam(req.params.id, 'id');
    getDryRun(ctx, id);
    return listRunRecords(ctx, 'dry_run', id, { limit, offset, ...(str(req.query.status) ? { status: str(req.query.status)! } : {}), ...(str(req.query.code) ? { code: str(req.query.code)! } : {}), ...(str(req.query.q) ? { q: str(req.query.q)! } : {}) });
  }));

  return r;
}
