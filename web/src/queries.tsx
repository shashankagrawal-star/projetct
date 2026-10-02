import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { get, post, errorMessage } from './api';
import { ErrorBanner, Loading, useToast } from './ui';
import type {
  AgentRun, AppConfig, Approval, AuditEntry, Clarification, DryRun, Execution, MappingSpec, Overview, PlanSummary, PlanVersion,
  Readiness, Reconciliation, RuleInfo, SourceSchema, TargetSchema, Validation,
} from './types';

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => get<AppConfig>('/config'), staleTime: 60_000 });
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => get<Overview>('/overview'), refetchInterval: 15_000 });
export const useRules = () => useQuery({ queryKey: ['rules'], queryFn: () => get<RuleInfo[]>('/rules'), staleTime: Infinity });
export const useSource = () => useQuery({ queryKey: ['source'], queryFn: () => get<{ schema: SourceSchema; total: number }>('/source'), staleTime: Infinity });
export const useTarget = () => useQuery({ queryKey: ['target'], queryFn: () => get<{ schema: TargetSchema; total: number; preExisting: number; migrated: number }>('/target') });
export const usePlans = () => useQuery({ queryKey: ['plans'], queryFn: () => get<PlanSummary[]>('/plans') });
export const usePlanDetail = (version: number | null) =>
  useQuery({
    queryKey: ['plan', version],
    enabled: version !== null,
    queryFn: () => get<{ plan: PlanVersion; validation: Validation; readiness: Readiness; dryRuns: DryRun[]; approvals: Approval[] }>(`/plans/${version}`),
  });
export const useClarifications = () => useQuery({ queryKey: ['clarifications'], queryFn: () => get<Clarification[]>('/clarifications') });
export const useExecutions = () => useQuery({ queryKey: ['executions'], queryFn: () => get<Execution[]>('/executions') });
export const useRecon = (id: number | null) => useQuery({ queryKey: ['recon', id], enabled: id !== null, queryFn: () => get<Reconciliation>(`/executions/${id}/reconciliation`) });
export const useAgentRuns = () => useQuery({ queryKey: ['agent-runs'], queryFn: () => get<AgentRun[]>('/agent/runs') });
export const useHistory = (prefix: string, offset: number) =>
  useQuery({ queryKey: ['history', prefix, offset], queryFn: () => get<{ total: number; entries: AuditEntry[] }>(`/history?limit=25&offset=${offset}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`) });

/** Invalidate everything that can change after a state-changing action. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

/** Mutation with consistent success toast, failure toast and global refresh. */
export function useAction<TVars, TOut>(fn: (v: TVars) => Promise<TOut>, opts: { success?: (out: TOut, v: TVars) => string; onSuccess?: (out: TOut, v: TVars) => void } = {}) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out, v) => {
      if (opts.success) toast('ok', opts.success(out, v));
      invalidate();
      opts.onSuccess?.(out, v);
    },
    onError: (err) => toast('error', errorMessage(err)),
  });
}

export const actions = {
  dryRun: (version: number) => post<DryRun>(`/plans/${version}/dry-run`),
  approve: (version: number, comment: string) => post<Approval>(`/plans/${version}/approve`, { confirm: true, comment: comment || undefined }),
  reject: (version: number, comment: string) => post<Approval>(`/plans/${version}/reject`, { comment: comment || undefined }),
  savePlan: (mapping: MappingSpec, parentVersion: number | null, note: string) => post<{ plan: PlanVersion; validation: Validation }>('/plans', { mapping, parentVersion: parentVersion ?? undefined, note: note || undefined }),
  answer: (qid: string, body: { answer?: string; acceptAssumption?: boolean; dismiss?: boolean }) => post<Clarification>(`/clarifications/${qid}/answer`, body),
  startAgent: (kind: 'propose' | 'revise', instructions: string, baseVersion?: number) => post<AgentRun>('/agent/runs', { kind, instructions: instructions || undefined, baseVersion }),
};

/** Standard rendering of a query's loading / error / data states. */
export function Async<T>({ q, children, label }: { q: UseQueryResult<T>; children: (data: T) => ReactNode; label?: string }) {
  if (q.isPending) return <Loading {...(label ? { label } : {})} />;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />;
  return <>{children(q.data)}</>;
}
