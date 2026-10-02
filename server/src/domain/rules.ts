import { z } from 'zod';
import { lookupCountry } from './countries.js';
import type { Scalar } from './types.js';

/**
 * The closed set of supported transformation rules.
 *
 * Every rule is a pure, deterministic function of (input value, validated params). There is no
 * expression language and no user-supplied code: the agent and the human editor can only pick a
 * rule id from this registry and fill in its declared parameters.
 *
 * Null handling: unless a rule says otherwise, a null / blank input passes through as null, so an
 * optional target field stays null and a required one is reported by the validation stage.
 */

export type RuleResult = { ok: true; value: Scalar } | { ok: false; code: string; message: string };

export type OutputType = 'string' | 'integer' | 'boolean' | 'date' | 'scalar';

export interface ParamSpec {
  name: string;
  type: 'string' | 'string[]' | 'record' | 'integer' | 'boolean' | 'scalar' | 'enum';
  required: boolean;
  description: string;
  enum?: string[];
  default?: unknown;
}

export interface RuleDefinition {
  id: string;
  label: string;
  description: string;
  category: 'text' | 'date' | 'number' | 'lookup' | 'logic';
  params: ParamSpec[];
  /** true when the rule approximates or discards information (reviewers should look at it twice). */
  lossy: boolean;
  /** true when the rule produces a value from nothing (constant / default) rather than passing null through. */
  ignoresInput: boolean;
  outputType: OutputType;
  paramsSchema: z.ZodType<Record<string, unknown>>;
  apply(input: Scalar | undefined, params: Record<string, unknown>): RuleResult;
}

const ok = (value: Scalar): RuleResult => ({ ok: true, value });
const fail = (code: string, message: string): RuleResult => ({ ok: false, code, message });
const isEmpty = (v: Scalar | undefined): v is null | undefined | '' =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Wraps a string rule so blank input yields null and non-strings are stringified. */
function onString(fn: (s: string, params: Record<string, unknown>) => RuleResult) {
  return (input: Scalar | undefined, params: Record<string, unknown>): RuleResult =>
    isEmpty(input) ? ok(null) : fn(String(input), params);
}

const noParams = z.object({}).strict();
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

// ---- date helpers -------------------------------------------------------------------------------
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'YYYY/MM/DD'] as const;
type DateFormat = (typeof DATE_FORMATS)[number];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DATE_PATTERNS: Record<DateFormat, { re: RegExp; pick: (m: RegExpMatchArray) => [string, string, string] | null }> = {
  'YYYY-MM-DD': { re: /^(\d{4})-(\d{2})-(\d{2})$/, pick: (m) => [m[1]!, m[2]!, m[3]!] },
  'YYYY/MM/DD': { re: /^(\d{4})\/(\d{2})\/(\d{2})$/, pick: (m) => [m[1]!, m[2]!, m[3]!] },
  'DD/MM/YYYY': { re: /^(\d{2})\/(\d{2})\/(\d{4})$/, pick: (m) => [m[3]!, m[2]!, m[1]!] },
  'MM/DD/YYYY': { re: /^(\d{2})\/(\d{2})\/(\d{4})$/, pick: (m) => [m[3]!, m[1]!, m[2]!] },
  'DD-MM-YYYY': { re: /^(\d{2})-(\d{2})-(\d{4})$/, pick: (m) => [m[3]!, m[2]!, m[1]!] },
  'DD-MMM-YYYY': {
    re: /^(\d{2})-([A-Za-z]{3})-(\d{4})$/,
    pick: (m) => {
      const idx = MONTHS.indexOf(m[2]!.toLowerCase());
      return idx < 0 ? null : [m[3]!, String(idx + 1), m[1]!];
    },
  },
};

export function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ---- decimal helper (string arithmetic, no floating point) --------------------------------------
function decimalToMinor(raw: string, decimals: number): RuleResult {
  const s = raw.trim();
  const plain = /^-?\d+(\.\d+)?$/;
  const grouped = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
  if (!plain.test(s) && !grouped.test(s)) return fail('INVALID_NUMBER', `'${raw}' is not a plain or comma-grouped decimal number`);
  const clean = s.replace(/,/g, '');
  const negative = clean.startsWith('-');
  const [intPart = '0', frac = ''] = clean.replace('-', '').split('.');
  if (frac.length > decimals) {
    return fail('PRECISION_LOSS', `'${raw}' has ${frac.length} decimal places but only ${decimals} are representable; refusing to round silently`);
  }
  const minor = BigInt(intPart + frac.padEnd(decimals, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return fail('NUMBER_TOO_LARGE', `'${raw}' exceeds the safe integer range`);
  const n = Number(minor);
  return ok(negative && n !== 0 ? -n : n);
}

// ---- phone helper --------------------------------------------------------------------------------
function toE164(raw: string, defaultCountryCode: string): RuleResult {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return fail('INVALID_PHONE', `'${raw}' contains no digits`);
  let e164: string;
  if (trimmed.startsWith('+')) {
    e164 = `+${digits}`;
  } else if (digits.startsWith('00')) {
    e164 = `+${digits.slice(2)}`;
  } else {
    if (digits.startsWith('0')) digits = digits.slice(1); // national trunk prefix
    e164 = `${defaultCountryCode}${digits}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return fail('INVALID_PHONE', `'${raw}' does not normalise to a valid E.164 number (got '${e164}')`);
  return ok(e164);
}

// ---- registry -----------------------------------------------------------------------------------
const DEFS: RuleDefinition[] = [
  {
    id: 'copy',
    label: 'Copy',
    description: 'Pass the value through unchanged.',
    category: 'text',
    params: [],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: noParams,
    apply: (input) => ok(input === undefined ? null : input),
  },
  {
    id: 'trim',
    label: 'Trim whitespace',
    description: 'Trim leading/trailing whitespace and collapse internal runs of whitespace to one space.',
    category: 'text',
    params: [],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: noParams,
    apply: onString((s) => ok(s.trim().replace(/\s+/g, ' '))),
  },
  {
    id: 'lowercase',
    label: 'Lower-case',
    description: 'Convert to lower case.',
    category: 'text',
    params: [],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: noParams,
    apply: onString((s) => ok(s.toLowerCase())),
  },
  {
    id: 'uppercase',
    label: 'Upper-case',
    description: 'Convert to upper case.',
    category: 'text',
    params: [],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: noParams,
    apply: onString((s) => ok(s.toUpperCase())),
  },
  {
    id: 'title_case',
    label: 'Title case',
    description: 'Lower-case the text then capitalise the first letter of each word (also after hyphens and apostrophes). Does not understand "McDonald"-style names.',
    category: 'text',
    params: [],
    lossy: true,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: noParams,
    apply: onString((s) => ok(s.toLowerCase().replace(/(^|[\s\-'’])([a-zÀ-ɏ])/g, (_m, p: string, c: string) => p + c.toUpperCase()))),
  },
  {
    id: 'prefix',
    label: 'Add prefix',
    description: 'Prepend a fixed string to a non-blank value.',
    category: 'text',
    params: [{ name: 'prefix', type: 'string', required: true, description: 'Text to prepend, e.g. "cus_".' }],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: z.object({ prefix: z.string().min(1).max(40) }).strict(),
    apply: onString((s, p) => ok(`${p.prefix as string}${s.trim()}`)),
  },
  {
    id: 'truncate',
    label: 'Truncate',
    description: 'Cut the text to at most maxLength characters. LOSSY: characters beyond the limit are discarded.',
    category: 'text',
    params: [{ name: 'maxLength', type: 'integer', required: true, description: 'Maximum characters to keep (1-500).' }],
    lossy: true,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: z.object({ maxLength: z.number().int().min(1).max(500) }).strict(),
    apply: onString((s, p) => ok(s.trim().slice(0, p.maxLength as number).trimEnd())),
  },
  {
    id: 'split_name',
    label: 'Split full name',
    description:
      'Extract the first or last name from a full name. Understands "Last, First" and "First [Middle...] Last". With a single word the last name is null. Name parsing is heuristic.',
    category: 'text',
    params: [{ name: 'part', type: 'enum', required: true, enum: ['first', 'last'], description: 'Which part to extract.' }],
    lossy: true,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: z.object({ part: z.enum(['first', 'last']) }).strict(),
    apply: onString((s, p) => {
      const name = s.trim().replace(/\s+/g, ' ');
      let first: string;
      let last: string;
      if (name.includes(',')) {
        const idx = name.indexOf(',');
        last = name.slice(0, idx).trim();
        first = name.slice(idx + 1).trim();
      } else {
        const tokens = name.split(' ');
        if (tokens.length === 1) {
          first = tokens[0]!;
          last = '';
        } else {
          last = tokens[tokens.length - 1]!;
          first = tokens.slice(0, -1).join(' ');
        }
      }
      const out = p.part === 'first' ? first : last;
      return ok(out === '' ? null : out);
    }),
  },
  {
    id: 'constant',
    label: 'Constant value',
    description: 'Ignore the input and emit a fixed value. Use only for target fields that have no source (and only with a confirmed business answer).',
    category: 'logic',
    params: [{ name: 'value', type: 'scalar', required: true, description: 'The value to emit (string, number or boolean).' }],
    lossy: false,
    ignoresInput: true,
    outputType: 'scalar',
    paramsSchema: z.object({ value: scalarSchema }).strict(),
    apply: (_input, p) => ok(p.value as Scalar),
  },
  {
    id: 'default_if_empty',
    label: 'Default if blank',
    description: 'Replace a null or blank value with a fixed default. Non-blank values pass through. Hides missing data, so use sparingly.',
    category: 'logic',
    params: [{ name: 'value', type: 'scalar', required: true, description: 'Default to use when the input is blank.' }],
    lossy: true,
    ignoresInput: true,
    outputType: 'scalar',
    paramsSchema: z.object({ value: scalarSchema }).strict(),
    apply: (input, p) => (isEmpty(input) ? ok(p.value as Scalar) : ok(input as Scalar)),
  },
  {
    id: 'value_map',
    label: 'Map values',
    description:
      'Translate known source values to target values using an explicit table (case-insensitive by default). A value with no entry is an error unless a fallback is given.',
    category: 'lookup',
    params: [
      { name: 'map', type: 'record', required: true, description: 'Object of sourceValue -> targetValue, e.g. {"A":"active","I":"inactive"}.' },
      { name: 'caseInsensitive', type: 'boolean', required: false, default: true, description: 'Match source values ignoring case (default true).' },
      { name: 'fallback', type: 'string', required: false, description: 'Value to use when no entry matches. Omit to make unknown values an error (recommended).' },
    ],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: z
      .object({
        map: z.record(z.string(), z.string()).refine((m) => Object.keys(m).length > 0 && Object.keys(m).length <= 200, 'map must have 1-200 entries'),
        caseInsensitive: z.boolean().optional(),
        fallback: z.string().optional(),
      })
      .strict(),
    apply: onString((s, p) => {
      const map = p.map as Record<string, string>;
      const ci = p.caseInsensitive !== false;
      const key = s.trim();
      for (const [k, v] of Object.entries(map)) {
        if (ci ? k.toLowerCase() === key.toLowerCase() : k === key) return ok(v);
      }
      if (typeof p.fallback === 'string') return ok(p.fallback);
      return fail('UNMAPPED_VALUE', `'${s}' has no entry in the value map (known: ${Object.keys(map).join(', ')})`);
    }),
  },
  {
    id: 'parse_date',
    label: 'Parse date',
    description:
      'Parse a date written in one of the listed formats into ISO YYYY-MM-DD. Formats are tried in order; impossible calendar dates (31/02) are errors. DD/MM/YYYY and MM/DD/YYYY cannot be combined (ambiguous).',
    category: 'date',
    params: [{ name: 'formats', type: 'string[]', required: true, enum: [...DATE_FORMATS], description: `One or more of: ${DATE_FORMATS.join(', ')}.` }],
    lossy: false,
    ignoresInput: false,
    outputType: 'date',
    paramsSchema: z
      .object({ formats: z.array(z.enum(DATE_FORMATS)).min(1).max(4) })
      .strict()
      .refine((p) => !(p.formats.includes('DD/MM/YYYY') && p.formats.includes('MM/DD/YYYY')), {
        message: 'DD/MM/YYYY and MM/DD/YYYY are ambiguous together; pick one',
      }),
    apply: onString((s, p) => {
      const text = s.trim();
      let matchedShape = false;
      for (const fmt of p.formats as DateFormat[]) {
        const pat = DATE_PATTERNS[fmt];
        const m = text.match(pat.re);
        if (!m) continue;
        const parts = pat.pick(m);
        if (!parts) continue;
        matchedShape = true;
        const [y, mo, d] = parts.map(Number) as [number, number, number];
        if (isRealDate(y, mo, d)) return ok(iso(y, mo, d));
      }
      return matchedShape
        ? fail('INVALID_DATE', `'${s}' matches a configured format but is not a real calendar date`)
        : fail('DATE_FORMAT_UNRECOGNISED', `'${s}' does not match any of: ${(p.formats as string[]).join(', ')}`);
    }),
  },
  {
    id: 'normalize_phone',
    label: 'Normalise phone (E.164)',
    description:
      'Convert free-form phone text to E.164. Numbers with +CC or 00CC keep their own country code; numbers without one get defaultCountryCode (a leading 0 is dropped). LOSSY: a foreign number written without +CC is silently given the default country code.',
    category: 'text',
    params: [{ name: 'defaultCountryCode', type: 'string', required: true, description: 'Country code applied to national numbers, e.g. "+91".' }],
    lossy: true,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: z.object({ defaultCountryCode: z.string().regex(/^\+[1-9]\d{0,3}$/, 'must look like +91') }).strict(),
    apply: onString((s, p) => toE164(s, p.defaultCountryCode as string)),
  },
  {
    id: 'to_boolean',
    label: 'To boolean',
    description: 'Convert text to true/false. Defaults: true = y, yes, true, t, 1; false = n, no, false, f, 0 (case-insensitive). Anything else is an error.',
    category: 'logic',
    params: [
      { name: 'trueValues', type: 'string[]', required: false, description: 'Override the accepted "true" spellings.' },
      { name: 'falseValues', type: 'string[]', required: false, description: 'Override the accepted "false" spellings.' },
    ],
    lossy: false,
    ignoresInput: false,
    outputType: 'boolean',
    paramsSchema: z.object({ trueValues: z.array(z.string()).max(20).optional(), falseValues: z.array(z.string()).max(20).optional() }).strict(),
    apply: onString((s, p) => {
      const t = ((p.trueValues as string[] | undefined) ?? ['y', 'yes', 'true', 't', '1']).map((x) => x.toLowerCase());
      const f = ((p.falseValues as string[] | undefined) ?? ['n', 'no', 'false', 'f', '0']).map((x) => x.toLowerCase());
      const key = s.trim().toLowerCase();
      if (t.includes(key)) return ok(true);
      if (f.includes(key)) return ok(false);
      return fail('INVALID_BOOLEAN', `'${s}' is not a recognised yes/no value`);
    }),
  },
  {
    id: 'decimal_to_minor_units',
    label: 'Decimal to minor units',
    description:
      'Convert a decimal money string such as "1,234.50" into an integer number of minor units (cents/paise). Refuses to round: more decimals than `decimals` is an error.',
    category: 'number',
    params: [{ name: 'decimals', type: 'integer', required: false, default: 2, description: 'Number of decimal places in the minor unit (0-4, default 2).' }],
    lossy: false,
    ignoresInput: false,
    outputType: 'integer',
    paramsSchema: z.object({ decimals: z.number().int().min(0).max(4).optional() }).strict(),
    apply: onString((s, p) => decimalToMinor(s, (p.decimals as number | undefined) ?? 2)),
  },
  {
    id: 'country_to_iso2',
    label: 'Country to ISO alpha-2',
    description: 'Convert a country name, alias or code to an ISO 3166-1 alpha-2 code using a fixed lookup table. Unknown values are an error (no guessing).',
    category: 'lookup',
    params: [],
    lossy: false,
    ignoresInput: false,
    outputType: 'string',
    paramsSchema: noParams,
    apply: onString((s) => {
      const code = lookupCountry(s);
      return code ? ok(code) : fail('UNKNOWN_COUNTRY', `'${s}' is not in the country lookup table`);
    }),
  },
];

export const RULES: ReadonlyMap<string, RuleDefinition> = new Map(DEFS.map((d) => [d.id, d]));

/** JSON-serialisable description for the UI and for the agent's list_transformation_rules tool. */
export function describeRules() {
  return DEFS.map(({ id, label, description, category, params, lossy, ignoresInput, outputType }) => ({
    id,
    label,
    description,
    category,
    params,
    lossy,
    ignoresInput,
    outputType,
  }));
}

export function applyRule(ruleId: string, input: Scalar | undefined, params: Record<string, unknown> | undefined): RuleResult {
  const def = RULES.get(ruleId);
  if (!def) return fail('UNKNOWN_RULE', `Unknown rule '${ruleId}'`);
  const parsed = def.paramsSchema.safeParse(params ?? {});
  if (!parsed.success) return fail('INVALID_RULE_PARAMS', parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '));
  return def.apply(input, parsed.data);
}
