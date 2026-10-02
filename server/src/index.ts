import { createApp } from './app.js';
import { createContext } from './bootstrap.js';
import { loadConfig, resolveAgentMode } from './config.js';
import { createLogger } from './logger.js';
import { waitForAgentRuns } from './agent/runner.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const ctx = createContext({ config, logger });
const app = createApp(ctx);

const server = app.listen(config.port, config.host, () => {
  logger.info(
    {
      event: 'server.started',
      port: config.port,
      env: config.nodeEnv,
      agentMode: resolveAgentMode(config),
      model: resolveAgentMode(config) === 'llm' ? config.agent.model : null,
      serverFallbacks: config.agent.serverFallbacks,
      database: config.databasePath,
      maxSampleSize: config.maxSampleSize,
    },
    `listening on ${config.host}:${config.port}`,
  );
  if (resolveAgentMode(config) === 'heuristic') logger.warn({ event: 'agent.no_llm' }, 'No ANTHROPIC_API_KEY: the rule-based fallback engine will be used instead of the LLM agent');
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ event: 'server.stopping', signal }, 'shutting down');
  server.close();
  await Promise.race([waitForAgentRuns(), new Promise((r) => setTimeout(r, 8000))]);
  ctx.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ event: 'process.unhandled_rejection', reason: String(reason) }, 'unhandled rejection'));
