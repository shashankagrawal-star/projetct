// Fixed lookup table for the country_to_iso2 rule. Deliberately small and explicit: the rule never guesses.
const ENTRIES: Array<[string, string[]]> = [
  ['IN', ['india', 'bharat']],
  ['US', ['usa', 'united states', 'united states of america', 'u.s.a.', 'u.s.']],
  ['GB', ['uk', 'united kingdom', 'great britain', 'england', 'u.k.']],
  ['DE', ['germany', 'deutschland']],
  ['SG', ['singapore']],
  ['AE', ['uae', 'united arab emirates', 'u.a.e.']],
  ['FR', ['france']],
  ['CA', ['canada']],
  ['AU', ['australia']],
  ['JP', ['japan']],
  ['CN', ['china']],
  ['NL', ['netherlands', 'holland']],
  ['SE', ['sweden']],
  ['CH', ['switzerland']],
  ['IE', ['ireland']],
  ['ES', ['spain']],
  ['IT', ['italy']],
  ['BR', ['brazil']],
  ['ZA', ['south africa']],
  ['NZ', ['new zealand']],
];

export const ISO2_CODES = new Set(ENTRIES.map(([code]) => code));
const ALIASES = new Map<string, string>();
for (const [code, names] of ENTRIES) {
  for (const name of names) ALIASES.set(name, code);
}

export function lookupCountry(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (ALIASES.has(key)) return ALIASES.get(key)!;
  const upper = raw.trim().toUpperCase();
  return ISO2_CODES.has(upper) ? upper : null;
}
