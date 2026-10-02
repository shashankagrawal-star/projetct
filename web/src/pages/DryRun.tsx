import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { RecordsTable } from '../components/RecordsTable';
import { actions, Async, useAction, usePlanDetail, usePlans } from '../queries';
import type { DryRun } from '../types';
import { Badge, Banner, Empty, ErrorBanner, Loading, Spinner, Stat, fmtTime, pct, short } from '../ui';

function Breakdown({ run, onPick }: { run: DryRun; onPick: (code: string) => void }) {
  const rows = (rec: Record<string, number>) => Object.entries(rec).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid g3">
      <div><h4>By stage</h4>{rows(run.breakdown.byStage).map(([k, n]) => <div key={k} className="row"><Badge value={k} />{n}</div>)}{rows(run.breakdown.byStage).length === 0 && <span className="muted">No errors.</span>}</div>
      <div><h4>By error code <span className="muted">(click to filter)</span></h4>{rows(run.breakdown.byCode).map(([k, n]) => <div key={k}><button className="chip chip-btn" onClick={() => onPick(k)}>{k}</button> {n}</div>)}</div>
      <div><h4>By target field</h4>{rows(run.breakdown.byField).map(([k, n]) => <div key={k}><code>{k}</code> {n}</div>)}</div>
    </div>
  );
}

export function DryRunPage() {
  const plans = usePlans();
  const [version, setVersion] = useState<number | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [filterCode, setFilterCode] = useState('');
  const [filterKey, setFilterKey] = useState(0);

  useEffect(() => {
    if (version === null && plans.data?.length) setVersion(plans.data.find((p) => p.status === 'approved')?.version ?? plans.data[0]!.version);
  }, [plans.data, version]);

  const detail = usePlanDetail(version);
  const runs = detail.data?.dryRuns ?? [];
  useEffect(() => { setRunId(null); setFilterCode(''); }, [version]);
  const activeId = runId ?? runs[0]?.id ?? null;
  const run = useQuery({ queryKey: ['dry-run', activeId], enabled: activeId !== null, queryFn: () => get<DryRun>(`/dry-runs/${activeId}`) });
  const start = useAction(() => actions.dryRun(version!), { success: (d) => `Dry run #${d.id} complete`, onSuccess: (d) => { setRunId(d.id); setFilterCode(''); setFilterKey((k) => k + 1); } });
  const stale = detail.data?.readiness.blockers.some((b) => b.code === 'STALE_DRY_RUN');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dry run</h1>
          <p>A deterministic rehearsal over the entire sample. Nothing is written to the target. Records that fail any rule are <strong>quarantined with evidence</strong> instead of being repaired or dropped silently.</p>
        </div>
      </div>
      {plans.isPending && <Loading />}
      {plans.isError && <ErrorBanner error={plans.error} onRetry={() => void plans.refetch()} />}
      {plans.data && plans.data.length === 0 && <Empty title="There is no plan to dry-run yet" action={<Link className="btn primary" to="/plan">Create a plan</Link>}>Ask the agent for a proposal first.</Empty>}
      {plans.data && plans.data.length > 0 && (
        <>
          <div className="card">
            <div className="row">
              <label className="field">Plan version
                <select value={version ?? ''} onChange={(e) => setVersion(Number(e.target.value))}>
                  {plans.data.map((p) => <option key={p.version} value={p.version}>v{p.version} — {p.status}{p.latestDryRun ? ` · ${p.latestDryRun.counts.accepted} accepted` : ' · no dry run'}</option>)}
                </select>
              </label>
              {runs.length > 1 && (
                <label className="field">Dry run
                  <select value={activeId ?? ''} onChange={(e) => { setRunId(Number(e.target.value)); setFilterCode(''); }}>
                    {runs.map((r) => <option key={r.id} value={r.id}>#{r.id} — {fmtTime(r.createdAt)}</option>)}
                  </select>
                </label>
              )}
              <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={!version || start.isPending} onClick={() => start.mutate(undefined)}>{start.isPending && <Spinner />} Run dry run on v{version}</button>
            </div>
            {start.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={start.error} /></div>}
          </div>

          {detail.isPending ? <Loading /> : activeId === null ? (
            <Empty title={`v${version} has not been dry-run yet`} action={<button className="btn primary" disabled={start.isPending} onClick={() => start.mutate(undefined)}>Run dry run</button>}>You need a dry run on the exact version before it can be approved.</Empty>
          ) : (
            <Async q={run} label="Loading dry run…">
              {(d) => (
                <>
                  {stale && <Banner kind="warn" title="This dry run is stale">The source data changed since it was run. Run it again before approving.</Banner>}
                  <div className="card">
                    <div className="card-head">
                      <h2>Dry run #{d.id}</h2><Badge value={`v${d.planVersion}`} tone="accent" />
                      <span className="muted small right" title={`transform hash ${d.transformHash}`}>{fmtTime(d.createdAt)} by {d.actor} · determinism hash <code>{short(d.transformHash)}</code></span>
                    </div>
                    <div className="grid g4">
                      <Stat label="Source" value={d.counts.source} sub="records read" />
                      <Stat label="Transformed" value={d.counts.transformed} sub={`${d.counts.source - d.counts.transformed} failed in a rule`} />
                      <Stat label="Accepted" value={d.counts.accepted} tone="ok" sub={`${pct(d.counts.accepted, d.counts.source)} would be loaded`} />
                      <Stat label="Rejected" value={d.counts.rejected} tone={d.counts.rejected ? 'bad' : 'ok'} sub={`${pct(d.counts.rejected, d.counts.source)} quarantined`} />
                    </div>
                    <div className="funnel" style={{ margin: '14px 0 6px' }} aria-hidden>
                      <span className="a" style={{ width: pct(d.counts.accepted, d.counts.source) }} /><span className="r" style={{ width: pct(d.counts.rejected, d.counts.source) }} />
                    </div>
                    <div className="small muted">
                      {d.counts.source} source = {d.counts.accepted} accepted + {d.counts.rejected} rejected. Of {d.loadPreview.validated} records that passed every rule, {d.loadPreview.wouldInsert} would be inserted, {d.loadPreview.wouldSkipExisting} are already in the target, and <strong>{d.loadPreview.wouldConflict}</strong> collide with different rows already there.
                    </div>
                    <p className="small muted" style={{ marginTop: 6 }}>Running this again on the same version and data always yields the same counts and hash; execution re-checks that hash before it writes anything.</p>
                  </div>
                  <div className="card">
                    <h2>Why records were rejected</h2>
                    <Breakdown run={d} onPick={(c) => { setFilterCode(c); setFilterKey((k) => k + 1); }} />
                  </div>
                  <div className="card">
                    <h2>Records & evidence</h2>
                    <RecordsTable key={`${d.id}-${filterKey}`} kind="dry-runs" id={d.id} statuses={['accepted', 'rejected']} codes={Object.keys(d.breakdown.byCode)} initialStatus={filterCode || d.counts.rejected > 0 ? 'rejected' : ''} initialCode={filterCode} />
                  </div>
                  <div className="row">
                    <Link className="btn primary" to="/execution">Continue to approval →</Link>
                    <Link className="btn" to={`/plan/${d.planVersion}`}>Adjust the mapping</Link>
                  </div>
                </>
              )}
            </Async>
          )}
        </>
      )}
    </>
  );
}
