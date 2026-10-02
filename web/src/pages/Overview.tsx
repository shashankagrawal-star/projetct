import { Link } from 'react-router-dom';
import { Async, useOverview } from '../queries';
import type { Overview } from '../types';
import { Badge, Stat, pct } from '../ui';

function nextStep(o: Overview): { text: string; to: string; cta: string } {
  const latest = o.plans.latest;
  if (!latest) return { text: 'No mapping plan exists yet. Ask the agent to inspect the source and target and propose one.', to: '/plan', cta: 'Propose a plan' };
  if (o.execution && o.execution.status === 'failed') return { text: `Execution #${o.execution.id} failed part-way (${o.execution.counts.loaded} loaded, ${o.execution.counts.pending} pending). Retry is safe — it cannot create duplicates — or roll it back.`, to: '/execution', cta: 'Retry or roll back' };
  if (o.execution && o.execution.status === 'completed') return { text: o.reconciliation?.status === 'pass' ? 'Migration completed and reconciliation passed. You can roll it back if the business rejects the result.' : 'Migration completed but reconciliation reports failed checks. Investigate before accepting.', to: '/execution', cta: 'View reconciliation' };
  if (o.questions.openBlocking > 0) return { text: `${o.questions.openBlocking} blocking question${o.questions.openBlocking === 1 ? '' : 's'} from the agent need a business answer before approval.`, to: '/plan', cta: 'Answer questions' };
  if (!o.dryRun) return { text: `Run a dry run on v${latest.version} to see what would be accepted and rejected, with evidence.`, to: '/plan', cta: 'Run a dry run' };
  if (!o.plans.approved) return { text: 'Review the dry-run evidence for quarantined records, then approve the version you want to run.', to: '/execution', cta: 'Review & approve' };
  return { text: `v${o.plans.approved.version} is approved. Start the execution when you are ready.`, to: '/execution', cta: 'Execute' };
}

function Step({ n, title, state, children, to }: { n: number; title: string; state: 'done' | 'current' | 'todo' | 'bad'; children: React.ReactNode; to: string }) {
  return (
    <div className={`card step-card ${state}`} style={{ marginBottom: 0 }}>
      <div className="row"><span className="n">{state === 'done' ? '✓' : n}</span><strong>{title}</strong></div>
      <div className="small muted grow">{children}</div>
      <Link to={to} className="small">Open →</Link>
    </div>
  );
}

export function OverviewPage() {
  const q = useOverview();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agentic data migration</h1>
          <p>Plan, validate, execute, reconcile and roll back the migration of one bounded dataset: <code>legacy_customers</code> → <code>customers</code> in a mock staging store. An AI agent proposes; a human approves; everything that touches data is deterministic and auditable.</p>
        </div>
      </div>
      <Async q={q} label="Loading workflow state…">
        {(o) => {
          const next = nextStep(o);
          const d = o.dryRun;
          const ex = o.execution;
          return (
            <>
              <div className="next">
                <div className="grow"><strong>Next step</strong><div>{next.text}</div></div>
                <Link to={next.to} className="btn primary">{next.cta}</Link>
              </div>
              <div className="grid g3" style={{ marginBottom: 16 }}>
                <Step n={1} title="Inspect source & target" state="done" to="/data">{o.sourceRecords} source records · target holds {o.target.preExisting} pre-existing rows{o.target.migrated ? ` + ${o.target.migrated} migrated` : ''}.</Step>
                <Step n={2} title="Mapping plan" state={o.plans.approved ? 'done' : o.plans.count ? 'current' : 'todo'} to="/plan">
                  {o.plans.latest ? <>Latest v{o.plans.latest.version} <Badge value={o.plans.latest.status} />. {o.questions.openBlocking ? `${o.questions.openBlocking} blocking question(s) open.` : o.questions.total ? 'Questions answered.' : ''}</> : 'Not started.'}
                </Step>
                <Step n={3} title="Deterministic dry run" state={d ? 'done' : o.plans.count ? 'current' : 'todo'} to="/dry-run">
                  {d ? <>{d.counts.source} → {d.counts.transformed} transformed → <strong>{d.counts.accepted} accepted</strong>, <strong>{d.counts.rejected} quarantined</strong> (v{d.planVersion}).</> : 'Not run yet.'}
                </Step>
                <Step n={4} title="Human approval" state={o.plans.approved ? 'done' : d ? 'current' : 'todo'} to="/execution">
                  {o.plans.approved ? <>v{o.plans.approved.version} approved.</> : 'Waiting for a reviewer.'}
                </Step>
                <Step n={5} title="Execute into the mock target" state={ex ? (ex.status === 'failed' ? 'bad' : ex.status === 'completed' ? 'done' : 'current') : o.plans.approved ? 'current' : 'todo'} to="/execution">
                  {ex ? <>Execution #{ex.id} <Badge value={ex.status} />. {ex.counts.loaded} loaded, {ex.counts.pending} pending, {ex.counts.duplicatesPrevented} duplicate inserts prevented.</> : 'Not started.'}
                </Step>
                <Step n={6} title="Reconcile & roll back" state={o.reconciliation ? (o.reconciliation.status === 'pass' ? 'done' : 'bad') : 'todo'} to="/execution">
                  {o.reconciliation ? <>Reconciliation <Badge value={o.reconciliation.status} />.</> : 'Available after an execution.'}
                </Step>
              </div>

              {d && (
                <div className="card">
                  <div className="card-head"><h2>Latest dry run</h2><Badge value={`v${d.planVersion}`} tone="accent" /><Link to="/dry-run" className="small right">Details →</Link></div>
                  <div className="grid g4">
                    <Stat label="Source" value={d.counts.source} />
                    <Stat label="Transformed" value={d.counts.transformed} sub={`${pct(d.counts.transformed, d.counts.source)} of source`} />
                    <Stat label="Accepted" value={d.counts.accepted} tone="ok" sub={`${pct(d.counts.accepted, d.counts.source)}`} />
                    <Stat label="Rejected (quarantined)" value={d.counts.rejected} tone={d.counts.rejected ? 'bad' : 'ok'} sub={`${pct(d.counts.rejected, d.counts.source)}`} />
                  </div>
                </div>
              )}

              <div className="card">
                <h2>How this workbench keeps a migration safe</h2>
                <div className="grid g2 small">
                  <div><strong>The agent can only look.</strong> Its tools inspect schemas, profile data and simulate transforms. It has no tool to approve, write or execute, and instructions hidden in the data are treated as data.</div>
                  <div><strong>Plans are versioned and immutable.</strong> Edits create a new version; approval is bound to one version, one dry run and the exact source data.</div>
                  <div><strong>Transformations are a closed set of deterministic rules</strong> — no arbitrary code. The same input always gives the same output, verified by a hash that execution re-checks.</div>
                  <div><strong>Retries cannot duplicate.</strong> Each target row has a unique key derived from the source record; re-presenting a loaded record is blocked and counted.</div>
                  <div><strong>Bad records are quarantined, not repaired,</strong> with field-level evidence: the source value, the rule, the code and the reason.</div>
                  <div><strong>Everything is reversible and recorded.</strong> Rollback removes only this execution’s rows; approvals, retries and rollbacks live in an append-only history.</div>
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
