import type { AppContext } from '../context.js';
import { all, get, json, parse, run, transaction } from '../db/connection.js';
import { hashOf } from '../domain/hash.js';
import { validateMapping, type MappingValidation } from '../domain/mapping.js';
import { mappingSpecSchema, type Analysis, type MappingSpec } from '../domain/types.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { audit } from './audit.js';

export type PlanStatus = 'proposed' | 'draft' | 'approved' | 'rejected';

export interface PlanVersion {
  version: number;
  parentVersion: number | null;
  status: PlanStatus;
  origin: 'agent' | 'user';
  mapping: MappingSpec;
  mappingHash: string;
  analysis: Analysis | null;
  note: string | null;
  agentRunId: number | null;
  createdBy: string;
  createdAt: string;
}

interface PlanRow {
  version: number;
  parent_version: number | null;
  status: PlanStatus;
  origin: 'agent' | 'user';
  mapping: string;
  mapping_hash: string;
  analysis: string | null;
  note: string | null;
  agent_run_id: number | null;
  created_by: string;
  created_at: string;
}

const fromRow = (r: PlanRow): PlanVersion => ({
  version: r.version,
  parentVersion: r.parent_version,
  status: r.status,
  origin: r.origin,
  mapping: parse<MappingSpec>(r.mapping),
  mappingHash: r.mapping_hash,
  analysis: r.analysis ? parse<Analysis>(r.analysis) : null,
  note: r.note,
  agentRunId: r.agent_run_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export function getPlan(ctx: AppContext, version: number): PlanVersion {
  const row = get<PlanRow>(ctx.db, 'SELECT * FROM plan_versions WHERE version = ?', [version]);
  if (!row) throw notFound(`Plan version ${version}`);
  return fromRow(row);
}

export function listPlans(ctx: AppContext): PlanVersion[] {
  return all<PlanRow>(ctx.db, 'SELECT * FROM plan_versions ORDER BY version DESC').map(fromRow);
}

export function validatePlan(ctx: AppContext, plan: PlanVersion): MappingValidation {
  return validateMapping(plan.mapping, ctx.source, ctx.target);
}

export interface NewPlanInput {
  mapping: unknown;
  analysis?: Analysis | null;
  origin: 'agent' | 'user';
  status: 'proposed' | 'draft';
  parentVersion?: number | null;
  note?: string | null;
  agentRunId?: number | null;
  actor: string;
}

/** Creates the next immutable plan version. A version is never edited in place — edits create a new one. */
export function createPlanVersion(ctx: AppContext, input: NewPlanInput): PlanVersion {
  const parsed = mappingSpecSchema.safeParse(input.mapping);
  if (!parsed.success) {
    throw unprocessable('Mapping is malformed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), 'MALFORMED_MAPPING');
  }
  const mapping = parsed.data;
  if (input.parentVersion != null) getPlan(ctx, input.parentVersion); // must exist

  const created = transaction(ctx.db, () => {
    const next = (get<{ v: number | null }>(ctx.db, 'SELECT MAX(version) AS v FROM plan_versions')?.v ?? 0) + 1;
    run(
      ctx.db,
      `INSERT INTO plan_versions (version, parent_version, status, origin, mapping, mapping_hash, analysis, note, agent_run_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [next, input.parentVersion ?? null, input.status, input.origin, json(mapping), hashOf(mapping), input.analysis ? json(input.analysis) : null, input.note ?? null, input.agentRunId ?? null, input.actor, ctx.now()],
    );
    return next;
  });

  const plan = getPlan(ctx, created);
  audit(ctx, input.actor, input.origin === 'agent' ? 'plan.proposed' : 'plan.created', 'plan_version', plan.version, {
    parentVersion: plan.parentVersion,
    origin: plan.origin,
    mappingHash: plan.mappingHash,
    agentRunId: plan.agentRunId,
  });
  return plan;
}

export function setPlanStatus(ctx: AppContext, version: number, status: PlanStatus): void {
  run(ctx.db, 'UPDATE plan_versions SET status = ? WHERE version = ?', [status, version]);
}

/** Human-readable diff between two versions' executable mapping — what changed, per target field. */
export function diffPlans(a: PlanVersion, b: PlanVersion) {
  const byTarget = (p: PlanVersion) => new Map(p.mapping.fields.map((f) => [f.target, f]));
  const ma = byTarget(a);
  const mb = byTarget(b);
  const changes: Array<{ target: string; change: 'added' | 'removed' | 'modified'; before?: unknown; after?: unknown }> = [];
  for (const [t, fb] of mb) {
    const fa = ma.get(t);
    if (!fa) changes.push({ target: t, change: 'added', after: { source: fb.source, steps: fb.steps } });
    else if (hashOf({ s: fa.source, st: fa.steps }) !== hashOf({ s: fb.source, st: fb.steps })) {
      changes.push({ target: t, change: 'modified', before: { source: fa.source, steps: fa.steps }, after: { source: fb.source, steps: fb.steps } });
    }
  }
  for (const [t, fa] of ma) if (!mb.has(t)) changes.push({ target: t, change: 'removed', before: { source: fa.source, steps: fa.steps } });
  return { from: a.version, to: b.version, changes };
}

export function requireVersionNumber(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Plan version must be a positive integer');
  return n;
}
