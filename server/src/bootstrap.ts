import type { Config } from './config.js';
import { resolveAgentMode } from './config.js';
import type { AppContext } from './context.js';
import { AnthropicLlm, type AgentLlm } from './agent/llm.js';
import { recoverInterruptedAgentRuns } from './agent/runner.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/schema.js';
import { loadSchemas, seed } from './db/seed.js';
import type { Logger } from './logger.js';
import { recoverInterruptedExecutions } from './services/executions.js';

export interface BootOptions {
  config: Config;
  logger: Logger;
  llm?: AgentLlm | null;
  now?: () => string;
}

/** Builds the application context: opens + migrates + seeds the database and wires the optional LLM client. */
export function createContext({ config, logger, llm, now }: BootOptions): AppContext {
  const db = openDatabase(config.databasePath);
  const { source, target } = loadSchemas(config.dataDir);
  migrate(db, target);

  const resolvedLlm = llm !== undefined ? llm : config.agent.apiKey && resolveAgentMode(config) === 'llm' ? new AnthropicLlm(config.agent.apiKey, logger) : null;
  const ctx: AppContext = { db, config, logger, source, target, now: now ?? (() => new Date().toISOString()), llm: resolvedLlm };

  seed(ctx);
  const execs = recoverInterruptedExecutions(ctx);
  const runs = recoverInterruptedAgentRuns(ctx);
  if (execs || runs) logger.warn({ event: 'boot.recovered', executions: execs, agentRuns: runs }, 'recovered interrupted work from a previous process');
  return ctx;
}
