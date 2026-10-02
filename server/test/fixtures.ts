import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MappingSpec, SourceRecord, SourceSchema, TargetSchema } from '../src/domain/types.js';
import type { SourceRow } from '../src/domain/pipeline.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as T;

export const sourceSchema = read<SourceSchema>('source-schema.json');
export const targetSchema = read<TargetSchema>('target-schema.json');
export const sourceRecords = read<SourceRecord[]>('sample-source-records.json');
export const manifest = read<{ total: number; maxSampleSize: number; defects: Record<string, string[]>; risky: Record<string, string[]> }>('sample-manifest.json');
export const sourceRows: SourceRow[] = sourceRecords.map((r) => ({ sourceKey: r.cust_id as string, payload: r }));

/** A known-good mapping: what a careful reviewer would approve once the business questions are answered. */
export const referenceMapping: MappingSpec = {
  fields: [
    { target: 'id', source: 'cust_id', steps: [{ rule: 'prefix', params: { prefix: 'cus_' } }], risk: 'low', rationale: 'Deterministic id derived from the legacy key.' },
    { target: 'first_name', source: 'full_name', steps: [{ rule: 'split_name', params: { part: 'first' } }, { rule: 'title_case' }], risk: 'medium', rationale: 'Heuristic name split.' },
    { target: 'last_name', source: 'full_name', steps: [{ rule: 'split_name', params: { part: 'last' } }, { rule: 'title_case' }], risk: 'medium', rationale: 'Heuristic name split.' },
    { target: 'email', source: 'email_addr', steps: [{ rule: 'trim' }, { rule: 'lowercase' }], risk: 'low', rationale: 'Normalise case so uniqueness is meaningful.' },
    { target: 'phone_e164', source: 'phone', steps: [{ rule: 'normalize_phone', params: { defaultCountryCode: '+91' } }], risk: 'high', rationale: 'Numbers without +CC get +91.' },
    { target: 'date_of_birth', source: 'dob', steps: [{ rule: 'parse_date', params: { formats: ['YYYY-MM-DD', 'DD/MM/YYYY'] } }], risk: 'low', rationale: 'Two observed formats.' },
    { target: 'country_code', source: 'country', steps: [{ rule: 'country_to_iso2' }], risk: 'low', rationale: 'Lookup table.' },
    { target: 'customer_since', source: 'signup_date', steps: [{ rule: 'parse_date', params: { formats: ['YYYY-MM-DD', 'DD-MMM-YYYY'] } }], risk: 'low', rationale: 'Two observed formats.' },
    { target: 'status', source: 'status_code', steps: [{ rule: 'value_map', params: { map: { A: 'active', I: 'inactive', S: 'suspended' } } }], risk: 'low', rationale: 'Explicit table; unknown codes rejected.' },
    { target: 'tier', source: 'legacy_segment', steps: [{ rule: 'value_map', params: { map: { RETAIL: 'standard', GOLD: 'premium', PLATINUM: 'vip', ENTERPRISE: 'vip' } } }], risk: 'high', rationale: 'Business mapping needs confirmation.' },
    { target: 'currency', source: null, steps: [{ rule: 'constant', params: { value: 'INR' } }], risk: 'high', rationale: 'Legacy export has no currency.' },
    { target: 'account_balance_minor', source: 'balance_str', steps: [{ rule: 'decimal_to_minor_units', params: { decimals: 2 } }], risk: 'medium', rationale: 'Exact string arithmetic.' },
    { target: 'marketing_opt_in', source: 'marketing_opt_in', steps: [{ rule: 'default_if_empty', params: { value: 'N' } }, { rule: 'to_boolean' }], risk: 'medium', rationale: 'Blank consent treated as opt-out.' },
    { target: 'address', source: 'address_line', steps: [{ rule: 'trim' }], risk: 'low', rationale: 'Too-long addresses are rejected, not truncated.' },
  ],
  unmappedSource: [{ field: 'notes', reason: 'Free-text operator notes have no target column.' }],
};
