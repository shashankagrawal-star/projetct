import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs on stdout. Secrets are redacted by path even if someone logs a config/request object. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'migration-workbench' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'apiKey', '*.apiKey', 'config.agent.apiKey', 'ANTHROPIC_API_KEY'],
      censor: '[redacted]',
    },
  });
}
