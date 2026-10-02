import type { Config } from './config.js';
import type { Db } from './db/connection.js';
import type { SourceSchema, TargetSchema } from './domain/types.js';
import type { Logger } from './logger.js';
import type { AgentLlm } from './agent/llm.js';

export interface AppContext {
  db: Db;
  config: Config;
  logger: Logger;
  source: SourceSchema;
  target: TargetSchema;
  now: () => string;
  /** Injected model client. null means "no API key": the heuristic engine is used instead. */
  llm: AgentLlm | null;
}
