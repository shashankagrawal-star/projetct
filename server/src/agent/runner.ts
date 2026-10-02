import type { AppContext } from '../context.js';
import { resolveAgentMode } from '../config.js';
import { all, get, json, parse, run, transaction } from '../db/connection.js';
import type { Proposal } from '../domain/types.js';
import { AppError, conflict, notFound, tooMany } from '../errors.js';
import { audit } from '../services/audit.js';
import { addClarifications } from '../services/clarifications.js';
import { createPlanVersion, getPlan } from '../services/plans.js';
import { buildHeuristicProposal } from './heuristic.js';
import { explainLlmError, type LlmBlock, type LlmMessage } from './llm.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';
import { TOOL_DEFS, runTool, type ToolResult } from './tools.js';

export type AgentRunKind = 'propose' | 'revise';

export interface AgentEvent {
  seq: number;
  ts: string;
  type: 'start' | 'thinking' | 'assistant_text' | 'tool_call' | 'tool_result' | 'proposal' | 'warning' | 'error' | 'end';
  name: string | null;
  payload: unknown;
  durationMs: number | null;
}

export interface AgentRunView {
  id: number;
  kind: AgentRunKind;
  mode: 'llm' | 'heuristic';
  model: string | null;
  status: 'running' | 'succeeded' | 'failed';
  instructions: string | null;
  baseVersion: number | null;
  resultVersion: number | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: number;
  kind: AgentRunKind;
  mode: 'llm' | 'heuristic';
  model: string | null;
  status: AgentRunView['status'];
  instructions: string | null;
  base_version: number | null;
  result_version: number | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  actor: string;
  started_at: string;
  finished_at: string | null;
}

const toView = (r: RunRow): AgentRunView => ({
  id: r.id,
  kind: r.kind,
  mode: r.mode,
  model: r.model,
  status: r.status,
  instructions: r.instructions,
  baseVersion: r.base_version,
  resultVersion: r.result_version,
  error: r.error,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  actor: r.actor,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function getAgentRun(ctx: AppContext, id: number): AgentRunView {
  const row = get<RunRow>(ctx.db, 'SELECT * FROM agent_runs WHERE id = ?', [id]);
  if (!row) throw notFound(`Agent run ${id}`);
  return toView(row);
}
export const listAgentRuns = (ctx: AppContext, limit = 20): AgentRunView[] => all<RunRow>(ctx.db, 'SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?', [limit]).map(toView);

export function getAgentEvents(ctx: AppContext, runId: number, afterSeq = 0): AgentEvent[] {
  return all<{ seq: number; ts: string; type: AgentEvent['type']; name: string | null; payload: string | null; duration_ms: number | null }>(
    ctx.db,
    'SELECT seq, ts, type, name, payload, duration_ms FROM agent_events WHERE run_id = ? AND seq > ? ORDER BY seq',
    [runId, afterSeq],
  ).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, name: e.name, payload: e.payload ? parse(e.payload) : null, durationMs: e.duration_ms }));
}

// ---- event recording -----------------------------------------------------------------------------
const MAX_PAYLOAD_CHARS = 20_000;
function clip(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_PAYLOAD_CHARS) return value ?? null;
  return { truncated: true, originalChars: text.length, preview: text.slice(0, 4000) };
}

class Recorder {
  private seq = 0;
  constructor(
    private readonly ctx: AppContext,
    readonly runId: number,
  ) {}
  emit(type: AgentEvent['type'], name: string | null, payload: unknown, durationMs: number | null = null): void {
    this.seq++;
    run(this.ctx.db, 'INSERT INTO agent_events (run_id, seq, ts, type, name, payload, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [this.runId, this.seq, this.ctx.now(), type, name, json(clip(payload)), durationMs]);
    this.ctx.logger.debug({ event: 'agent.event', runId: this.runId, seq: this.seq, type, name }, 'agent event');
  }
  /** Runs a tool, records the call and its result, and logs timing. */
  tool(name: string, input: unknown): ToolResult {
    this.emit('tool_call', name, input);
    const t0 = performance.now();
    const result = runTool(this.ctx, name, input);
    const ms = Math.round(performance.now() - t0);
    this.emit('tool_result', name, { isError: result.isError, output: result.output }, ms);
    this.ctx.logger.info({ event: 'agent.tool', runId: this.runId, tool: name, isError: result.isError, durationMs: ms }, `agent tool ${name}`);
    return result;
  }
}

// ---- public API ----------------------------------------------------------------------------------
export interface StartAgentInput {
  kind: AgentRunKind;
  instructions?: string;
  baseVersion?: number;
}

const inflight = new Set<Promise<void>>();
/** Lets tests and graceful shutdown wait for background runs. */
export const waitForAgentRuns = async (): Promise<void> => {
  await Promise.allSettled([...inflight]);
};

export function startAgentRun(ctx: AppContext, input: StartAgentInput, actor: string): AgentRunView {
  const mode = resolveAgentMode(ctx.config);
  if (mode === 'llm' && !ctx.llm) {
    throw new AppError(503, 'AGENT_UNAVAILABLE', 'AGENT_MODE=llm but no ANTHROPIC_API_KEY is configured on the server.');
  }
  if (input.kind === 'revise') {
    if (!input.baseVersion) throw new AppError(400, 'BAD_REQUEST', 'baseVersion is required to revise a plan');
    getPlan(ctx, input.baseVersion);
  }
  if (get<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'")!.n > 0) {
    throw conflict('An agent run is already in progress. Wait for it to finish.', undefined, 'AGENT_BUSY');
  }
  if (mode === 'llm') {
    const since = new Date(Date.parse(ctx.now()) - 3600_000).toISOString();
    const recent = get<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM agent_runs WHERE mode = 'llm' AND started_at > ?", [since])!.n;
    if (recent >= ctx.config.agent.runLimitPerHour) throw tooMany(`Agent run limit reached (${ctx.config.agent.runLimitPerHour} per hour). Try again later.`);
  }

  const model = mode === 'llm' ? ctx.config.agent.model : null;
  const res = run(
    ctx.db,
    `INSERT INTO agent_runs (kind, mode, model, status, instructions, base_version, actor, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    [input.kind, mode, model, input.instructions?.trim() || null, input.baseVersion ?? null, actor, ctx.now()],
  );
  const runId = res.lastInsertRowid;
  audit(ctx, actor, 'agent.run.started', 'agent_run', runId, { kind: input.kind, mode, model, baseVersion: input.baseVersion ?? null });
  ctx.logger.info({ event: 'agent.run.started', runId, mode, model, kind: input.kind }, 'agent run started');

  const p = executeRun(ctx, runId, mode, input, actor).finally(() => inflight.delete(p));
  inflight.add(p);
  return getAgentRun(ctx, runId);
}

/** On boot: a run left 'running' by a crash can never finish. */
export function recoverInterruptedAgentRuns(ctx: AppContext): number {
  const stuck = run(ctx.db, "UPDATE agent_runs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ? WHERE status = 'running'", [ctx.now()]);
  return stuck.changes;
}

// ---- execution -----------------------------------------------------------------------------------
async function executeRun(ctx: AppContext, runId: number, mode: 'llm' | 'heuristic', input: StartAgentInput, actor: string): Promise<void> {
  const rec = new Recorder(ctx, runId);
  const started = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    rec.emit('start', null, { mode, model: mode === 'llm' ? ctx.config.agent.model : null, kind: input.kind, baseVersion: input.baseVersion ?? null, instructions: input.instructions ?? null });

    let proposal: Proposal;
    if (mode === 'heuristic') {
      rec.emit('assistant_text', null, { text: 'Running the rule-based fallback engine (no LLM). It uses the same inspection tools and the same submit gate.' });
      const draft = buildHeuristicProposal(ctx, (name, args) => rec.tool(name, args));
      const submit = rec.tool('submit_proposal', draft);
      if (submit.isError || !submit.proposal) throw new AgentRunError(`The rule-based proposal was rejected by the submit gate: ${JSON.stringify(submit.output).slice(0, 500)}`);
      proposal = submit.proposal;
    } else {
      const res = await runLlmLoop(ctx, rec, input);
      proposal = res.proposal;
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
    }

    const actorLabel = mode === 'llm' ? `agent:${ctx.config.agent.model}` : 'agent:heuristic';
    const version = transaction(ctx.db, () => {
      const plan = createPlanVersion(ctx, {
        mapping: proposal.mapping,
        analysis: proposal.analysis,
        origin: 'agent',
        status: 'proposed',
        parentVersion: input.baseVersion ?? null,
        note: input.instructions?.trim() || null,
        agentRunId: runId,
        actor: actorLabel,
      });
      addClarifications(ctx, plan.version, proposal.clarificationQuestions, actorLabel);
      return plan.version;
    });

    rec.emit('proposal', null, { version, fields: proposal.mapping.fields.length, risks: proposal.analysis.risks.length, questions: proposal.clarificationQuestions.length });
    rec.emit('end', null, { status: 'succeeded', durationMs: Math.round(performance.now() - started) });
    run(ctx.db, "UPDATE agent_runs SET status = 'succeeded', result_version = ?, input_tokens = ?, output_tokens = ?, finished_at = ? WHERE id = ?", [version, inputTokens, outputTokens, ctx.now(), runId]);
    audit(ctx, actor, 'agent.run.completed', 'agent_run', runId, { version, mode, inputTokens, outputTokens });
    ctx.logger.info({ event: 'agent.run.completed', runId, version, mode, inputTokens, outputTokens, durationMs: Math.round(performance.now() - started) }, 'agent run completed');
  } catch (err) {
    const message = err instanceof AgentRunError ? err.message : explainLlmError(err);
    ctx.logger.error({ event: 'agent.run.failed', runId, error: message, cause: err instanceof Error ? err.message : String(err) }, 'agent run failed');
    try {
      rec.emit('error', null, { message });
      rec.emit('end', null, { status: 'failed' });
      run(ctx.db, "UPDATE agent_runs SET status = 'failed', error = ?, input_tokens = ?, output_tokens = ?, finished_at = ? WHERE id = ?", [message, inputTokens, outputTokens, ctx.now(), runId]);
      audit(ctx, actor, 'agent.run.failed', 'agent_run', runId, { error: message });
    } catch (inner) {
      ctx.logger.error({ event: 'agent.run.record_failed', runId, error: String(inner) }, 'could not record agent failure');
    }
  }
}

class AgentRunError extends Error {}

const MAX_TOOL_OUTPUT_CHARS = 30_000;
const asToolContent = (output: unknown): string => {
  const text = JSON.stringify(output);
  return text.length <= MAX_TOOL_OUTPUT_CHARS ? text : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}… [truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars; call the tool with narrower input]`;
};

async function runLlmLoop(ctx: AppContext, rec: Recorder, input: StartAgentInput): Promise<{ proposal: Proposal; inputTokens: number; outputTokens: number }> {
  const llm = ctx.llm!;
  const cfg = ctx.config.agent;
  const messages: LlmMessage[] = [{ role: 'user', content: buildUserPrompt(ctx, { kind: input.kind, ...(input.instructions ? { instructions: input.instructions } : {}), ...(input.baseVersion ? { baseVersion: input.baseVersion } : {}) }) }];
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  let inputTokens = 0;
  let outputTokens = 0;
  let nudges = 0;

  for (let iteration = 1; iteration <= cfg.maxIterations; iteration++) {
    const t0 = performance.now();
    const res = await llm.complete(
      { model: cfg.model, system: SYSTEM_PROMPT, messages, tools: TOOL_DEFS, maxTokens: cfg.maxTokens, effort: cfg.effort, serverFallbacks: cfg.serverFallbacks },
      signal,
    );
    inputTokens += res.usage.inputTokens;
    outputTokens += res.usage.outputTokens;
    const ms = Math.round(performance.now() - t0);
    ctx.logger.info({ event: 'agent.llm_call', runId: rec.runId, iteration, model: res.model, stopReason: res.stopReason, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, durationMs: ms }, 'agent llm call');

    for (const block of res.content) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) rec.emit('thinking', null, { text: block.thinking.slice(0, 2000) });
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) rec.emit('assistant_text', null, { text: block.text.slice(0, 4000), iteration }, ms);
      if (block.type === 'fallback') rec.emit('warning', null, { message: 'The server switched to a fallback model for this turn.', block });
    }

    if (res.stopReason === 'refusal') throw new AgentRunError(`The model declined this request${res.stopCategory ? ` (category: ${res.stopCategory})` : ''}. No proposal was produced.`);
    if (res.stopReason === 'max_tokens') throw new AgentRunError('The model ran out of output tokens before finishing. Raise AGENT_MAX_TOKENS.');

    // Echo the assistant turn back verbatim (thinking blocks included): the API requires it for tool use.
    messages.push({ role: 'assistant', content: res.content });

    const toolUses = res.content.filter((b): b is LlmBlock & { id: string; name: string; input: unknown } => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string');
    if (toolUses.length === 0) {
      if (nudges++ >= 2) throw new AgentRunError('The model stopped without submitting a proposal.');
      messages.push({ role: 'user', content: 'You have not called submit_proposal yet. Finish the analysis and call submit_proposal with a complete, valid proposal.' });
      continue;
    }

    const results: LlmBlock[] = [];
    let accepted: Proposal | undefined;
    for (const tu of toolUses) {
      const result = rec.tool(tu.name, tu.input);
      if (result.proposal) accepted = result.proposal;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: asToolContent(result.output), ...(result.isError ? { is_error: true } : {}) });
    }
    if (accepted) return { proposal: accepted, inputTokens, outputTokens };
    messages.push({ role: 'user', content: results });
  }
  throw new AgentRunError(`The agent did not submit a proposal within ${cfg.maxIterations} steps.`);
}
