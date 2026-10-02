import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url)); // server/src or server/dist
export const REPO_ROOT = join(here, '..', '..');

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_DIR: z.string().default(join(REPO_ROOT, 'data')),
  DATABASE_PATH: z.string().default(join(REPO_ROOT, 'data', 'runtime', 'app.db')),
  WEB_DIST: z.string().default(join(REPO_ROOT, 'web', 'dist')),
  MAX_SAMPLE_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  EXECUTION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  ALLOW_FAILURE_INJECTION: bool(true),

  // --- agent ---
  AGENT_MODE: z.enum(['auto', 'llm', 'heuristic']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  ANTHROPIC_SERVER_FALLBACKS: bool(true),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(2).max(40).default(16),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(2000).max(64000).default(16000),
  AGENT_RUN_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(10000).default(20),
});

export type Config = {
  nodeEnv: string;
  port: number;
  host: string;
  logLevel: string;
  dataDir: string;
  databasePath: string;
  webDist: string;
  maxSampleSize: number;
  executionBatchSize: number;
  allowFailureInjection: boolean;
  agent: {
    mode: 'auto' | 'llm' | 'heuristic';
    apiKey: string | undefined;
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    serverFallbacks: boolean;
    maxIterations: number;
    maxTokens: number;
    runLimitPerHour: number;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const e = envSchema.parse(env);
  const base: Config = {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    dataDir: e.DATA_DIR,
    databasePath: e.DATABASE_PATH,
    webDist: e.WEB_DIST,
    maxSampleSize: e.MAX_SAMPLE_SIZE,
    executionBatchSize: e.EXECUTION_BATCH_SIZE,
    allowFailureInjection: e.ALLOW_FAILURE_INJECTION,
    agent: {
      mode: e.AGENT_MODE,
      apiKey: e.ANTHROPIC_API_KEY?.trim() || undefined,
      model: e.ANTHROPIC_MODEL,
      effort: e.ANTHROPIC_EFFORT,
      serverFallbacks: e.ANTHROPIC_SERVER_FALLBACKS,
      maxIterations: e.AGENT_MAX_ITERATIONS,
      maxTokens: e.AGENT_MAX_TOKENS,
      runLimitPerHour: e.AGENT_RUN_LIMIT_PER_HOUR,
    },
  };
  return { ...base, ...overrides, agent: { ...base.agent, ...(overrides.agent ?? {}) } };
}

/** Which engine will actually run when the user clicks "Ask agent". */
export function resolveAgentMode(config: Config): 'llm' | 'heuristic' {
  if (config.agent.mode === 'heuristic') return 'heuristic';
  if (config.agent.mode === 'llm') return 'llm';
  return config.agent.apiKey ? 'llm' : 'heuristic';
}
