import { describe, expect, it } from 'vitest';
import { validateMapping } from '../src/domain/mapping.js';
import { runPipeline } from '../src/domain/pipeline.js';
import type { MappingSpec } from '../src/domain/types.js';
import { manifest, referenceMapping, sourceRows, sourceSchema, targetSchema } from './fixtures.js';

const run = (mapping: MappingSpec = referenceMapping, rows = sourceRows) => runPipeline(rows, mapping, targetSchema);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('deterministic pipeline', () => {
  it('produces identical outcomes and hash on every run', () => {
    const a = run();
    const b = run();
    expect(b.transformHash).toBe(a.transformHash);
    expect(JSON.stringify(b.outcomes)).toBe(JSON.stringify(a.outcomes));
  });

  it('is independent of annotations (rationale/risk) but sensitive to executable changes', () => {
    const annotated = clone(referenceMapping);
    annotated.fields[0]!.rationale = 'completely different words';
    annotated.fields[0]!.risk = 'high';
    expect(run(annotated).transformHash).toBe(run().transformHash);

    const changed = clone(referenceMapping);
    changed.fields.find((f) => f.target === 'currency')!.steps = [{ rule: 'constant', params: { value: 'USD' } }];
    expect(run(changed).transformHash).not.toBe(run().transformHash);
  });

  it('does not mutate the source records', () => {
    const before = JSON.stringify(sourceRows);
    run();
    expect(JSON.stringify(sourceRows)).toBe(before);
  });
});

describe('source → transformed → accepted / rejected counts', () => {
  const result = run();

  it('reports counts that add up', () => {
    expect(result.counts.source).toBe(manifest.total);
    expect(result.counts.accepted + result.counts.rejected).toBe(result.counts.source);
    expect(result.counts.transformed).toBeGreaterThanOrEqual(result.counts.accepted);
  });

  it('quarantines exactly the records the generator corrupted (excluding load-stage collisions)', () => {
    const expected = new Set(Object.entries(manifest.defects).filter(([k]) => k !== 'target_email_collision').flatMap(([, ids]) => ids));
    const actual = new Set(result.outcomes.filter((o) => o.status === 'rejected').map((o) => o.sourceKey));
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(result.counts.rejected).toBe(46);
    expect(result.counts.accepted).toBe(104);
  });

  it('attributes each defect class to the right field and stage', () => {
    const errorsFor = (ids: string[]) => ids.flatMap((id) => result.outcomes.find((o) => o.sourceKey === id)!.errors);
    expect(errorsFor(manifest.defects.invalid_email!).every((e) => e.targetField === 'email' && e.code === 'PATTERN_MISMATCH' && e.stage === 'validate')).toBe(true);
    expect(errorsFor(manifest.defects.bad_dob!).every((e) => e.targetField === 'date_of_birth' && e.stage === 'transform')).toBe(true);
    expect(errorsFor(manifest.defects.bad_phone!).every((e) => e.code === 'INVALID_PHONE')).toBe(true);
    expect(errorsFor(manifest.defects.bad_balance!).every((e) => e.code === 'INVALID_NUMBER')).toBe(true);
    expect(errorsFor(manifest.defects.bad_opt_in!).every((e) => e.code === 'INVALID_BOOLEAN')).toBe(true);
    expect(errorsFor(manifest.defects.long_address!).every((e) => e.code === 'MAX_LENGTH_EXCEEDED' && e.targetField === 'address')).toBe(true);
    expect(errorsFor(manifest.defects.duplicate_email!).every((e) => e.code === 'DUPLICATE_KEY' && e.stage === 'duplicate')).toBe(true);
  });

  it('preserves field-level evidence: source value, rule, message, and what the first claimant was', () => {
    const phone = result.outcomes.find((o) => o.sourceKey === manifest.defects.bad_phone![0])!;
    const e = phone.errors[0]!;
    expect(e).toMatchObject({ targetField: 'phone_e164', sourceField: 'phone', rule: 'normalize_phone', code: 'INVALID_PHONE' });
    expect(e.sourceValue).toBe(phone.source.phone);
    expect(e.message).toContain(String(phone.source.phone));

    const dup = result.outcomes.find((o) => o.sourceKey === manifest.defects.duplicate_email![0])!;
    expect(dup.errors[0]!.details).toHaveProperty('duplicateOf');
  });

  it('catches the case-variant duplicate only because email is lower-cased first', () => {
    const noLower = clone(referenceMapping);
    noLower.fields.find((f) => f.target === 'email')!.steps = [{ rule: 'trim' }];
    const r = run(noLower);
    const upperDup = r.outcomes.find((o) => o.sourceKey === manifest.defects.duplicate_email![1])!;
    expect(upperDup.errors[0]!.code).not.toBe('DUPLICATE_KEY'); // fails the lower-case pattern instead
  });

  it('collects ALL errors of a record, not just the first', () => {
    const rows = [{ sourceKey: 'X-1', payload: { ...sourceRows[0]!.payload, cust_id: 'X-1', email_addr: 'bad', phone: 'call me', dob: 'nope' } }];
    const r = run(referenceMapping, rows);
    expect(r.outcomes[0]!.errors.map((e) => e.targetField).sort()).toEqual(['date_of_birth', 'email', 'phone_e164']);
  });

  it('flags risky-but-valid records without rejecting them (the accepted-but-wrong class)', () => {
    for (const id of manifest.risky.us_phone_without_plus!) {
      const o = result.outcomes.find((x) => x.sourceKey === id)!;
      expect(o.status).toBe('accepted');
      expect(String(o.transformed.phone_e164)).toMatch(/^\+91/); // wrongly prefixed with the India default…
      expect(String(o.source.country)).toMatch(/US|United States/); // …although the customer is in the US
    }
  });
});

describe('mapping validation', () => {
  const validate = (m: unknown) => validateMapping(m, sourceSchema, targetSchema);

  it('accepts the reference mapping', () => {
    const v = validate(referenceMapping);
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
  });

  it('blocks missing required fields, unknown rules, bad params and unaccounted source fields', () => {
    const m = clone(referenceMapping);
    m.fields = m.fields.filter((f) => f.target !== 'tier');
    m.fields.find((f) => f.target === 'email')!.steps = [{ rule: 'regex_replace', params: {} }];
    m.fields.find((f) => f.target === 'phone_e164')!.steps = [{ rule: 'normalize_phone', params: { defaultCountryCode: '91' } }];
    m.unmappedSource = [];
    const codes = validate(m).errors.map((e) => e.code);
    expect(codes).toContain('REQUIRED_TARGET_UNMAPPED');
    expect(codes).toContain('UNKNOWN_RULE');
    expect(codes).toContain('INVALID_RULE_PARAMS');
    expect(codes).toContain('SOURCE_FIELD_UNACCOUNTED');
  });

  it('requires a constant when a target has no source, and rejects unknown/duplicate targets', () => {
    const m = clone(referenceMapping);
    m.fields.find((f) => f.target === 'currency')!.steps = [];
    m.fields.push({ target: 'ghost', source: 'cust_id', steps: [], risk: 'low', rationale: '' });
    m.fields.push({ ...m.fields[0]! });
    const codes = validate(m).errors.map((e) => e.code);
    expect(codes).toContain('NO_SOURCE_NEEDS_CONSTANT');
    expect(codes).toContain('UNKNOWN_TARGET_FIELD');
    expect(codes).toContain('DUPLICATE_TARGET');
  });

  it('warns (does not block) about lossy rules and output type mismatches', () => {
    const m = clone(referenceMapping);
    m.fields.find((f) => f.target === 'account_balance_minor')!.steps = [{ rule: 'trim' }];
    const v = validate(m);
    expect(v.valid).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['LOSSY_RULE', 'OUTPUT_TYPE_MISMATCH']));
  });

  it('rejects structurally malformed input without throwing', () => {
    expect(validate({ fields: 'nope' }).valid).toBe(false);
    expect(validate(null).valid).toBe(false);
  });
});
