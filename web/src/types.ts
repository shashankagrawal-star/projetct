export type Risk = 'low' | 'medium' | 'high';
export type PlanStatus = 'proposed' | 'draft' | 'approved' | 'rejected';
export type Scalar = string | number | boolean | null;

export interface SourceField { name: string; type: string; nullable: boolean; description: string }
export interface SourceSchema { name: string; description: string; primaryKey: string; fields: SourceField[] }
export interface TargetField { name: string; type: string; required: boolean; unique?: boolean; enum?: string[]; pattern?: string; maxLength?: number; description: string }
export interface TargetSchema { name: string; description: string; primaryKey: string; fields: TargetField[] }

export interface ParamSpec { name: string; type: 'string' | 'string[]' | 'record' | 'integer' | 'boolean' | 'scalar' | 'enum'; required: boolean; description: string; enum?: string[]; default?: unknown }
export interface RuleInfo { id: string; label: string; description: string; category: string; params: ParamSpec[]; lossy: boolean; ignoresInput: boolean; outputType: string }

export interface Step { rule: string; params?: Record<string, unknown> }
export interface FieldMapping { target: string; source: string | null; steps: Step[]; risk: Risk; rationale: string }
export interface MappingSpec { fields: FieldMapping[]; unmappedSource: Array<{ field: string; reason: string }> }

export interface Analysis {
  summary: string;
  missingTargetFields: Array<{ field: string; issue: string; proposedResolution: string }>;
  incompatibilities: Array<{ sourceField: string | null; targetField: string | null; issue: string; handling: string }>;
  risks: Array<{ severity: Risk; title: string; detail: string; affectedFields: string[]; mitigation: string }>;
  migrationPlan: { batchSize: number; steps: string[]; rollbackCriteria: string[] };
}

export interface PlanVersion {
  version: number; parentVersion: number | null; status: PlanStatus; origin: 'agent' | 'user';
  mapping: MappingSpec; mappingHash: string; analysis: Analysis | null; note: string | null;
  agentRunId: number | null; createdBy: string; createdAt: string;
}
export interface Counts { source: number; transformed: number; accepted: number; rejected: number }
export interface PlanSummary extends PlanVersion {
  validation: { valid: boolean; errors: number; warnings: number };
  latestDryRun: { id: number; counts: Counts; createdAt: string } | null;
}
export interface MappingIssue { severity: 'error' | 'warning'; code: string; message: string; targetField?: string; sourceField?: string }
export interface Validation { valid: boolean; errors: MappingIssue[]; warnings: MappingIssue[] }
export interface Blocker { code: string; message: string }
export interface Readiness { ready: boolean; blockers: Blocker[]; validation: Validation; dryRunId: number | null }
export interface Approval { id: number; planVersion: number; mappingHash: string; dryRunId: number | null; decision: 'approved' | 'rejected'; actor: string; comment: string | null; createdAt: string }

export interface Clarification {
  qid: string; raisedInVersion: number; field: string | null; question: string; options: string[];
  proposedAssumption: string | null; blocking: boolean; status: 'open' | 'answered' | 'dismissed';
  answer: string | null; answeredBy: string | null; answeredAt: string | null;
}

export interface Breakdown { byStage: Record<string, number>; byCode: Record<string, number>; byField: Record<string, number> }
export interface LoadPreview { validated: number; wouldInsert: number; wouldSkipExisting: number; wouldConflict: number; conflicts: Array<{ sourceKey: string; field: string; value: string; existingId: string }> }
export interface DryRun { id: number; planVersion: number; mappingHash: string; sourceHash: string; transformHash: string; counts: Counts; breakdown: Breakdown; loadPreview: LoadPreview; actor: string; createdAt: string }

export interface FieldError { stage: 'transform' | 'validate' | 'duplicate' | 'load'; targetField: string; sourceField: string | null; rule: string | null; code: string; message: string; sourceValue: unknown; transformedValue?: unknown; details?: Record<string, unknown> }
export interface RunRecord { seq: number; sourceKey: string; status: string; source: Record<string, string | null>; transformed: Record<string, Scalar>; errors: FieldError[] }
export interface RecordsPage { total: number; records: RunRecord[] }

export interface ExecutionCounts { source: number; transformed: number; accepted: number; rejected: number; loaded: number; skippedExisting: number; pending: number; duplicatesPrevented: number; rolledBack: number }
export interface Attempt { attemptNo: number; trigger: 'initial' | 'retry'; status: 'running' | 'failed' | 'completed'; inserted: number; duplicatesPrevented: number; loadRejected: number; error: string | null; actor: string; startedAt: string; finishedAt: string | null }
export interface Rollback { id: number; reason: string; rowsRemoved: number; targetRowsAfter: number; actor: string; createdAt: string }
export interface Execution {
  id: number; planVersion: number; dryRunId: number; approvalId: number; idempotencyKey: string | null;
  status: 'running' | 'failed' | 'completed' | 'rolled_back'; mappingHash: string; sourceHash: string; transformHash: string;
  baselineTargetRows: number; counts: ExecutionCounts; attempts: Attempt[]; rollbacks: Rollback[]; error: string | null;
  createdBy: string; createdAt: string; finishedAt: string | null;
}
export interface ReconCheck { id: string; label: string; expected: number | string; actual: number | string; pass: boolean; note?: string }
export interface Reconciliation {
  executionId: number; executionStatus: string; status: 'pass' | 'fail';
  totals: { sourceTotal: number; targetBefore: number; targetNow: number; targetMigrated: number; quarantined: number; loaded: number; skippedExisting: number; pending: number };
  checks: ReconCheck[]; checkedAt: string;
}

export interface AuditEntry { id: number; ts: string; actor: string; event: string; entityType: string; entityId: string; details: Record<string, unknown> }
export interface AgentRun {
  id: number; kind: 'propose' | 'revise'; mode: 'llm' | 'heuristic'; model: string | null; status: 'running' | 'succeeded' | 'failed';
  instructions: string | null; baseVersion: number | null; resultVersion: number | null; error: string | null;
  inputTokens: number; outputTokens: number; actor: string; startedAt: string; finishedAt: string | null;
}
export interface AgentEvent { seq: number; ts: string; type: string; name: string | null; payload: any; durationMs: number | null }

export interface AppConfig {
  agent: { mode: 'llm' | 'heuristic'; model: string | null; available: boolean; configuredMode: string };
  maxSampleSize: number; executionBatchSize: number; allowFailureInjection: boolean; sourceRecords: number;
}
export interface Overview {
  sourceRecords: number;
  target: { total: number; preExisting: number; migrated: number };
  plans: { count: number; latest: { version: number; status: PlanStatus; origin: string } | null; approved: { version: number } | null };
  questions: { total: number; openBlocking: number };
  dryRun: DryRun | null;
  execution: Execution | null;
  reconciliation: { status: 'pass' | 'fail'; executionId: number } | null;
}
export type SourceRecord_ = Record<string, string | null>;
