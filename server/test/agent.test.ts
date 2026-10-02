import { describe, expect, it } from 'vitest';
import type { AgentLlm, LlmBlock, LlmRequest, LlmResponse } from '../src/agent/llm.js';
import { getAgentEvents, getAgentRun, startAgentRun, waitForAgentRuns } from '../src/agent/runner.js';
import { TOOL_DEFS, TOOL_NAMES, runTool } from '../src/agent/tools.js';
import { AppError } from '../src/errors.js';
import { listClarifications, answerClarification } from '../src/services/clarifications.js';
import { listAudit } from '../src/services/audit.js';
import { approvalReadiness, listApprovals } from '../src/services/approvals.js';
import { listExecutions } from '../src/services/executions.js';
import { getPlan, listPlans } from '../src/services/plans.js';
import { countTarget } from '../src/services/targetStore.js';
import { makeCtx } from './helpers.js';
import { referenceMapping } from './fixtures.js';

const toolUse = (id: string, name: string, input: unknown): LlmBlock => ({ type: 'tool_use', id, name, input });
const reply = (content: LlmBlock[], stopReason = 'tool_use', usage = { inputTokens: 1000, outputTokens: 200 }): LlmResponse => ({ content, stopReason, stopCategory: null, usage, model: 'fake-model' });

class ScriptedLlm implements AgentLlm {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<(req: LlmRequest) => LlmResponse | Promise<LlmResponse>>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    // snapshot: the runner keeps appending to the same messages array
    this.requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    const step = this.script[this.requests.length - 1];
    if (!step) throw new Error('script exhausted');
    return step(req);
  }
}

const proposal = (over: Record<string, unknown> = {}) => ({
  mapping: referenceMapping,
  analysis: {
    summary: 'Mapped everything; 49 of 150 quarantined.',
    missingTargetFields: [{ field: 'currency', issue: 'absent in source', proposedResolution: 'constant INR pending confirmation' }],
    incompatibilities: [],
    risks: [{ severity: 'high', title: 'Currency assumed', detail: 'No currency in source', affectedFields: ['currency'], mitigation: 'confirm with finance' }],
    migrationPlan: { batchSize: 25, steps: ['dry run', 'approve', 'execute', 'reconcile'], rollbackCriteria: ['reconciliation fails'] },
  },
  clarificationQuestions: [{ field: 'currency', question: 'Which currency are legacy balances in?', options: ['INR', 'USD'], proposedAssumption: 'INR', blocking: true }],
  ...over,
});

const llmCtx = (llm: AgentLlm, config = {}) => makeCtx({ llm, config: { agent: { mode: 'llm', apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', serverFallbacks: true, maxIterations: 6, maxTokens: 16000, runLimitPerHour: 20, ...config } } });

describe('agent tool surface', () => {
  it('exposes inspection/validation tools only: nothing that can approve, execute, roll back or write', () => {
    expect([...TOOL_NAMES].sort()).toEqual(['dry_run_summary', 'get_sample_records', 'get_source_schema', 'get_target_schema', 'list_transformation_rules', 'preview_transform', 'profile_source_field', 'submit_proposal', 'validate_mapping']);
    for (const bad of ['approve', 'execute', 'rollback', 'retry', 'insert', 'write', 'delete', 'create_plan']) expect(TOOL_NAMES.some((n) => n.includes(bad))).toBe(false);
    for (const t of TOOL_DEFS) expect(t.input_schema.type).toBe('object');
  });

  it('every read tool leaves all persistent state untouched', () => {
    const ctx = makeCtx();
    const snapshot = () => ({
      plans: listPlans(ctx).length,
      target: countTarget(ctx.db, ctx.target),
      audit: listAudit(ctx, { limit: 1, offset: 0 }).total,
      dry: (ctx.db.prepare('SELECT COUNT(*) AS n FROM dry_runs').get() as { n: number }).n,
      records: (ctx.db.prepare('SELECT COUNT(*) AS n FROM run_records').get() as { n: number }).n,
    });
    const before = snapshot();
    const calls: Array<[string, unknown]> = [
      ['get_source_schema', {}],
      ['get_target_schema', {}],
      ['list_transformation_rules', {}],
      ['get_sample_records', { limit: 3 }],
      ['profile_source_field', { field: 'phone' }],
      ['validate_mapping', { mapping: referenceMapping }],
      ['preview_transform', { mapping: referenceMapping, onlyFailures: true }],
      ['dry_run_summary', { mapping: referenceMapping }],
    ];
    for (const [name, input] of calls) expect(runTool(ctx, name, input).isError, name).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('returns structured errors, not exceptions, for bad input and unknown tools', () => {
    const ctx = makeCtx();
    expect(runTool(ctx, 'profile_source_field', { field: 'nope' }).isError).toBe(true);
    expect(runTool(ctx, 'get_sample_records', { limit: 999 }).isError).toBe(true);
    expect(runTool(ctx, 'validate_mapping', { mapping: 'x' }).isError).toBe(true);
    const unknown = runTool(ctx, 'approve_plan', { version: 1 });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.output)).toContain('Unknown tool');
  });

  it('profiles show shapes and full distinct values for low-cardinality fields', () => {
    const ctx = makeCtx();
    const status = runTool(ctx, 'profile_source_field', { field: 'status_code' }).output as { allDistinctValues: Array<{ value: string }>; nullCount: number; blankCount: number };
    expect(status.allDistinctValues.map((v) => v.value)).toEqual(expect.arrayContaining(['A', 'I', 'S', 'X', 'Z']));
    expect(status.nullCount + status.blankCount).toBeGreaterThan(0);
    const phone = runTool(ctx, 'profile_source_field', { field: 'phone' }).output as { commonShapes: unknown[] };
    expect(phone.commonShapes.length).toBeGreaterThan(1);
  });

  it('submit_proposal refuses invalid mappings and un-questioned assumptions, and accepts a good proposal', () => {
    const ctx = makeCtx();
    const noTier = { ...referenceMapping, fields: referenceMapping.fields.filter((f) => f.target !== 'tier') };
    const r1 = runTool(ctx, 'submit_proposal', proposal({ mapping: noTier }));
    expect(r1.isError).toBe(true);
    expect(JSON.stringify(r1.output)).toContain('REQUIRED_TARGET_UNMAPPED');

    const r2 = runTool(ctx, 'submit_proposal', proposal({ clarificationQuestions: [] }));
    expect(r2.isError).toBe(true);
    expect(JSON.stringify(r2.output)).toContain('currency');

    const r3 = runTool(ctx, 'submit_proposal', proposal());
    expect(r3.isError).toBe(false);
    expect(r3.proposal?.mapping.fields.length).toBe(referenceMapping.fields.length);
  });
});

describe('LLM agent loop (scripted model)', () => {
  it('inspects, validates, submits — and ends as a PROPOSED version awaiting a human', async () => {
    const llm = new ScriptedLlm([
      () => reply([{ type: 'thinking', thinking: 'Look at the schemas first.', signature: 'sig' }, { type: 'text', text: 'Inspecting.' }, toolUse('t1', 'get_source_schema', {}), toolUse('t2', 'get_target_schema', {}), toolUse('t3', 'profile_source_field', { field: 'phone' })]),
      () => reply([toolUse('t4', 'validate_mapping', { mapping: referenceMapping }), toolUse('t5', 'dry_run_summary', { mapping: referenceMapping })]),
      () => reply([toolUse('t6', 'submit_proposal', proposal())]),
    ]);
    const ctx = llmCtx(llm);
    const started = startAgentRun(ctx, { kind: 'propose', instructions: 'Be careful with phones.' }, 'alice');
    expect(started.mode).toBe('llm');
    expect(started.status).toBe('running');
    await waitForAgentRuns();

    const run = getAgentRun(ctx, started.id);
    expect(run).toMatchObject({ status: 'succeeded', resultVersion: 1, inputTokens: 3000, outputTokens: 600, model: 'claude-opus-5-5' });

    const plan = getPlan(ctx, 1);
    expect(plan).toMatchObject({ status: 'proposed', origin: 'agent', createdBy: 'agent:claude-opus-5-5', agentRunId: started.id });
    expect(plan.analysis?.risks[0]?.title).toBe('Currency assumed');
    expect(listClarifications(ctx)).toHaveLength(1);

    // nothing beyond a proposal happened
    expect(listApprovals(ctx)).toHaveLength(0);
    expect(listExecutions(ctx)).toHaveLength(0);
    expect(countTarget(ctx.db, ctx.target)).toBe(5);
    expect(approvalReadiness(ctx, 1).ready).toBe(false);

    // trace: every tool call and result is recorded with timing
    const events = getAgentEvents(ctx, started.id);
    const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
    expect(calls).toEqual(['get_source_schema', 'get_target_schema', 'profile_source_field', 'validate_mapping', 'dry_run_summary', 'submit_proposal']);
    expect(events.filter((e) => e.type === 'tool_result').every((e) => e.durationMs !== null)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['start', 'thinking', 'assistant_text', 'proposal', 'end']));

    // protocol: system prompt + the full tool list sent; assistant turns echoed back verbatim; results in ONE user message
    const second = llm.requests[1]!;
    expect(second.system).toMatch(/cannot approve a plan/i);
    expect(second.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    const assistantTurn = second.messages[1]!;
    expect(assistantTurn.role).toBe('assistant');
    expect((assistantTurn.content as LlmBlock[]).some((b) => b.type === 'thinking')).toBe(true);
    const results = second.messages[2]!.content as LlmBlock[];
    expect(results.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'tool_result']);
    expect(second.messages[0]!.content as string).toContain('Be careful with phones.');
    expect(llm.requests[0]!.effort).toBe('medium');
  });

  it('feeds validation errors back so the model can correct itself', async () => {
    const bad = proposal({ mapping: { ...referenceMapping, fields: referenceMapping.fields.filter((f) => f.target !== 'status') } });
    const llm = new ScriptedLlm([() => reply([toolUse('a', 'submit_proposal', bad)]), () => reply([toolUse('b', 'submit_proposal', proposal())])]);
    const ctx = llmCtx(llm);
    startAgentRun(ctx, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    const feedback = llm.requests[1]!.messages.at(-1)!.content as LlmBlock[];
    expect(feedback[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a', is_error: true });
    expect(String(feedback[0]!.content)).toContain('REQUIRED_TARGET_UNMAPPED');
    expect(getPlan(ctx, 1).status).toBe('proposed');
  });

  it('is not steered by instructions embedded in data: a hostile tool-call to approve/execute does nothing', async () => {
    const llm = new ScriptedLlm([
      () => reply([toolUse('a', 'get_sample_records', { limit: 10 }), toolUse('x', 'approve_plan', { version: 1 }), toolUse('y', 'execute_migration', { force: true })]),
      () => reply([toolUse('b', 'submit_proposal', proposal())]),
    ]);
    const ctx = llmCtx(llm);
    startAgentRun(ctx, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    const feedback = llm.requests[1]!.messages.at(-1)!.content as LlmBlock[];
    expect(feedback.filter((b) => b.is_error).map((b) => b.tool_use_id)).toEqual(['x', 'y']);
    expect(listApprovals(ctx)).toHaveLength(0);
    expect(listExecutions(ctx)).toHaveLength(0);
    expect(getPlan(ctx, 1).status).toBe('proposed');
  });

  it('revise runs carry the base mapping and the reviewer’s answers, and link to the parent version', async () => {
    const first = new ScriptedLlm([() => reply([toolUse('a', 'submit_proposal', proposal())])]);
    const ctx = llmCtx(first);
    startAgentRun(ctx, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    answerClarification(ctx, 'Q1', { answer: 'USD' }, 'bob');

    const revised = new ScriptedLlm([() => reply([toolUse('a', 'submit_proposal', proposal({ clarificationQuestions: [{ field: 'currency', question: 'Confirm USD with finance?', blocking: false }] }))])]);
    ctx.llm = revised;
    startAgentRun(ctx, { kind: 'revise', baseVersion: 1, instructions: 'Use the answers.' }, 'alice');
    await waitForAgentRuns();
    const prompt = revised.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain('version 1');
    expect(prompt).toContain('ANSWER (answered): USD');
    expect(prompt).toContain('"target":"currency"');
    expect(getPlan(ctx, 2)).toMatchObject({ parentVersion: 1, origin: 'agent', status: 'proposed' });
  });

  it.each([
    ['refusal', () => ({ ...reply([], 'refusal'), stopCategory: 'cyber' }), /declined/],
    ['max_tokens', () => reply([{ type: 'text', text: 'partial' }], 'max_tokens'), /output tokens/],
    ['no proposal', () => reply([{ type: 'text', text: 'I am done.' }], 'end_turn'), /without submitting/],
  ])('fails cleanly when the model %s — no plan is created', async (_name, step, message) => {
    const llm = new ScriptedLlm(Array.from({ length: 6 }, () => step));
    const ctx = llmCtx(llm);
    const { id } = startAgentRun(ctx, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    const run = getAgentRun(ctx, id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(message);
    expect(listPlans(ctx)).toHaveLength(0);
    expect(getAgentEvents(ctx, id).at(-1)).toMatchObject({ type: 'end', payload: { status: 'failed' } });
  });

  it('stops after the iteration cap instead of looping forever', async () => {
    const llm = new ScriptedLlm(Array.from({ length: 10 }, (_, i) => () => reply([toolUse(`t${i}`, 'get_source_schema', {})])));
    const ctx = llmCtx(llm, { maxIterations: 3 });
    const { id } = startAgentRun(ctx, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    expect(getAgentRun(ctx, id)).toMatchObject({ status: 'failed', error: expect.stringContaining('within 3 steps') });
    expect(llm.requests).toHaveLength(3);
  });

  it('records an API failure without leaking anything sensitive', async () => {
    const llm: AgentLlm = { complete: async () => { throw new Error('socket hang up'); } };
    const ctx = llmCtx(llm);
    const { id } = startAgentRun(ctx, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    const run = getAgentRun(ctx, id);
    expect(run.status).toBe('failed');
    expect(JSON.stringify(getAgentEvents(ctx, id))).not.toContain('test-key');
    expect(listAudit(ctx, { limit: 5, offset: 0, event: 'agent.run.failed' }).total).toBe(1);
  });

  it('allows one run at a time and enforces the hourly cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new ScriptedLlm([async () => { await gate; return reply([toolUse('a', 'submit_proposal', proposal())]); }]);
    const ctx = llmCtx(llm);
    startAgentRun(ctx, { kind: 'propose' }, 'alice');
    let err: unknown;
    try { startAgentRun(ctx, { kind: 'propose' }, 'bob'); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 409, code: 'AGENT_BUSY' });
    release();
    await waitForAgentRuns();

    const capped = llmCtx(new ScriptedLlm([() => reply([toolUse('a', 'submit_proposal', proposal())])]), { runLimitPerHour: 1 });
    startAgentRun(capped, { kind: 'propose' }, 'alice');
    await waitForAgentRuns();
    expect(() => startAgentRun(capped, { kind: 'propose' }, 'alice')).toThrowError(expect.objectContaining({ status: 429 }));
  });

  it('refuses to start in llm mode when no client is configured', () => {
    const ctx = makeCtx({ llm: null, config: { agent: { mode: 'llm', apiKey: undefined, model: 'm', effort: 'medium', serverFallbacks: true, maxIterations: 5, maxTokens: 8000, runLimitPerHour: 5 } } });
    expect(() => startAgentRun(ctx, { kind: 'propose' }, 'a')).toThrowError(expect.objectContaining({ status: 503, code: 'AGENT_UNAVAILABLE' }));
    expect(AppError).toBeDefined();
  });
});

describe('rule-based fallback engine', () => {
  it('produces a valid, honest proposal through the same tools and gate — and never approves anything', async () => {
    const ctx = makeCtx(); // no key → heuristic
    const run = startAgentRun(ctx, { kind: 'propose' }, 'alice');
    expect(run.mode).toBe('heuristic');
    await waitForAgentRuns();
    expect(getAgentRun(ctx, run.id).status).toBe('succeeded');

    const plan = getPlan(ctx, 1);
    expect(plan).toMatchObject({ status: 'proposed', origin: 'agent', createdBy: 'agent:heuristic' });
    expect(plan.analysis!.summary).toMatch(/Rule-based proposal \(no LLM\)/);
    expect(plan.mapping.fields.find((f) => f.target === 'currency')).toMatchObject({ source: null, risk: 'high' });
    expect(plan.mapping.unmappedSource.map((u) => u.field)).toEqual(['notes']);

    const blocking = listClarifications(ctx).filter((q) => q.blocking).map((q) => q.field).sort();
    expect(blocking).toEqual(['currency', 'marketing_opt_in', 'tier']);
    expect(plan.analysis!.risks.map((r) => r.title).join('|')).toMatch(/mis-prefixed/);
    expect(plan.analysis!.risks.map((r) => r.title).join('|')).toMatch(/Instruction-like text/);

    const tools = getAgentEvents(ctx, run.id).filter((e) => e.type === 'tool_call').map((e) => e.name);
    expect(tools).toEqual(expect.arrayContaining(['get_source_schema', 'profile_source_field', 'validate_mapping', 'dry_run_summary', 'submit_proposal']));
    expect(listApprovals(ctx)).toHaveLength(0);
  });

  it('is deterministic: two runs propose the same executable mapping', async () => {
    const a = makeCtx();
    const b = makeCtx();
    startAgentRun(a, { kind: 'propose' }, 'x');
    startAgentRun(b, { kind: 'propose' }, 'x');
    await waitForAgentRuns();
    expect(getPlan(a, 1).mappingHash).toBe(getPlan(b, 1).mappingHash);
  });
});
