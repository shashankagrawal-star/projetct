/**
 * Live check of the LLM agent against the real Anthropic API.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run agent:smoke
 *
 * Runs one full "propose" against an in-memory database and prints the trace, token usage and a
 * summary of the proposal. Exits non-zero if the agent fails or produces an invalid proposal.
 * It costs a few cents of API usage. Nothing is persisted.
 */
import { createContext } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { getAgentEvents, getAgentRun, startAgentRun, waitForAgentRuns } from '../src/agent/runner.js';
import { getPlan } from '../src/services/plans.js';
import { validatePlan } from '../src/services/plans.js';
import { runDryRun } from '../src/services/dryRuns.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY to run the live agent smoke test.');
  process.exit(2);
}

const config = loadConfig(process.env, { databasePath: ':memory:', logLevel: 'warn' });
config.agent.mode = 'llm';
const ctx = createContext({ config, logger: createLogger('warn') });

console.log(`model=${config.agent.model} effort=${config.agent.effort} serverFallbacks=${config.agent.serverFallbacks}`);
const started = startAgentRun(ctx, { kind: 'propose' }, 'smoke-test');
const t0 = Date.now();
await waitForAgentRuns();
const run = getAgentRun(ctx, started.id);

for (const e of getAgentEvents(ctx, started.id)) {
  const detail = e.type === 'tool_call' ? JSON.stringify(e.payload).slice(0, 90) : e.type === 'tool_result' ? `${(e.payload as { isError: boolean }).isError ? 'ERROR' : 'ok'} (${e.durationMs} ms)` : JSON.stringify(e.payload).slice(0, 140);
  console.log(`${String(e.seq).padStart(3)} ${e.type.padEnd(14)} ${(e.name ?? '').padEnd(24)} ${detail}`);
}
console.log(`\nstatus=${run.status} tokens in/out=${run.inputTokens}/${run.outputTokens} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (run.status !== 'succeeded' || !run.resultVersion) {
  console.error(`FAILED: ${run.error}`);
  process.exit(1);
}
const plan = getPlan(ctx, run.resultVersion);
const validation = validatePlan(ctx, plan);
const dry = runDryRun(ctx, plan.version, 'smoke-test');
console.log(`proposal v${plan.version}: ${plan.mapping.fields.length} fields, ${plan.analysis?.risks.length} risks, valid=${validation.valid}`);
console.log(`dry run: ${JSON.stringify(dry.counts)}`);
console.log(`summary: ${plan.analysis?.summary}`);
process.exit(validation.valid ? 0 : 1);
