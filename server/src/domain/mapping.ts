import { RULES, type OutputType } from './rules.js';
import { mappingSpecSchema, type MappingSpec, type SourceSchema, type TargetSchema, type TargetType } from './types.js';

export interface MappingIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  targetField?: string;
  sourceField?: string;
}

export interface MappingValidation {
  valid: boolean; // no errors (warnings allowed)
  errors: MappingIssue[];
  warnings: MappingIssue[];
}

const TARGET_ACCEPTS: Record<TargetType, OutputType[]> = {
  string: ['string', 'scalar'],
  enum: ['string', 'scalar'],
  date: ['date', 'string', 'scalar'],
  integer: ['integer', 'scalar'],
  boolean: ['boolean', 'scalar'],
};

/** Final output type of a rule chain. A chain with no steps passes the (string) source value through. */
function chainOutputType(steps: MappingSpec['fields'][number]['steps']): OutputType {
  let out: OutputType = 'string';
  for (const step of steps) {
    const def = RULES.get(step.rule);
    if (def) out = def.outputType;
  }
  return out;
}

/**
 * Structural validation of a mapping against the schemas and the rule registry. It never looks at
 * data: that is what the dry run is for. Errors block approval; warnings are shown to the reviewer.
 */
export function validateMapping(input: unknown, source: SourceSchema, target: TargetSchema): MappingValidation {
  const errors: MappingIssue[] = [];
  const warnings: MappingIssue[] = [];

  const parsed = mappingSpecSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ severity: 'error', code: 'MALFORMED_MAPPING', message: `${issue.path.join('.') || 'mapping'}: ${issue.message}` });
    }
    return { valid: false, errors, warnings };
  }
  const mapping = parsed.data;

  const sourceNames = new Set(source.fields.map((f) => f.name));
  const targetByName = new Map(target.fields.map((f) => [f.name, f]));
  const seenTargets = new Set<string>();
  const usedSources = new Set<string>();

  for (const fm of mapping.fields) {
    const tf = targetByName.get(fm.target);
    if (!tf) {
      errors.push({ severity: 'error', code: 'UNKNOWN_TARGET_FIELD', message: `Target field '${fm.target}' does not exist in ${target.name}`, targetField: fm.target });
      continue;
    }
    if (seenTargets.has(fm.target)) {
      errors.push({ severity: 'error', code: 'DUPLICATE_TARGET', message: `Target field '${fm.target}' is mapped more than once`, targetField: fm.target });
    }
    seenTargets.add(fm.target);

    if (fm.source !== null) {
      if (!sourceNames.has(fm.source)) {
        errors.push({ severity: 'error', code: 'UNKNOWN_SOURCE_FIELD', message: `Source field '${fm.source}' does not exist in ${source.name}`, targetField: fm.target, sourceField: fm.source });
      } else {
        usedSources.add(fm.source);
      }
    }

    let producesValueWithoutInput = false;
    fm.steps.forEach((step, idx) => {
      const def = RULES.get(step.rule);
      if (!def) {
        errors.push({ severity: 'error', code: 'UNKNOWN_RULE', message: `Step ${idx + 1} of '${fm.target}' uses unsupported rule '${step.rule}'`, targetField: fm.target });
        return;
      }
      const params = def.paramsSchema.safeParse(step.params ?? {});
      if (!params.success) {
        errors.push({
          severity: 'error',
          code: 'INVALID_RULE_PARAMS',
          message: `Step ${idx + 1} (${step.rule}) of '${fm.target}': ${params.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
          targetField: fm.target,
        });
      }
      if (def.ignoresInput && step.rule === 'constant') producesValueWithoutInput = true;
      if (def.lossy) {
        warnings.push({ severity: 'warning', code: 'LOSSY_RULE', message: `'${fm.target}' uses lossy rule '${step.rule}' — review the dry-run evidence`, targetField: fm.target });
      }
    });

    if (fm.source === null && !producesValueWithoutInput) {
      errors.push({
        severity: 'error',
        code: 'NO_SOURCE_NEEDS_CONSTANT',
        message: `Target '${fm.target}' has no source field, so its first step must be a 'constant'`,
        targetField: fm.target,
      });
    }

    const out = chainOutputType(fm.steps);
    if (!TARGET_ACCEPTS[tf.type].includes(out)) {
      warnings.push({
        severity: 'warning',
        code: 'OUTPUT_TYPE_MISMATCH',
        message: `'${fm.target}' expects ${tf.type} but the rule chain produces ${out}`,
        targetField: fm.target,
      });
    }
  }

  for (const tf of target.fields) {
    if (!seenTargets.has(tf.name)) {
      if (tf.required) {
        errors.push({ severity: 'error', code: 'REQUIRED_TARGET_UNMAPPED', message: `Required target field '${tf.name}' has no mapping`, targetField: tf.name });
      } else {
        warnings.push({ severity: 'warning', code: 'OPTIONAL_TARGET_UNMAPPED', message: `Optional target field '${tf.name}' is not populated`, targetField: tf.name });
      }
    }
  }

  const acknowledged = new Set(mapping.unmappedSource.map((u) => u.field));
  for (const u of mapping.unmappedSource) {
    if (!sourceNames.has(u.field)) {
      errors.push({ severity: 'error', code: 'UNKNOWN_SOURCE_FIELD', message: `unmappedSource lists '${u.field}', which is not a source field`, sourceField: u.field });
    }
    if (usedSources.has(u.field)) {
      warnings.push({ severity: 'warning', code: 'CONTRADICTORY_UNMAPPED', message: `Source field '${u.field}' is both mapped and listed as unmapped`, sourceField: u.field });
    }
  }
  for (const sf of source.fields) {
    if (!usedSources.has(sf.name) && !acknowledged.has(sf.name)) {
      errors.push({
        severity: 'error',
        code: 'SOURCE_FIELD_UNACCOUNTED',
        message: `Source field '${sf.name}' is neither mapped nor explicitly listed as dropped (unmappedSource). Silent data loss is not allowed.`,
        sourceField: sf.name,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
