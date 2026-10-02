import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { waitForAgentRuns } from '../src/agent/runner.js';
import { createApp } from '../src/app.js';
import { makeCtx } from './helpers.js';
import { referenceMapping } from './fixtures.js';

const setup = (opts: Parameters<typeof makeCtx>[0] = {}) => {
  const ctx = makeCtx(opts);
  return { ctx, api: request(createApp(ctx)) };
};
const as = (name: string) => ({ 'x-actor': name });

describe('API basics and error contract', () => {
  it('health, config and reference data', async () => {
    const { api } = setup();
    expect((await api.get('/api/health')).body.status).toBe('ok');
    const cfg = (await api.get('/api/config')).body;
    expect(cfg).toMatchObject({ agent: { mode: 'heuristic', available: true }, maxSampleSize: 500, sourceRecords: 150 });
    expect((await api.get('/api/source')).body.schema.fields).toHaveLength(13);
    expect((await api.get('/api/target')).body).toMatchObject({ total: 5, preExisting: 5, migrated: 0 });
    const rules = (await api.get('/api/rules')).body as Array<{ id: string }>;
    expect(rules.map((r) => r.id)).toContain('normalize_phone');
    const page = (await api.get('/api/source/records?limit=5&offset=10')).body;
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(150);
  });

  it('uses one error shape: 404, 400 validation, malformed JSON, unknown routes', async () => {
    const { api } = setup();
    expect((await api.get('/api/plans/99')).body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await api.get('/api/plans/abc')).status).toBe(400);
    const bad = await api.post('/api/plans').send({ parentVersion: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const malformed = await api.post('/api/plans').send({ mapping: { fields: 'no' } });
    expect(malformed.status).toBe(422);
    expect(malformed.body.error.code).toBe('MALFORMED_MAPPING');
    const json = await api.post('/api/plans').set('content-type', 'application/json').send('{not json');
    expect(json.status).toBe(400);
    expect(json.body.error.code).toBe('INVALID_JSON');
    expect((await api.get('/api/nope')).status).toBe(404);
  });

  it('validates an unsaved mapping for the editor without persisting anything', async () => {
    const { api, ctx } = setup();
    const ok = await api.post('/api/validate-mapping').send({ mapping: referenceMapping });
    expect(ok.body.valid).toBe(true);
    const bad = await api.post('/api/validate-mapping').send({ mapping: { ...referenceMapping, fields: [] } });
    expect(bad.body.valid).toBe(false);
    expect(bad.body.errors.map((e: { code: string }) => e.code)).toContain('REQUIRED_TARGET_UNMAPPED');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM plan_versions').get()).toEqual({ n: 0 });
  });

  it('sets standard hardening headers and never advertises the framework', async () => {
    const { api } = setup();
    const res = await api.get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('end-to-end through the HTTP API', () => {
  it('propose → answer → dry run → approve → execute (fail) → retry → reconcile → rollback', async () => {
    const { api } = setup();

    // 1. the agent proposes (rule-based engine in this environment)
    const started = await api.post('/api/agent/runs').set(as('alice')).send({ kind: 'propose' });
    expect(started.status).toBe(202);
    await waitForAgentRuns();
    const run = (await api.get(`/api/agent/runs/${started.body.id}`)).body;
    expect(run.run.status).toBe('succeeded');
    expect(run.events.some((e: { type: string }) => e.type === 'tool_call')).toBe(true);
    const plans = (await api.get('/api/plans')).body;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ version: 1, status: 'proposed', origin: 'agent' });

    // 2. nothing can be approved or run yet
    const dryRun = await api.post('/api/plans/1/dry-run').set(as('alice'));
    expect(dryRun.status).toBe(201);
    expect(dryRun.body.counts).toEqual({ source: 150, transformed: 130, accepted: 101, rejected: 49 });
    const early = await api.post('/api/plans/1/approve').set(as('bob')).send({ confirm: true });
    expect(early.status).toBe(409);
    expect(early.body.error.details.map((d: { code: string }) => d.code)).toEqual(['OPEN_QUESTIONS']);
    const noApproval = await api.post('/api/executions').send({ planVersion: 1, dryRunId: dryRun.body.id });
    expect(noApproval.status).toBe(409);
    expect(noApproval.body.error.code).toBe('NOT_APPROVED');

    // 3. human answers blocking questions, then approves
    const questions = (await api.get('/api/clarifications')).body as Array<{ qid: string; blocking: boolean; proposedAssumption: string | null }>;
    for (const q of questions.filter((x) => x.blocking)) {
      expect((await api.post(`/api/clarifications/${q.qid}/answer`).set(as('bob')).send({ acceptAssumption: true })).status).toBe(200);
    }
    const approved = await api.post('/api/plans/1/approve').set(as('bob')).send({ confirm: true, comment: 'checked quarantine' });
    expect(approved.body).toMatchObject({ decision: 'approved', actor: 'bob', dryRunId: dryRun.body.id });

    // 4. execute with an injected failure, using an Idempotency-Key header
    const key = 'e2e-idempotency-key-1';
    const failed = await api.post('/api/executions').set(as('carol')).set('Idempotency-Key', key).send({ planVersion: 1, dryRunId: dryRun.body.id, simulateFailureAfter: 40 });
    expect(failed.status).toBe(201);
    expect(failed.body.execution).toMatchObject({ status: 'failed', counts: { loaded: 25 } });
    const replay = await api.post('/api/executions').set('Idempotency-Key', key).send({ planVersion: 1, dryRunId: dryRun.body.id, simulateFailureAfter: 40 });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    const id = failed.body.execution.id as number;

    // 5. retry completes without duplicates; reconciliation passes
    const retried = await api.post(`/api/executions/${id}/retry`).set(as('carol')).send({});
    expect(retried.body.execution).toMatchObject({ status: 'completed', counts: { loaded: 101, duplicatesPrevented: 25, pending: 0 } });
    const recon = (await api.get(`/api/executions/${id}/reconciliation`)).body;
    expect(recon).toMatchObject({ status: 'pass', totals: { sourceTotal: 150, targetNow: 106, targetMigrated: 101, quarantined: 49 } });
    const rejected = (await api.get(`/api/executions/${id}/records?status=rejected&limit=5`)).body;
    expect(rejected.total).toBe(49);
    expect(rejected.records[0].errors[0]).toHaveProperty('sourceValue');

    // 6. rollback restores the baseline and everything is in the history
    const noReason = await api.post(`/api/executions/${id}/rollback`).send({});
    expect(noReason.status).toBe(400);
    const rolled = await api.post(`/api/executions/${id}/rollback`).set(as('dave')).send({ reason: 'e2e check' });
    expect(rolled.body.execution).toMatchObject({ status: 'rolled_back', rollbacks: [{ rowsRemoved: 101, targetRowsAfter: 5, actor: 'dave' }] });
    expect((await api.get('/api/target')).body.total).toBe(5);

    const history = (await api.get('/api/history?limit=100')).body;
    const byEvent = (e: string) => history.entries.filter((x: { event: string }) => x.event === e);
    expect(byEvent('plan.approved')[0].actor).toBe('bob');
    expect(byEvent('execution.retried')[0].actor).toBe('carol');
    expect(byEvent('execution.rolled_back')[0].actor).toBe('dave');
    expect(history.entries.map((x: { actor: string }) => x.actor)).not.toContain(undefined);

    const overview = (await api.get('/api/overview')).body;
    expect(overview.execution.status).toBe('rolled_back');
  });

  it('versions: an edit creates v2, the diff shows the change, v1 stays untouched', async () => {
    const { api } = setup();
    await api.post('/api/plans').set(as('alice')).send({ mapping: referenceMapping });
    const edited = JSON.parse(JSON.stringify(referenceMapping));
    edited.fields.find((f: { target: string }) => f.target === 'currency').steps = [{ rule: 'constant', params: { value: 'USD' } }];
    const v2 = await api.post('/api/plans').set(as('alice')).send({ mapping: edited, parentVersion: 1, note: 'finance says USD' });
    expect(v2.status).toBe(201);
    expect(v2.body.plan).toMatchObject({ version: 2, parentVersion: 1, status: 'draft', origin: 'user', note: 'finance says USD' });
    const diff = (await api.get('/api/plans/1/diff/2')).body;
    expect(diff.changes).toEqual([expect.objectContaining({ target: 'currency', change: 'modified' })]);
    expect((await api.get('/api/plans/1')).body.plan.mapping.fields.find((f: { target: string }) => f.target === 'currency').steps[0].params.value).toBe('INR');
  });

  it('a revise run needs a base version (400, standard error shape)', async () => {
    const { api } = setup();
    const res = await api.post('/api/agent/runs').send({ kind: 'revise' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect((await api.post('/api/agent/runs').send({ kind: 'revise', baseVersion: 42 })).status).toBe(404);
  });
});
