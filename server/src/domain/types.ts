import { z } from 'zod';

export type Scalar = string | number | boolean | null;
export type SourceRecord = Record<string, string | null>;

// ---- schemas -----------------------------------------------------------------------------------
export interface SourceField {
  name: string;
  type: 'string';
  nullable: boolean;
  description: string;
}
export interface SourceSchema {
  name: string;
  description: string;
  primaryKey: string;
  fields: SourceField[];
}

export type TargetType = 'string' | 'integer' | 'boolean' | 'date' | 'enum';
export interface TargetField {
  name: string;
  type: TargetType;
  required: boolean;
  unique?: boolean;
  enum?: string[];
  pattern?: string;
  maxLength?: number;
  description: string;
}
export interface TargetSchema {
  name: string;
  description: string;
  primaryKey: string;
  fields: TargetField[];
}

// ---- mapping spec (the thing that is versioned, reviewed and approved) -------------------------
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const stepSchema = z.object({
  rule: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type Step = z.infer<typeof stepSchema>;

export const fieldMappingSchema = z.object({
  target: z.string().min(1),
  source: z.string().min(1).nullable(),
  steps: z.array(stepSchema).max(6),
  risk: z.enum(RISK_LEVELS),
  rationale: z.string().max(1000),
});
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

export const unmappedSourceSchema = z.object({
  field: z.string().min(1),
  reason: z.string().max(1000),
});

export const mappingSpecSchema = z.object({
  fields: z.array(fieldMappingSchema).max(100),
  // source fields the plan deliberately does not migrate (acknowledged data loss)
  unmappedSource: z.array(unmappedSourceSchema).max(100),
});
export type MappingSpec = z.infer<typeof mappingSpecSchema>;

// ---- agent / analysis payload stored with a plan version ----------------------------------------
export const riskItemSchema = z.object({
  severity: z.enum(RISK_LEVELS),
  title: z.string().max(200),
  detail: z.string().max(2000),
  affectedFields: z.array(z.string()).max(30),
  mitigation: z.string().max(1000),
});
export const clarificationDraftSchema = z.object({
  field: z.string().nullable(),
  question: z.string().min(3).max(600),
  options: z.array(z.string().max(120)).max(8).optional(),
  proposedAssumption: z.string().max(300).optional(),
  blocking: z.boolean(),
});
export type ClarificationDraft = z.infer<typeof clarificationDraftSchema>;

export const analysisSchema = z.object({
  summary: z.string().max(4000),
  missingTargetFields: z
    .array(z.object({ field: z.string(), issue: z.string().max(800), proposedResolution: z.string().max(800) }))
    .max(50),
  incompatibilities: z
    .array(z.object({ sourceField: z.string().nullable(), targetField: z.string().nullable(), issue: z.string().max(800), handling: z.string().max(800) }))
    .max(50),
  risks: z.array(riskItemSchema).max(40),
  migrationPlan: z.object({
    batchSize: z.number().int().min(1).max(500),
    steps: z.array(z.string().max(500)).min(1).max(20),
    rollbackCriteria: z.array(z.string().max(500)).max(10),
  }),
});
export type Analysis = z.infer<typeof analysisSchema>;

export const proposalSchema = z.object({
  mapping: mappingSpecSchema,
  analysis: analysisSchema,
  clarificationQuestions: z.array(clarificationDraftSchema).max(15),
});
export type Proposal = z.infer<typeof proposalSchema>;

// ---- evidence ----------------------------------------------------------------------------------
export type ErrorStage = 'transform' | 'validate' | 'duplicate' | 'load';
export interface FieldError {
  stage: ErrorStage;
  targetField: string;
  sourceField: string | null;
  rule: string | null;
  code: string;
  message: string;
  sourceValue: unknown;
  transformedValue?: unknown;
  details?: Record<string, unknown>;
}

export interface RecordOutcome {
  sourceKey: string;
  status: 'accepted' | 'rejected';
  source: SourceRecord;
  transformed: Record<string, Scalar>;
  errors: FieldError[];
}

export interface RunCounts {
  source: number;
  transformed: number; // records with no transform-stage error
  accepted: number; // records that passed transform + validation + uniqueness
  rejected: number; // quarantined (source - accepted)
}
