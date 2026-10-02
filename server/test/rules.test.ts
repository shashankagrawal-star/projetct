import { describe, expect, it } from 'vitest';
import { RULES, applyRule, describeRules } from '../src/domain/rules.js';

const ok = (rule: string, input: string | null, params?: Record<string, unknown>) => {
  const r = applyRule(rule, input, params);
  if (!r.ok) throw new Error(`${rule}(${input}) failed: ${r.code} ${r.message}`);
  return r.value;
};
const fail = (rule: string, input: string | null, params?: Record<string, unknown>) => {
  const r = applyRule(rule, input, params);
  if (r.ok) throw new Error(`${rule}(${input}) unexpectedly succeeded with ${JSON.stringify(r.value)}`);
  return r.code;
};

describe('rule registry', () => {
  it('is a closed set: unknown rules are an error, never executed', () => {
    expect(fail('eval', 'x')).toBe('UNKNOWN_RULE');
    expect(RULES.has('regex_replace')).toBe(false);
  });
  it('describes every rule with params and a lossy flag for the UI and agent', () => {
    const described = describeRules();
    expect(described.length).toBe(RULES.size);
    for (const d of described) expect(typeof d.lossy).toBe('boolean');
  });
  it('rejects unexpected params instead of ignoring them', () => {
    expect(fail('trim', ' a ', { extra: 1 })).toBe('INVALID_RULE_PARAMS');
    expect(fail('prefix', 'a', {})).toBe('INVALID_RULE_PARAMS');
  });
  it('passes blank/null input through as null for ordinary rules', () => {
    for (const rule of ['trim', 'lowercase', 'country_to_iso2', 'decimal_to_minor_units']) {
      expect(ok(rule, null)).toBeNull();
      expect(ok(rule, '   ')).toBeNull();
    }
  });
});

describe('text rules', () => {
  it('trim collapses whitespace', () => expect(ok('trim', '  a   b \n')).toBe('a b'));
  it('lowercase / uppercase', () => {
    expect(ok('lowercase', 'AbC')).toBe('abc');
    expect(ok('uppercase', 'AbC')).toBe('ABC');
  });
  it('title_case handles hyphens and apostrophes', () => expect(ok('title_case', "ANNE-MARIE o'neil")).toBe("Anne-Marie O'Neil"));
  it('prefix', () => expect(ok('prefix', ' C-1 ', { prefix: 'cus_' })).toBe('cus_C-1'));
  it('truncate cuts and is flagged lossy', () => {
    expect(ok('truncate', 'abcdef', { maxLength: 3 })).toBe('abc');
    expect(RULES.get('truncate')!.lossy).toBe(true);
  });
});

describe('split_name', () => {
  it.each([
    ['Priya Sharma', 'first', 'Priya'],
    ['Priya Sharma', 'last', 'Sharma'],
    ['SHARMA, Priya', 'first', 'Priya'],
    ['SHARMA, Priya', 'last', 'SHARMA'],
    ['Mary Anne Smith', 'first', 'Mary Anne'],
    ['Mary Anne Smith', 'last', 'Smith'],
  ])('%s → %s = %s', (name, part, expected) => expect(ok('split_name', name, { part })).toBe(expected));
  it('single word leaves last name null so validation can reject it', () => expect(ok('split_name', 'Cher', { part: 'last' })).toBeNull());
});

describe('parse_date', () => {
  const iso = { formats: ['YYYY-MM-DD', 'DD/MM/YYYY'] };
  it('parses each configured format', () => {
    expect(ok('parse_date', '1990-05-17', iso)).toBe('1990-05-17');
    expect(ok('parse_date', '17/05/1990', iso)).toBe('1990-05-17');
    expect(ok('parse_date', '04-Mar-2021', { formats: ['DD-MMM-YYYY'] })).toBe('2021-03-04');
    expect(ok('parse_date', '04-mar-2021', { formats: ['DD-MMM-YYYY'] })).toBe('2021-03-04');
  });
  it('rejects impossible calendar dates with a distinct code', () => {
    expect(fail('parse_date', '31/02/1990', iso)).toBe('INVALID_DATE');
    expect(fail('parse_date', '1990-13-45', iso)).toBe('INVALID_DATE');
    expect(fail('parse_date', '29-02-2021', { formats: ['DD-MM-YYYY'] })).toBe('INVALID_DATE');
  });
  it('accepts a real leap day', () => expect(ok('parse_date', '29/02/2020', iso)).toBe('2020-02-29'));
  it('rejects text that matches no format', () => expect(fail('parse_date', 'not known', iso)).toBe('DATE_FORMAT_UNRECOGNISED'));
  it('refuses the ambiguous DD/MM + MM/DD combination at parameter level', () => {
    expect(fail('parse_date', '01/02/2000', { formats: ['DD/MM/YYYY', 'MM/DD/YYYY'] })).toBe('INVALID_RULE_PARAMS');
  });
});

describe('normalize_phone', () => {
  const p = { defaultCountryCode: '+91' };
  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['98765-43210', '+919876543210'],
    ['+1 (415) 555-0132', '+14155550132'],
    ['0044 20 7946 0958', '+442079460958'],
  ])('%s → %s', (input, expected) => expect(ok('normalize_phone', input, p)).toBe(expected));
  it.each(['12345', 'call me', '+91 98'])('rejects %s', (input) => expect(fail('normalize_phone', input, p)).toBe('INVALID_PHONE'));
  it('documents the silent-wrong-country trap: a US number without +1 is accepted as +91', () => {
    expect(ok('normalize_phone', '415-555-0132', p)).toBe('+914155550132');
    expect(RULES.get('normalize_phone')!.lossy).toBe(true);
  });
});

describe('decimal_to_minor_units', () => {
  it.each([
    ['1,234.50', 123450],
    ['0.00', 0],
    ['-250.00', -25000],
    ['12', 1200],
    ['2,500,000.07', 250000007],
  ])('%s → %d', (input, expected) => expect(ok('decimal_to_minor_units', input)).toBe(expected));
  it.each(['N/A', '12,34,56x', '1.2.3', '1,23.00'])('rejects %s', (input) => expect(fail('decimal_to_minor_units', input)).toBe('INVALID_NUMBER'));
  it('refuses to round silently', () => expect(fail('decimal_to_minor_units', '1.234')).toBe('PRECISION_LOSS'));
  it('does not use floating point (0.1 + 0.2 style traps)', () => expect(ok('decimal_to_minor_units', '19.99')).toBe(1999));
});

describe('to_boolean / value_map / country / defaults', () => {
  it.each([['Y', true], ['yes', true], ['1', true], ['N', false], ['no', false], ['0', false]])('to_boolean(%s)', (i, e) => expect(ok('to_boolean', i)).toBe(e));
  it('to_boolean rejects unknown text', () => expect(fail('to_boolean', 'maybe')).toBe('INVALID_BOOLEAN'));
  it('value_map is case-insensitive and errors on unknown values', () => {
    const map = { A: 'active', I: 'inactive' };
    expect(ok('value_map', 'a', { map })).toBe('active');
    expect(fail('value_map', 'X', { map })).toBe('UNMAPPED_VALUE');
    expect(ok('value_map', 'X', { map, fallback: 'unknown' })).toBe('unknown');
    expect(fail('value_map', 'a', { map, caseInsensitive: false })).toBe('UNMAPPED_VALUE');
  });
  it('country_to_iso2 resolves names, aliases and codes; unknown is an error', () => {
    expect(ok('country_to_iso2', 'India')).toBe('IN');
    expect(ok('country_to_iso2', 'united states')).toBe('US');
    expect(ok('country_to_iso2', 'UK')).toBe('GB');
    expect(ok('country_to_iso2', 'de')).toBe('DE');
    expect(fail('country_to_iso2', 'Atlantis')).toBe('UNKNOWN_COUNTRY');
    expect(fail('country_to_iso2', 'ZZ')).toBe('UNKNOWN_COUNTRY');
  });
  it('constant ignores input; default_if_empty only fills blanks', () => {
    expect(ok('constant', null, { value: 'INR' })).toBe('INR');
    expect(ok('default_if_empty', '', { value: 'N' })).toBe('N');
    expect(ok('default_if_empty', 'Y', { value: 'N' })).toBe('Y');
  });
});
