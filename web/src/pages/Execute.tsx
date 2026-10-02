import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../api';
import { RecordsTable } from '../components/RecordsTable';
import { actions, Async, useAction, useConfig, useExecutions, usePlanDetail, usePlans, useRecon } from '../queries';
import type { Execution } from '../types';
import { Badge, Banner, Confirm, Empty, ErrorBanner, Loading, Spinner, Stat, fmtTime, pct, short } from '../ui';

// ---- approval -----------------------------------------------------------------------------------
function ApprovalCard({ version }: { version: number }) {
  const detail = usePlanDetail(version);
  const [mode, setMode] = useState<null | 'approve' | 'reject'>(null);
  const [comment, setComment] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const done = () => { setMode(null); setComment(''); setReviewed(false); };
  const approve = useAction(() => actions.approve(version, comment), { success: () => `v${version} approved`, onSuccess: done });
  const reject = useAction(() => actions.reject(version, comment), { success: () => `v${version} rejected`, onSuccess: done });

  return (
    <Async q={detail}>
      {({ plan, validation, readiness, approvals, dryRuns }) => {
        const has = (code: string) => readiness.blockers.some((b) => b.code === code);
        const dry = dryRuns[0];
        const checks = [
          { ok: validation.valid, label: 'Mapping is structurally valid', hint: `${validation.errors.length} error(s) to fix — create a new version` },
          { ok: !has('NO_DRY_RUN') && !has('STALE_DRY_RUN'), label: 'A current dry run exists for this exact version', hint: has('STALE_DRY_RUN') ? 'The source changed since the last dry run' : 'Run a dry run first' },
          { ok: !has('OPEN_QUESTIONS'), label: 'All blocking questions are answered', hint: readiness.blockers.find((b) => b.code === 'OPEN_QUESTIONS')?.message ?? '' },
        ];
        return (
          <div className="card">
            <div className="card-head">
              <h2>Approval</h2><Badge value={`v${plan.version}`} tone="accent" /><Badge value={plan.status} />
              <Link className="small right" to={`/plan/${plan.version}`}>Open plan →</Link>
            </div>
            {plan.status === 'approved' ? (
              <Banner kind="ok" title={`v${plan.version} is approved`}>
                {approvals.filter((a) => a.decision === 'approved').map((a) => <div key={a.id}>By <strong>{a.actor}</strong> on {fmtTime(a.createdAt)} against dry run #{a.dryRunId}{a.comment ? ` — “${a.comment}”` : ''}. The mapping hash <code>{short(a.mappingHash)}</code> is now locked to this approval.</div>)}
              </Banner>
            ) : plan.status === 'rejected' ? (
              <Banner kind="error" title={`v${plan.version} was rejected`}>{approvals.find((a) => a.decision === 'rejected')?.comment ?? 'Create a new version to continue.'}</Banner>
            ) : (
              <>
                <div>{checks.map((c) => (
                  <div className="checkrow" key={c.label}><span className={`icon ${c.ok ? 'ok' : 'bad'}`} aria-hidden>{c.ok ? '✓' : '!'}</span><div><div>{c.label}</div>{!c.ok && <div className="small muted">{c.hint}</div>}</div></div>
                ))}</div>
                {dry && <p className="small muted" style={{ marginTop: 8 }}>Latest dry run #{dry.id}: <strong>{dry.counts.accepted}</strong> would load, <strong>{dry.counts.rejected}</strong> quarantined of {dry.counts.source}.</p>}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn primary" disabled={!readiness.ready} onClick={() => setMode('approve')} title={readiness.ready ? '' : 'Resolve the items above first'}>Approve v{plan.version}…</button>
                  <button className="btn" onClick={() => setMode('reject')}>Reject…</button>
                  {!readiness.ready && <Link className="btn ghost" to={has('NO_DRY_RUN') || has('STALE_DRY_RUN') ? '/dry-run' : `/plan/${plan.version}`}>Fix blockers →</Link>}
                </div>
              </>
            )}
            {mode === 'approve' && (
              <Confirm title={`Approve v${plan.version}?`} confirmLabel="Approve" busy={approve.isPending} disabled={!reviewed} onConfirm={() => approve.mutate(undefined)} onClose={() => setMode(null)}>
                <p>You are approving this exact mapping to be executed against the mock target. Approval is recorded under your name and bound to dry run #{readiness.dryRunId}. It does not run anything by itself.</p>
                {dry && <p><strong>{dry.counts.accepted}</strong> records will be loaded and <strong>{dry.counts.rejected}</strong> will stay quarantined.</p>}
                <label className="field">Comment (optional)<textarea value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} /></label>
                <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /><span>I reviewed the mapping, the risks and the quarantined records, and accept the answers/assumptions recorded for this plan.</span></label>
                {approve.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={approve.error} /></div>}
              </Confirm>
            )}
            {mode === 'reject' && (
              <Confirm title={`Reject v${plan.version}?`} confirmLabel="Reject" danger busy={reject.isPending} onConfirm={() => reject.mutate(undefined)} onClose={() => setMode(null)}>
                <p>A rejected version can never be approved. You can create a new version from it, or ask the agent to revise.</p>
                <label className="field">Reason<textarea value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} /></label>
                {reject.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={reject.error} /></div>}
              </Confirm>
            )}
          </div>
        );
      }}
    </Async>
  );
}

// ---- start --------------------------------------------------------------------------------------
function StartCard({ version }: { version: number }) {
  const cfg = useConfig();
  const detail = usePlanDetail(version);
  const [confirming, setConfirming] = useState(false);
  const [inject, setInject] = useState(false);
  const [after, setAfter] = useState(40);
  const key = useRef(crypto.randomUUID());
  const start = useAction(
    () => post<{ execution: Execution }>('/executions', { planVersion: version, dryRunId: detail.data!.readiness.dryRunId, simulateFailureAfter: inject ? after : undefined }, { 'Idempotency-Key': key.current }),
    { success: (r) => (r.execution.status === 'completed' ? `Execution #${r.execution.id} completed` : `Execution #${r.execution.id} ${r.execution.status}`), onSuccess: () => { key.current = crypto.randomUUID(); setConfirming(false); } },
  );
  const dry = detail.data?.dryRuns.find((d) => d.id === detail.data?.readiness.dryRunId) ?? detail.data?.dryRuns[0];
  return (
    <div className="card">
      <div className="card-head"><h2>Execute into the mock target</h2></div>
      <p className="muted">Loads the accepted records in batches of {cfg.data?.executionBatchSize ?? 25}. Rejected records stay quarantined. Every target row is keyed to its source record, so a retry can never insert twice. You can roll the whole execution back afterwards.</p>
      {dry && <p>Plan to load up to <strong>{dry.counts.accepted}</strong> rows (of which {dry.loadPreview.wouldConflict} are expected to be rejected by the store on load conflicts — already counted as rejected).</p>}
      {cfg.data?.allowFailureInjection && (
        <div className="row" style={{ marginBottom: 10 }}>
          <label className="check"><input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} /><span>Demo: make the target fail after</span></label>
          <input type="number" min={1} value={after} disabled={!inject} style={{ width: 80 }} aria-label="Fail after N records" onChange={(e) => setAfter(Math.max(1, Number(e.target.value) || 1))} />
          <span className="muted small">records, to try retry and recovery.</span>
        </div>
      )}
      <button className="btn primary" disabled={!detail.data?.readiness.dryRunId || start.isPending} onClick={() => setConfirming(true)}>Start execution…</button>
      {confirming && (
        <Confirm title="Start the execution?" confirmLabel="Execute" busy={start.isPending} onConfirm={() => start.mutate(undefined)} onClose={() => setConfirming(false)}>
          <p>This writes up to <strong>{dry?.counts.accepted ?? '?'}</strong> rows into the mock target using approved v{version}. Before writing, the server re-runs the transform and refuses if the result differs from the approved dry run.</p>
          {inject && <Banner kind="warn">A failure will be injected after {after} records. The execution will stop part-way; you can then retry it.</Banner>}
          <p className="small muted">Request key <code>{key.current.slice(0, 8)}…</code> makes a double-click or network retry safe.</p>
          {start.isError && <ErrorBanner error={start.error} />}
        </Confirm>
      )}
    </div>
  );
}

// ---- execution detail ---------------------------------------------------------------------------
function ReconPanel({ execution }: { execution: Execution }) {
  const recon = useRecon(execution.id);
  return (
    <div className="card">
      <div className="card-head"><h2>Reconciliation</h2>{recon.data && <Badge value={recon.data.status} />}<button className="btn sm right" onClick={() => void recon.refetch()}>Re-check</button></div>
      <Async q={recon} label="Comparing source and target…">
        {(r) => (
          <>
            <div className="grid g4">
              <Stat label="Source total" value={r.totals.sourceTotal} />
              <Stat label="Migrated into target" value={r.totals.targetMigrated} tone="ok" sub={`${r.totals.skippedExisting} skipped as already present`} />
              <Stat label="Quarantined" value={r.totals.quarantined} tone={r.totals.quarantined ? 'warn' : 'ok'} sub={`${r.totals.pending} still pending`} />
              <Stat label="Target total" value={r.totals.targetNow} sub={`was ${r.totals.targetBefore} before`} />
            </div>
            <p className="small muted" style={{ margin: '10px 0' }}>Source {r.totals.sourceTotal} = migrated {r.totals.loaded} + skipped {r.totals.skippedExisting} + pending {r.totals.pending} + quarantined {r.totals.quarantined}. Target {r.totals.targetBefore} + {r.totals.targetMigrated} migrated = {r.totals.targetBefore + r.totals.targetMigrated}{r.totals.targetBefore + r.totals.targetMigrated === r.totals.targetNow ? ' ✓' : ` ≠ ${r.totals.targetNow}`}.</p>
            {r.checks.map((c) => (
              <div className="checkrow" key={c.id}>
                <span className={`icon ${c.pass ? 'ok' : 'bad'}`} aria-hidden>{c.pass ? '✓' : '✕'}</span>
                <div className="grow"><div>{c.label}</div><div className="small muted">expected <code>{c.expected}</code> · actual <code>{c.actual}</code>{c.note ? ` — ${c.note}` : ''}</div></div>
              </div>
            ))}
          </>
        )}
      </Async>
    </div>
  );
}

function ExecutionPanel({ ex }: { ex: Execution }) {
  const [rollback, setRollback] = useState(false);
  const [reason, setReason] = useState('');
  const [inject, setInject] = useState(false);
  const [after, setAfter] = useState(60);
  const cfg = useConfig();
  const retry = useAction(() => post<{ execution: Execution }>(`/executions/${ex.id}/retry`, { simulateFailureAfter: inject ? after : undefined }), {
    success: (r) => (r.execution.status === 'completed' ? `Retry completed — ${r.execution.attempts.at(-1)?.duplicatesPrevented ?? 0} duplicate insert(s) prevented` : `Retry stopped: ${r.execution.error}`),
  });
  const roll = useAction(() => post<{ execution: Execution }>(`/executions/${ex.id}/rollback`, { reason }), { success: (r) => `Rolled back ${r.execution.rollbacks.at(-1)?.rowsRemoved} rows`, onSuccess: () => { setRollback(false); setReason(''); } });
  const c = ex.counts;
  const canAct = ex.status === 'failed' || ex.status === 'completed';
  const dryDetail = usePlanDetail(ex.planVersion);
  const dryCodes = Object.keys(dryDetail.data?.dryRuns.find((d) => d.id === ex.dryRunId)?.breakdown.byCode ?? {});
  const codes = Array.from(new Set([...dryCodes, 'TARGET_CONFLICT', 'STORE_CONSTRAINT']));

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Execution #{ex.id}</h2><Badge value={ex.status} /><Badge value={`v${ex.planVersion}`} tone="accent" />
          <span className="muted small right">started {fmtTime(ex.createdAt)} by {ex.createdBy}</span>
        </div>
        {ex.status === 'failed' && <Banner kind="error" title="This execution stopped part-way">{ex.error}<div className="small">{c.loaded} rows are loaded and {c.pending} are still pending. <strong>Retrying is safe:</strong> already-loaded records are recognised and cannot be inserted again.</div></Banner>}
        {ex.status === 'completed' && <Banner kind="ok" title="Execution completed">{c.loaded} rows loaded, {c.rejected} quarantined{c.duplicatesPrevented ? `, ${c.duplicatesPrevented} duplicate insert attempt(s) blocked by the idempotency guard` : ''}.</Banner>}
        {ex.status === 'rolled_back' && <Banner kind="info" title="Rolled back">{ex.rollbacks.map((r) => <div key={r.id}>{r.rowsRemoved} rows removed by {r.actor} on {fmtTime(r.createdAt)} — “{r.reason}”. Target is back to {r.targetRowsAfter} rows (baseline {ex.baselineTargetRows}).</div>)}</Banner>}
        <div className="grid auto">
          <Stat label="Source" value={c.source} />
          <Stat label="Transformed" value={c.transformed} />
          <Stat label="Accepted" value={c.accepted} tone="ok" sub={`${pct(c.accepted, c.source)}`} />
          <Stat label="Rejected" value={c.rejected} tone={c.rejected ? 'bad' : 'ok'} />
          <Stat label="Loaded" value={c.loaded} tone="ok" />
          <Stat label="Pending" value={c.pending} tone={c.pending ? 'warn' : undefined} />
          <Stat label="Duplicates prevented" value={c.duplicatesPrevented} tone={c.duplicatesPrevented ? 'info' : undefined} sub="insert attempts blocked" />
          {c.rolledBack > 0 && <Stat label="Rolled back" value={c.rolledBack} tone="warn" />}
        </div>

        <h3 style={{ marginTop: 16 }}>Attempts</h3>
        <div className="tablewrap"><table>
          <thead><tr><th>#</th><th>Trigger</th><th>Status</th><th>Inserted</th><th>Duplicates prevented</th><th>Load-rejected</th><th>By</th><th>Started</th><th>Error</th></tr></thead>
          <tbody>{ex.attempts.map((a) => (
            <tr key={a.attemptNo}><td>{a.attemptNo}</td><td>{a.trigger}</td><td><Badge value={a.status} /></td><td>{a.inserted}</td><td>{a.duplicatesPrevented}</td><td>{a.loadRejected}</td><td>{a.actor}</td><td className="nowrap small">{fmtTime(a.startedAt)}</td><td className="small">{a.error ?? '—'}</td></tr>
          ))}</tbody></table></div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={!canAct || retry.isPending} onClick={() => retry.mutate(undefined)} title="Re-present every accepted record. Loaded ones are skipped by the unique-key guard.">{retry.isPending && <Spinner />} Retry{ex.status === 'completed' ? ' (idempotency check)' : ''}</button>
          {cfg.data?.allowFailureInjection && canAct && (
            <label className="check small"><input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} /><span>fail again after</span>
              <input type="number" min={1} value={after} disabled={!inject} style={{ width: 70 }} aria-label="Fail retry after N records" onChange={(e) => setAfter(Math.max(1, Number(e.target.value) || 1))} /></label>
          )}
          <button className="btn danger right" disabled={!canAct} onClick={() => setRollback(true)}>Roll back…</button>
        </div>
        {retry.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={retry.error} /></div>}
        {rollback && (
          <Confirm title={`Roll back execution #${ex.id}?`} confirmLabel="Roll back" danger busy={roll.isPending} disabled={reason.trim().length < 3} onConfirm={() => roll.mutate(undefined)} onClose={() => setRollback(false)}>
            <p>This deletes the <strong>{c.loaded}</strong> rows this execution inserted. Pre-existing target rows are never touched. The attempt history and audit trail are kept.</p>
            <label className="field">Reason (required, recorded in history)<textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. currency assumption was wrong" /></label>
            {roll.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={roll.error} /></div>}
          </Confirm>
        )}
      </div>
      <ReconPanel execution={ex} />
      <div className="card">
        <h2>Per-record outcome</h2>
        <RecordsTable kind="executions" id={ex.id} statuses={['loaded', 'rejected', 'pending', 'skipped_existing']} codes={codes} />
      </div>
    </>
  );
}

// ---- page ---------------------------------------------------------------------------------------
export function ExecutePage() {
  const plans = usePlans();
  const execs = useExecutions();
  const [version, setVersion] = useState<number | null>(null);
  const [selectedExec, setSelectedExec] = useState<number | null>(null);

  useEffect(() => {
    if (version === null && plans.data?.length) setVersion((plans.data.find((p) => p.status === 'approved') ?? plans.data.find((p) => p.status !== 'rejected') ?? plans.data[0]!).version);
  }, [plans.data, version]);

  const list = execs.data ?? [];
  const live = list.find((e) => e.status !== 'rolled_back');
  const shown = list.find((e) => e.id === selectedExec) ?? live ?? list[0];
  const selectedPlan = plans.data?.find((p) => p.version === version);
  const canStart = selectedPlan?.status === 'approved' && !live;

  return (
    <>
      <div className="page-head"><div><h1>Approve & execute</h1><p>A human approves one exact version. Execution then loads the accepted records into the mock target idempotently, can be retried or rolled back, and is reconciled against the source.</p></div></div>
      {plans.isPending && <Loading />}
      {plans.isError && <ErrorBanner error={plans.error} onRetry={() => void plans.refetch()} />}
      {plans.data && plans.data.length === 0 && <Empty title="There is nothing to approve yet" action={<Link className="btn primary" to="/plan">Create a plan</Link>}>Ask the agent for a mapping proposal first.</Empty>}
      {plans.data && plans.data.length > 0 && version !== null && (
        <>
          <div className="card">
            <label className="field" style={{ maxWidth: 360 }}>Plan version
              <select value={version} onChange={(e) => setVersion(Number(e.target.value))}>
                {plans.data.map((p) => <option key={p.version} value={p.version}>v{p.version} — {p.status}{p.origin === 'agent' ? ' (agent)' : ' (edited)'}</option>)}
              </select>
            </label>
          </div>
          <ApprovalCard version={version} />
          {canStart && <StartCard version={version} />}
          {live && selectedPlan?.status === 'approved' && live.planVersion !== version && <Banner kind="info">Execution #{live.id} (v{live.planVersion}) is still live. Roll it back before executing a different version.</Banner>}
        </>
      )}
      {execs.isPending && <Loading />}
      {execs.isError && <ErrorBanner error={execs.error} onRetry={() => void execs.refetch()} />}
      {list.length > 1 && (
        <div className="card">
          <h3>Executions</h3>
          <div className="row">{list.map((e) => <button key={e.id} className={`btn sm ${shown?.id === e.id ? 'primary' : ''}`} onClick={() => setSelectedExec(e.id)}>#{e.id} · v{e.planVersion} · {e.status.replace('_', ' ')}</button>)}</div>
        </div>
      )}
      {shown ? <ExecutionPanel key={shown.id} ex={shown} /> : execs.data && <Empty title="No execution yet">{canStart ? 'Start one above.' : 'Approve a version and run a dry run to enable execution.'}</Empty>}
    </>
  );
}
