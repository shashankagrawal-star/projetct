import type { AppContext } from '../context.js';
import { all, get, json, run, type Param } from '../db/connection.js';

export function audit(ctx: AppContext, actor: string, event: string, entityType: string, entityId: string | number, details: Record<string, unknown> = {}): void {
  run(ctx.db, 'INSERT INTO audit_log (ts, actor, event, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)', [ctx.now(), actor, event, entityType, String(entityId), json(details)]);
  ctx.logger.info({ event: 'audit', auditEvent: event, actor, entityType, entityId, ...details }, `audit ${event}`);
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  event: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export function listAudit(ctx: AppContext, opts: { event?: string; prefix?: string; entityType?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: Param[] = [];
  if (opts.event) {
    where.push('event = ?');
    params.push(opts.event);
  }
  if (opts.prefix) {
    where.push('event LIKE ?');
    params.push(`${opts.prefix}%`);
  }
  if (opts.entityType) {
    where.push('entity_type = ?');
    params.push(opts.entityType);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM audit_log ${clause}`, params)!.n;
  const rows = all<{ id: number; ts: string; actor: string; event: string; entity_type: string; entity_id: string; details: string }>(
    ctx.db,
    `SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  return {
    total,
    entries: rows.map<AuditEntry>((r) => ({ id: r.id, ts: r.ts, actor: r.actor, event: r.event, entityType: r.entity_type, entityId: r.entity_id, details: JSON.parse(r.details) as Record<string, unknown> })),
  };
}
