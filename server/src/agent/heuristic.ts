import type { AppContext } from '../context.js';
import { lookupCountry } from '../domain/countries.js';
import { isRealDate } from '../domain/rules.js';
import type { Analysis, ClarificationDraft, FieldMapping, MappingSpec, Proposal, RiskLevel, SourceField, Step, TargetField } from '../domain/types.js';
import { getSourceRows } from '../services/sourceStore.js';
import type { ToolResult } from './tools.js';

/**
 * Deterministic, rule-based fallback for when no LLM is configured (or the operator forces it).
 *
 * It is NOT an AI agent and is labelled as such everywhere in the UI and logs. It exists so the
 * workbench is fully usable offline, in CI, and as a safety net when the API is unavailable. It goes
 * through the same inspection tools, the same validation and the same submit_proposal gate as the LLM,
 * so what a human reviews has exactly the same shape.
 */

type Call = (name: string, input?: unknown) => ToolResult;

const GROUPS: string[][] = [
  ['email', 'mail'],
  ['phone', 'mobile', 'tel', 'telephone', 'cell'],
  ['dob', 'birth', 'birthdate', 'born'],
  ['signup', 'created', 'joined', 'since', 'registration', 'registered'],
  ['balance', 'amount', 'funds'],
  ['country', 'nation'],
  ['status', 'state'],
  ['segment', 'tier', 'level'],
  ['address', 'street'],
  ['optin', 'consent', 'newsletter'],
];
const canon = (t: string) => GROUPS.find((g) => g.includes(t))?.[0] ?? t;
const tokens = (name: string) => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(canon));

function score(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter === 0 ? 0 : inter / new Set([...ta, ...tb]).size;
}

const isNameField = (t: TargetField) => /(^|_)(first|last)(_|$)/.test(t.name) && /name/.test(t.name);

const COMMERCIAL: Record<string, string> = { retail: 'standard', basic: 'standard', standard: 'standard', gold: 'premium', silver: 'premium', premium: 'premium', platinum: 'vip', enterprise: 'vip', vip: 'vip' };
const CURRENCY_BY_COUNTRY: Record<string, string> = { IN: 'INR', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR' };
const DIAL_BY_COUNTRY: Record<string, string> = { IN: '+91', US: '+1', GB: '+44', DE: '+49', SG: '+65', AE: '+971' };

interface Built {
  mapping: FieldMapping;
  questions: ClarificationDraft[];
  notes: string[];
}

export function buildHeuristicProposal(ctx: AppContext, call: Call): Proposal {
  const { source, target } = ctx;
  call('get_source_schema');
  call('get_target_schema');
  call('list_transformation_rules');
  call('get_sample_records', { limit: 3 });

  const rows = getSourceRows(ctx.db);
  const col = (f: string) => rows.map((r) => r.payload[f] ?? null);
  for (const f of source.fields) call('profile_source_field', { field: f.name });

  // ---- match target → source -------------------------------------------------------------------
  const pairs: Array<{ t: TargetField; s: SourceField; score: number }> = [];
  for (const t of target.fields) for (const s of source.fields) pairs.push({ t, s, score: score(t.name, s.name) + (t.name === s.name ? 1 : 0) });
  pairs.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  const assignedTarget = new Map<string, string>();
  const usedSource = new Map<string, number>();
  for (const p of pairs) {
    if (p.score < 0.25 || assignedTarget.has(p.t.name)) continue;
    const used = usedSource.get(p.s.name) ?? 0;
    if (used > 0 && !(isNameField(p.t) && /name/.test(p.s.name))) continue;
    assignedTarget.set(p.t.name, p.s.name);
    usedSource.set(p.s.name, used + 1);
  }

  // ---- country statistics used for defaults -----------------------------------------------------
  const countryCounts = new Map<string, number>();
  for (const v of col('country')) {
    const iso = v ? lookupCountry(v) : null;
    if (iso) countryCounts.set(iso, (countryCounts.get(iso) ?? 0) + 1);
  }
  const modalCountry = [...countryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'IN';

  // ---- build each field -------------------------------------------------------------------------
  const built: Built[] = target.fields.map((t) => buildField(t, assignedTarget.get(t.name) ?? null));

  function buildField(t: TargetField, src: string | null): Built {
    const questions: ClarificationDraft[] = [];
    const notes: string[] = [];
    const steps: Step[] = [];
    let risk: RiskLevel = 'low';
    let rationale = '';
    const values = src ? col(src).filter((v): v is string => v !== null && v.trim() !== '') : [];
    const blanks = src ? col(src).length - values.length : 0;

    if (src === null) {
      // no source: invented value → assumption + blocking question
      risk = 'high';
      const options = t.enum ?? [];
      const guess = t.enum ? (t.name === 'currency' ? (CURRENCY_BY_COUNTRY[modalCountry] ?? options[0]) : options[0]) : '';
      steps.push({ rule: 'constant', params: { value: guess ?? '' } });
      rationale = `The source has no equivalent of '${t.name}'. Using constant '${guess}' (most common country is ${modalCountry}) as a placeholder until a reviewer confirms.`;
      questions.push({
        field: t.name,
        question: `The legacy export has no '${t.name}'. What value should every migrated record get?`,
        options,
        proposedAssumption: String(guess ?? ''),
        blocking: true,
      });
      return { mapping: { target: t.name, source: null, steps, risk, rationale }, questions, notes };
    }

    if (isNameField(t)) {
      const part = t.name.includes('first') ? 'first' : 'last';
      steps.push({ rule: 'split_name', params: { part } });
      const caps = values.filter((v) => v === v.toUpperCase() && /[A-Z]/.test(v)).length;
      if (caps >= 3) steps.push({ rule: 'title_case' });
      risk = 'medium';
      rationale = `Splits '${src}' (mixed 'First Last' and 'LAST, First'${caps ? `, ${caps} all-caps` : ''}); name parsing is heuristic and single-word names leave '${part === 'last' ? 'last' : 'first'}_name empty.`;
    } else if (t.name === target.primaryKey && t.pattern && /^\^([a-z]+_)/.test(t.pattern)) {
      const prefix = t.pattern.match(/^\^([a-z]+_)/)![1]!;
      steps.push({ rule: 'prefix', params: { prefix } });
      rationale = `Deterministic key: '${prefix}' + legacy ${src}, so retries can never create a second row.`;
    } else if (t.type === 'date') {
      const formats = detectDateFormats(values);
      steps.push({ rule: 'parse_date', params: { formats: formats.formats } });
      if (formats.ambiguous) risk = 'medium';
      rationale = `Observed formats: ${formats.formats.join(', ')}.${formats.ambiguous ? ' Slash dates are ambiguous between DD/MM and MM/DD; chose by how many values are valid.' : ''} Impossible dates are rejected.`;
    } else if (t.type === 'integer' && values.length > 0 && values.filter((v) => /^-?[\d,]+(\.\d+)?$/.test(v)).length / values.length > 0.8) {
      steps.push({ rule: 'decimal_to_minor_units', params: { decimals: 2 } });
      risk = 'medium';
      rationale = `Money text → integer minor units using exact string arithmetic. The legacy balance carries no currency (see the currency question).`;
    } else if (t.type === 'boolean') {
      if (blanks > 0) {
        steps.push({ rule: 'default_if_empty', params: { value: 'N' } });
        risk = 'medium';
        questions.push({
          field: t.name,
          question: `${blanks} records have a blank '${src}' (consent unknown). Should blank be treated as opt-out (false)?`,
          options: ['Yes, treat blank as opt-out', 'No, reject records with unknown consent'],
          proposedAssumption: 'Yes, treat blank as opt-out',
          blocking: true,
        });
      }
      steps.push({ rule: 'to_boolean' });
      rationale = `Maps Y/yes/1 and N/no/0 to booleans; unrecognised text is rejected.${blanks ? ' Blank consent defaults to opt-out (needs confirmation).' : ''}`;
    } else if (t.type === 'enum' && values.length > 0) {
      const map: Record<string, string> = {};
      const distinct = [...new Set(values)];
      for (const v of distinct) {
        const low = v.toLowerCase();
        const exact = t.enum!.find((e) => e.toLowerCase() === low);
        const initial = t.enum!.filter((e) => e[0]!.toLowerCase() === low);
        const commercial = COMMERCIAL[low];
        const hit = exact ?? (initial.length === 1 ? initial[0] : undefined) ?? (commercial && t.enum!.includes(commercial) ? commercial : undefined);
        if (hit) map[v] = hit;
      }
      steps.push({ rule: 'value_map', params: { map: Object.keys(map).length ? map : { [distinct[0]!]: t.enum![0]! } } });
      const commercialGuess = distinct.some((v) => COMMERCIAL[v.toLowerCase()] && !t.enum!.some((e) => e.toLowerCase() === v.toLowerCase()));
      if (commercialGuess) {
        risk = 'high';
        questions.push({
          field: t.name,
          question: `How should legacy '${src}' values map to '${t.name}' (${t.enum!.join(', ')})? Current guess: ${Object.entries(map).map(([k, v]) => `${k}→${v}`).join(', ')}.`,
          options: t.enum,
          proposedAssumption: Object.entries(map).map(([k, v]) => `${k}→${v}`).join(', '),
          blocking: true,
        });
        rationale = `No lexical link between the legacy values and the target enum; mapping uses a commercial-vocabulary guess that a reviewer must confirm.`;
      } else {
        rationale = `Explicit table for the observed codes; codes outside the table are rejected rather than guessed.`;
      }
      const unmapped = distinct.filter((v) => !(v in map));
      if (unmapped.length) rationale += ` Unmapped observed values: ${unmapped.map((v) => `'${v}'`).join(', ')}.`;
    } else if (/phone/.test(t.name) && t.pattern?.startsWith('^\\+')) {
      const dial = DIAL_BY_COUNTRY[modalCountry] ?? '+91';
      steps.push({ rule: 'normalize_phone', params: { defaultCountryCode: dial } });
      risk = 'high';
      rationale = `Normalises to E.164; numbers written without a country code get ${dial} (most common country). A foreign number without +CC would be silently mis-prefixed.`;
      questions.push({
        field: t.name,
        question: `Phone numbers without a country code are assumed to be ${dial}. Is that correct for every country in the data?`,
        options: [`Yes, ${dial} for all`, 'No, route those records to review'],
        proposedAssumption: `Yes, ${dial} for all`,
        blocking: false,
      });
    } else if (t.type === 'string' && /country/.test(t.name) && t.pattern === '^[A-Z]{2}$') {
      steps.push({ rule: 'country_to_iso2' });
      rationale = 'Fixed lookup of names, aliases and codes; unknown countries are rejected.';
    } else if (t.type === 'string' && t.pattern && /a-z/.test(t.pattern) && !/A-Z/.test(t.pattern)) {
      steps.push({ rule: 'trim' }, { rule: 'lowercase' });
      rationale = `Target pattern is lower-case only and the field is unique, so case is normalised before validation and the uniqueness check.`;
    } else {
      steps.push({ rule: 'trim' });
      const longest = Math.max(0, ...values.map((v) => v.trim().length));
      rationale = t.maxLength && longest > t.maxLength ? `Trimmed only. ${values.filter((v) => v.trim().length > t.maxLength!).length} values exceed the ${t.maxLength}-char limit and will be rejected, not truncated.` : 'Trimmed copy.';
      if (t.maxLength && longest > t.maxLength) {
        risk = 'medium';
        questions.push({
          field: t.name,
          question: `Some '${src}' values exceed the target limit of ${t.maxLength} characters. Reject them (current) or truncate (loses information)?`,
          options: ['Reject and quarantine', 'Truncate to limit'],
          proposedAssumption: 'Reject and quarantine',
          blocking: false,
        });
      }
    }
    return { mapping: { target: t.name, source: src, steps, risk, rationale }, questions, notes };
  }

  const fields = built.map((b) => b.mapping);
  const mappedSources = new Set(fields.map((f) => f.source).filter(Boolean));
  const unmappedSource = source.fields
    .filter((f) => !mappedSources.has(f.name))
    .map((f) => ({ field: f.name, reason: `No target field has a comparable meaning, so '${f.name}' is not migrated. Its values are dropped.` }));
  const mapping: MappingSpec = { fields, unmappedSource };

  const questions = built.flatMap((b) => b.questions);
  for (const u of unmappedSource) {
    questions.push({ field: null, question: `Source field '${u.field}' has no target column and will be dropped. Is losing it acceptable?`, options: ['Yes, drop it', 'No, add a target column first'], proposedAssumption: 'Yes, drop it', blocking: false });
  }

  // ---- validate and measure with the same tools the LLM uses -------------------------------------
  const validation = call('validate_mapping', { mapping });
  if ((validation.output as { valid?: boolean }).valid !== true) throw new Error(`Heuristic mapping failed validation: ${JSON.stringify(validation.output)}`);
  const dry = call('dry_run_summary', { mapping }).output as {
    counts: { source: number; transformed: number; accepted: number; rejected: number };
    breakdown: { byCode: Record<string, number> };
    loadPreview: { wouldConflict: number };
  };
  call('preview_transform', { mapping, onlyFailures: true, limit: 5 });

  // ---- analysis ---------------------------------------------------------------------------------
  const topCodes = Object.entries(dry.breakdown.byCode).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const missingTargetFields = fields.filter((f) => f.source === null).map((f) => ({ field: f.target, issue: 'No source field exists in the legacy export.', proposedResolution: `Constant ${JSON.stringify((f.steps[0]!.params as { value: unknown }).value)} until a reviewer confirms the correct value.` }));

  const incompat: Analysis['incompatibilities'] = [];
  for (const u of unmappedSource) incompat.push({ sourceField: u.field, targetField: null, issue: `No target column for '${u.field}'.`, handling: 'Listed as dropped; reviewer must acknowledge the loss.' });
  incompat.push({ sourceField: 'full_name', targetField: 'first_name / last_name', issue: 'One source column must feed two target columns.', handling: 'split_name heuristic; single-word names leave last_name empty and are rejected.' });
  const longAddr = target.fields.find((f) => f.maxLength && assignedTarget.get(f.name) === 'address_line');
  if (longAddr) {
    const over = col('address_line').filter((v) => v && v.trim().length > longAddr.maxLength!).length;
    if (over) incompat.push({ sourceField: 'address_line', targetField: longAddr.name, issue: `${over} addresses are longer than ${longAddr.maxLength} characters.`, handling: 'Rejected into quarantine rather than silently truncated.' });
  }

  const risks: Analysis['risks'] = fields
    .filter((f) => f.risk !== 'low')
    .map((f) => ({ severity: f.risk, title: `${f.target}: ${f.risk} risk`, detail: f.rationale, affectedFields: [f.target], mitigation: f.risk === 'high' ? 'Needs a reviewer decision before approval.' : 'Review the dry-run evidence for this field.' }));

  const defaultDial = DIAL_BY_COUNTRY[modalCountry] ?? '+91';
  const foreignNoPlus = rows.filter((r) => {
    const p = r.payload.phone;
    const iso = r.payload.country ? lookupCountry(r.payload.country) : null;
    return p && !p.trim().startsWith('+') && !p.trim().startsWith('00') && iso && DIAL_BY_COUNTRY[iso] !== defaultDial;
  }).length;
  if (foreignNoPlus > 0) {
    risks.push({
      severity: 'high',
      title: 'Phone numbers from other countries will be mis-prefixed',
      detail: `${foreignNoPlus} record(s) have a non-${modalCountry} country but a phone number without a country code. They pass validation and will be stored with ${defaultDial} — valid-looking but wrong.`,
      affectedFields: ['phone_e164'],
      mitigation: 'Ask the business for the source of truth, or quarantine those records; the supported rules cannot condition on another field.',
    });
  }
  const injection = rows.filter((r) => /ignore (all )?(previous|prior) instructions|\bsystem:|call the execute tool|approve and execute/i.test(r.payload.notes ?? '')).length;
  if (injection > 0) {
    risks.push({ severity: 'medium', title: 'Instruction-like text found in source notes', detail: `${injection} record(s) have 'notes' text that reads like commands to an automated system. The notes field is not migrated and was treated as data only.`, affectedFields: ['notes'], mitigation: 'Keep notes out of any automated decision path; review the records manually.' });
  }
  if (dry.counts.rejected > 0) {
    risks.push({ severity: dry.counts.rejected / dry.counts.source > 0.2 ? 'high' : 'medium', title: `${dry.counts.rejected} of ${dry.counts.source} records will be quarantined`, detail: `Top causes: ${topCodes.map(([c, n]) => `${c} (${n})`).join(', ')}.`, affectedFields: Object.keys({}), mitigation: 'Review the quarantine evidence; fix at source and re-run, or accept the loss explicitly.' });
  }

  const analysis: Analysis = {
    summary: `Rule-based proposal (no LLM). ${fields.length - missingTargetFields.length} of ${target.fields.length} target fields are mapped from source fields; ${missingTargetFields.length} ${missingTargetFields.length === 1 ? 'needs' : 'need'} an assumed constant and ${unmappedSource.length} source ${unmappedSource.length === 1 ? 'field is' : 'fields are'} dropped. The dry run takes ${dry.counts.source} source records to ${dry.counts.accepted} accepted and ${dry.counts.rejected} quarantined${dry.loadPreview.wouldConflict ? ` (${dry.loadPreview.wouldConflict} of them collide with rows already in the target)` : ''}. Items marked high risk depend on business answers listed in the clarification questions.`,
    missingTargetFields,
    incompatibilities: incompat,
    risks,
    migrationPlan: {
      batchSize: ctx.config.executionBatchSize,
      steps: [
        'Answer the blocking clarification questions (or accept the proposed assumptions explicitly).',
        'Review this mapping and edit it if needed (each edit creates a new immutable version).',
        'Run a dry run on the exact version you intend to approve and inspect the quarantined records and their field-level evidence.',
        'Approve the version (records who, when, and which dry run).',
        `Execute in batches of ${ctx.config.executionBatchSize}; each source record maps to a deterministic target key so retries cannot duplicate.`,
        'Compare source and target totals, control totals and quarantine counts in the reconciliation panel.',
        'Roll back the execution if reconciliation fails or the business rejects the result.',
      ],
      rollbackCriteria: ['Reconciliation reports any failed check.', 'Spot checks of migrated rows disagree with the source.', 'A confirmed assumption (currency, tier, consent) turns out to be wrong.'],
    },
  };

  return { mapping, analysis, clarificationQuestions: questions };
}

function detectDateFormats(values: string[]): { formats: ('YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'DD-MM-YYYY' | 'DD-MMM-YYYY' | 'YYYY/MM/DD')[]; ambiguous: boolean } {
  const formats: ('YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'DD-MM-YYYY' | 'DD-MMM-YYYY' | 'YYYY/MM/DD')[] = [];
  let ambiguous = false;
  if (values.some((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) formats.push('YYYY-MM-DD');
  if (values.some((v) => /^\d{4}\/\d{2}\/\d{2}$/.test(v))) formats.push('YYYY/MM/DD');
  if (values.some((v) => /^\d{2}-[A-Za-z]{3}-\d{4}$/.test(v))) formats.push('DD-MMM-YYYY');
  if (values.some((v) => /^\d{2}-\d{2}-\d{4}$/.test(v))) formats.push('DD-MM-YYYY');
  const slash = values.filter((v) => /^\d{2}\/\d{2}\/\d{4}$/.test(v));
  if (slash.length) {
    let dmy = 0;
    let mdy = 0;
    for (const v of slash) {
      const [a, b, y] = v.split('/').map(Number) as [number, number, number];
      if (isRealDate(y, b, a)) dmy++;
      if (isRealDate(y, a, b)) mdy++;
      if (a <= 12 && b <= 12 && a !== b) ambiguous = true;
    }
    formats.push(mdy > dmy ? 'MM/DD/YYYY' : 'DD/MM/YYYY');
  }
  return { formats: formats.length ? formats : ['YYYY-MM-DD'], ambiguous };
}
