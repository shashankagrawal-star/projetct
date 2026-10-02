import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context.js';
import { dataRoutes } from './routes/data.js';
import { actorMiddleware, errorHandler } from './routes/helpers.js';
import { planRoutes } from './routes/plans.js';
import { runRoutes } from './routes/runs.js';

/** Tiny fixed-window limiter: enough to blunt accidental floods on a public demo without a dependency. */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const cur = hits.get(key);
    if (!cur || cur.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++cur.n > limit) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } });
      return;
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger: ctx.logger,
      genReqId: (req, res) => {
        const id = String(req.headers['x-request-id'] ?? randomUUID());
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    next();
  });

  app.use('/api', express.json({ limit: '256kb' }), rateLimit(600, 60_000), actorMiddleware, dataRoutes(ctx), planRoutes(ctx), runRoutes(ctx));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such API route' } });
  });

  const indexHtml = join(ctx.config.webDist, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(express.static(ctx.config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(indexHtml));
  } else {
    app.get('/', (_req, res) => {
      res.type('text').send('API is running. The web UI has not been built (run `npm run build`) — in development use `npm run dev`.');
    });
  }

  app.use(errorHandler(ctx.logger));
  return app;
}
