import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, badRequest } from '../errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    actor: string;
  }
}

/** Reviewer identity for the audit trail. This is attribution, NOT authentication (see README → Limitations). */
export function actorMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = String(req.header('x-actor') ?? '').trim();
  req.actor = /^[\w .@'-]{1,60}$/.test(raw) ? raw : 'anonymous';
  next();
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw badRequest('Invalid request body', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), 'VALIDATION_FAILED');
  return r.data;
}

export function intParam(raw: unknown, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${name} must be a positive integer`);
  return n;
}

export function pageQuery(req: Request, defaults = { limit: 50, max: 200 }) {
  const limit = Math.min(Math.max(Number(req.query.limit ?? defaults.limit) || defaults.limit, 1), defaults.max);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Express 5 forwards rejected promises to the error handler, so handlers can simply be async. */
export const h = (fn: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler => async (req, res) => {
  const out = await fn(req, res);
  if (out !== undefined && !res.headersSent) res.json(out);
};

export function errorHandler(logger: import('../logger.js').Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
      return;
    }
    if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
      return;
    }
    if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
      return;
    }
    logger.error({ event: 'http.unhandled_error', err, path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error. See server logs.' } });
  };
}
