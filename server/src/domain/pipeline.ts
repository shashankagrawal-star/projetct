import { hashOf } from './hash.js';
import { applyRule, isRealDate } from './rules.js';
import type { FieldError, MappingSpec, RecordOutcome, RunCounts, Scalar, SourceRecord, TargetField, TargetSchema } from './types.js';

/**
 * The deterministic transform → validate → de-duplicate pipeline.
 *
 * Pure: same (records, mapping, target schema) always yields byte-identical outcomes and the same
 * `transformHash`. No clock, no randomness, no I/O, no dependence on the state of the target store.
 * The dry run and the real execution both call this one function, so they cannot disagree.
 */

export interface SourceRow {
  sourceKey: string;
  payload: SourceRecord;
}

export interface PipelineResult {
  outcomes: RecordOutcome[];
  counts: RunCounts;
  breakdown: {
    byStage: Record<string, number>;
    byCode: Record<string, number>;
    byField: Record<string, number>;
  };
  transformHash: string;
}

export function executablePart(mapping: MappingSpec) {
  return mapping.fields.map((f) => ({ target: f.target, source: f.source, steps: f.steps.map((s) => ({ rule: s.rule, params: s.params ?? {} })) }));
}

export function transformRecord(source: SourceRecord, mapping: MappingSpec): { transformed: Record<string, Scalar>; errors: FieldError[] } {
  const transformed: Record<string, Scalar> = {};
  const errors: FieldError[] = [];
  for (const fm of mapping.fields) {
    const raw = fm.source === null ? null : (source[fm.source] ?? null);
    let value: Scalar = raw;
    let failed = false;
    for (const step of fm.steps) {
      const res = applyRule(step.rule, value, step.params);
      if (!res.ok) {
        errors.push({
          stage: 'transform',
          targetField: fm.target,
          sourceField: fm.source,
          rule: step.rule,
          code: res.code,
          message: res.message,
          sourceValue: raw,
        });
        failed = true;
        break;
      }
      value = res.value;
    }
    if (typeof value === 'string' && value.trim() === '') value = null; // blank means "no value"
    transformed[fm.target] = failed ? null : value;
  }
  return { transformed, errors };
}

function validateField(field: TargetField, value: Scalar): { code: string; message: string } | null {
  if (value === null) return field.required ? { code: 'REQUIRED_MISSING', message: `'${field.name}' is required but has no value` } : null;

  switch (field.type) {
    case 'string':
    case 'enum':
      if (typeof value !== 'string') return { code: 'TYPE_MISMATCH', message: `'${field.name}' must be a string, got ${typeof value}` };
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return { code: 'TYPE_MISMATCH', message: `'${field.name}' must be an integer, got ${JSON.stringify(value)}` };
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return { code: 'TYPE_MISMATCH', message: `'${field.name}' must be a boolean, got ${JSON.stringify(value)}` };
      break;
    case 'date': {
      const m = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
      if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
        return { code: 'TYPE_MISMATCH', message: `'${field.name}' must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}` };
      }
      break;
    }
  }
  if (field.enum && !field.enum.includes(String(value))) {
    return { code: 'ENUM_MISMATCH', message: `'${field.name}' must be one of ${field.enum.join(', ')}; got '${String(value)}'` };
  }
  if (typeof value === 'string') {
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return { code: 'MAX_LENGTH_EXCEEDED', message: `'${field.name}' is ${value.length} characters; the maximum is ${field.maxLength}` };
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      return { code: 'PATTERN_MISMATCH', message: `'${field.name}' value '${value}' does not match ${field.pattern}` };
    }
  }
  return null;
}

export function validateTransformed(transformed: Record<string, Scalar>, mapping: MappingSpec, target: TargetSchema, skip: Set<string>): FieldError[] {
  const errors: FieldError[] = [];
  const byTarget = new Map(mapping.fields.map((f) => [f.target, f]));
  for (const field of target.fields) {
    if (skip.has(field.name)) continue;
    const value = transformed[field.name] ?? null;
    const problem = validateField(field, value);
    if (problem) {
      const fm = byTarget.get(field.name);
      errors.push({
        stage: 'validate',
        targetField: field.name,
        sourceField: fm?.source ?? null,
        rule: fm && fm.steps.length > 0 ? fm.steps[fm.steps.length - 1]!.rule : null,
        code: problem.code,
        message: problem.message,
        sourceValue: null, // filled in by caller (needs the raw record)
        transformedValue: value,
      });
    }
  }
  return errors;
}

export function runPipeline(rows: SourceRow[], mapping: MappingSpec, target: TargetSchema): PipelineResult {
  const outcomes: RecordOutcome[] = [];

  for (const row of rows) {
    const { transformed, errors } = transformRecord(row.payload, mapping);
    const failedFields = new Set(errors.map((e) => e.targetField));
    const validation = validateTransformed(transformed, mapping, target, failedFields);
    for (const e of validation) e.sourceValue = e.sourceField ? (row.payload[e.sourceField] ?? null) : null;
    outcomes.push({ sourceKey: row.sourceKey, status: 'accepted', source: row.payload, transformed, errors: [...errors, ...validation] });
  }

  // Uniqueness inside the batch: the first otherwise-valid record claims a unique value, later ones are quarantined.
  for (const field of target.fields.filter((f) => f.unique)) {
    const claimed = new Map<string, string>();
    const byTarget = mapping.fields.find((f) => f.target === field.name);
    for (const o of outcomes) {
      if (o.errors.length > 0) continue;
      const value = o.transformed[field.name];
      if (value === null || value === undefined) continue;
      const key = String(value);
      const owner = claimed.get(key);
      if (owner === undefined) {
        claimed.set(key, o.sourceKey);
      } else {
        o.errors.push({
          stage: 'duplicate',
          targetField: field.name,
          sourceField: byTarget?.source ?? null,
          rule: null,
          code: 'DUPLICATE_KEY',
          message: `'${field.name}' value '${key}' is already claimed by source record ${owner}`,
          sourceValue: byTarget?.source ? (o.source[byTarget.source] ?? null) : null,
          transformedValue: value,
          details: { duplicateOf: owner },
        });
      }
    }
  }

  const counts: RunCounts = { source: outcomes.length, transformed: 0, accepted: 0, rejected: 0 };
  const breakdown = { byStage: {} as Record<string, number>, byCode: {} as Record<string, number>, byField: {} as Record<string, number> };
  for (const o of outcomes) {
    o.status = o.errors.length === 0 ? 'accepted' : 'rejected';
    if (!o.errors.some((e) => e.stage === 'transform')) counts.transformed++;
    if (o.status === 'accepted') counts.accepted++;
    else counts.rejected++;
    for (const e of o.errors) {
      breakdown.byStage[e.stage] = (breakdown.byStage[e.stage] ?? 0) + 1;
      breakdown.byCode[e.code] = (breakdown.byCode[e.code] ?? 0) + 1;
      breakdown.byField[e.targetField] = (breakdown.byField[e.targetField] ?? 0) + 1;
    }
  }

  const transformHash = hashOf({
    mapping: executablePart(mapping),
    outcomes: outcomes.map((o) => ({
      k: o.sourceKey,
      s: o.status,
      src: o.source,
      t: o.transformed,
      e: o.errors.map((e) => [e.stage, e.targetField, e.code, e.message]),
    })),
  });

  return { outcomes, counts, breakdown, transformHash };
}
