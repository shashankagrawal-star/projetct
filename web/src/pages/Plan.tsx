import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get } from '../api';
import { AgentTrace, useLiveRun } from '../components/AgentTrace';
import { MappingEditor, MappingView } from '../components/Mapping';
import { Async, actions, useAction, useClarifications, useConfig, usePlanDetail, usePlans, useRules, useSource, useTarget } from '../queries';
import type { Clarification, MappingSpec, PlanSummary, Validation } from '../types';
import { Badge, Banner, Empty, ErrorBanner, Json, Loading, Spinner, Stat, Tabs, fmtTime, short } from '../ui';

// ---- agent panel --------------------------------------------------------------------------------
function AgentPanel({ selected, onFinished }: { selected: number | null; onFinished: (version: number) => void }) {
  const cfg = useConfig();
  const [instructions, setInstructions] = useState('');
  const [runId, setRunId] = useState<number | null>(null);
  const live = useLiveRun(runId);
  const start = useAction((kind: 'propose' | 'revise') => actions.startAgent(kind, instructions, kind === 'revise' ? (selected ?? undefined) : undefined), {
    onSuccess: (run) => setRunId(run.id),
  });
  const running = live.run?.status === 'running' || start.isPending;

  useEffect(() => {
    if (live.run?.status === 'succeeded' && live.run.resultVersion) onFinished(live.run.resultVersion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.run?.status]);

  const agent = cfg.data?.agent;
  const hasPlan = selected !== null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Ask the agent</h2>
        {agent && <Badge value={agent.mode} tone={agent.mode === 'llm' ? 'accent' : 'warn'} label={agent.mode === 'llm' ? agent.model ?? 'LLM' : 'rule-based fallback (no LLM configured)'} />}
      </div>
      <p className="muted small">
        The agent can only <strong>inspect and validate</strong> (schemas, rules, sample data, field profiles, simulated transforms). It proposes a mapping, risks and questions as a new <em>proposed</em> version. It cannot approve, execute, or write anything — you do that.
      </p>
      {agent?.mode === 'heuristic' && (
        <Banner kind="warn" title="Running without an LLM">
          This server has no <code>ANTHROPIC_API_KEY</code>, so proposals come from a deterministic rule-based engine that uses the same tools and review gate. Set the key to use the Claude agent.
        </Banner>
      )}
      <label className="field">Guidance for this run (optional)
        <textarea value={instructions} maxLength={2000} placeholder="e.g. “Finance confirmed balances are in INR. Treat blank consent as opt-out.”" onChange={(e) => setInstructions(e.target.value)} disabled={running} />
      </label>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={running || !agent?.available} onClick={() => start.mutate('propose')}>
          {running ? <Spinner /> : null} {hasPlan ? 'Propose a fresh plan' : 'Propose a mapping plan'}
        </button>
        {hasPlan && (
          <button className="btn" disabled={running || !agent?.available} onClick={() => start.mutate('revise')} title="Start from the selected version, using your answers and guidance.">
            Revise v{selected} with answers
          </button>
        )}
        {live.run && !running && <button className="btn ghost" onClick={() => setRunId(null)}>Hide trace</button>}
      </div>
      {start.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={start.error} /></div>}
      {runId !== null && (
        <div style={{ marginTop: 14 }}>
          <h3>Agent trace {live.run?.status === 'succeeded' && live.run.resultVersion ? <>→ created <Link to={`/plan/${live.run.resultVersion}`}>v{live.run.resultVersion}</Link></> : null}</h3>
          <AgentTrace run={live.run} events={live.events} error={live.error} />
          {live.run?.status === 'failed' && <div style={{ marginTop: 8 }}><Banner kind="error" title="The agent run failed — no plan was created">{live.run.error}</Banner></div>}
        </div>
      )}
    </div>
  );
}

// ---- clarification questions --------------------------------------------------------------------
function Question({ q }: { q: Clarification }) {
  const [text, setText] = useState('');
  const answer = useAction((body: { answer?: string; acceptAssumption?: boolean; dismiss?: boolean }) => actions.answer(q.qid, body), { success: () => `Answered ${q.qid}` });
  const open = q.status === 'open';
  return (
    <div className={`q ${open ? 'open' : ''} ${q.blocking ? 'blocking' : ''}`}>
      <div className="row">
        <strong>{q.qid}</strong>
        {q.field && <code>{q.field}</code>}
        {q.blocking ? <Badge value="blocks approval" tone="warn" /> : <Badge value="optional" />}
        <Badge value={q.status} />
        <span className="muted small right">raised in v{q.raisedInVersion}</span>
      </div>
      <p style={{ margin: '6px 0' }}>{q.question}</p>
      {open ? (
        <>
          {q.options.length > 0 && <div className="row" style={{ marginBottom: 6 }}>{q.options.map((o) => <button key={o} className="chip chip-btn" onClick={() => setText(o)}>{o}</button>)}</div>}
          <div className="row">
            <input type="text" value={text} placeholder="Your answer" aria-label={`Answer to ${q.qid}`} className="grow" maxLength={1000} onChange={(e) => setText(e.target.value)} />
            <button className="btn primary sm" disabled={!text.trim() || answer.isPending} onClick={() => answer.mutate({ answer: text })}>Answer</button>
            {q.proposedAssumption && <button className="btn sm" disabled={answer.isPending} onClick={() => answer.mutate({ acceptAssumption: true })} title={q.proposedAssumption}>Accept “{q.proposedAssumption.length > 28 ? `${q.proposedAssumption.slice(0, 28)}…` : q.proposedAssumption}”</button>}
            {!q.blocking && <button className="btn ghost sm" disabled={answer.isPending} onClick={() => answer.mutate({ dismiss: true })}>Dismiss</button>}
          </div>
          {answer.isError && <div style={{ marginTop: 6 }}><ErrorBanner error={answer.error} /></div>}
          {q.proposedAssumption && <div className="muted small" style={{ marginTop: 4 }}>Agent’s assumption: {q.proposedAssumption}</div>}
        </>
      ) : (
        <div className="small"><strong>{q.status === 'dismissed' ? 'Dismissed' : 'Answer'}:</strong> {q.answer} <span className="muted">— {q.answeredBy}, {fmtTime(q.answeredAt)}</span></div>
      )}
    </div>
  );
}

function Questions() {
  const q = useClarifications();
  return (
    <Async q={q}>
      {(list) =>
        list.length === 0 ? (
          <Empty title="No clarification questions">The agent did not need business decisions beyond the mapping itself.</Empty>
        ) : (
          <>
            <p className="muted small">Answers are recorded with your name and used when you ask the agent to revise. Blocking questions must be answered before a version can be approved.</p>
            {[...list].sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || Number(b.blocking) - Number(a.blocking)).map((x) => <Question key={x.qid} q={x} />)}
          </>
        )
      }
    </Async>
  );
}

// ---- analysis -----------------------------------------------------------------------------------
function Analysis({ plan }: { plan: PlanSummary['analysis'] }) {
  if (!plan) return <Empty title="No analysis attached">This version was created by hand and carries no agent analysis.</Empty>;
  const sev = (s: string) => ({ high: 0, medium: 1, low: 2 })[s] ?? 3;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <h3>Risks ({plan.risks.length})</h3>
        {plan.risks.length === 0 && <span className="muted">None identified.</span>}
        {[...plan.risks].sort((a, b) => sev(a.severity) - sev(b.severity)).map((r, i) => (
          <div className="q" key={i}>
            <div className="row"><Badge value={r.severity} /><strong>{r.title}</strong>{r.affectedFields.map((f) => <code key={f}>{f}</code>)}</div>
            <p style={{ margin: '4px 0' }}>{r.detail}</p>
            <div className="small muted"><strong>Mitigation:</strong> {r.mitigation}</div>
          </div>
        ))}
      </div>
      <div>
        <h3>Missing target fields ({plan.missingTargetFields.length})</h3>
        {plan.missingTargetFields.length === 0 && <span className="muted">Every target field has a source.</span>}
        {plan.missingTargetFields.map((m) => <div key={m.field} className="small" style={{ marginBottom: 4 }}><code>{m.field}</code> — {m.issue} <em>Proposed:</em> {m.proposedResolution}</div>)}
      </div>
      <div>
        <h3>Incompatibilities ({plan.incompatibilities.length})</h3>
        {plan.incompatibilities.length === 0 && <span className="muted">None identified.</span>}
        {plan.incompatibilities.map((m, i) => <div key={i} className="small" style={{ marginBottom: 4 }}><code>{m.sourceField ?? '—'}</code> → <code>{m.targetField ?? '—'}</code>: {m.issue} <em>Handling:</em> {m.handling}</div>)}
      </div>
    </div>
  );
}

function MigrationPlan({ plan }: { plan: NonNullable<PlanSummary['analysis']> }) {
  return (
    <div className="grid g2">
      <div>
        <h3>Steps (batch size {plan.migrationPlan.batchSize})</h3>
        <ol style={{ paddingLeft: 18, margin: 0 }}>{plan.migrationPlan.steps.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}</ol>
      </div>
      <div>
        <h3>Roll back if…</h3>
        <ul style={{ paddingLeft: 18, margin: 0 }}>{plan.migrationPlan.rollbackCriteria.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}</ul>
        <p className="muted small" style={{ marginTop: 10 }}>This is the agent’s proposal. Nothing in it runs until you approve a version and start the execution yourself.</p>
      </div>
    </div>
  );
}

function Diff({ from, to }: { from: number; to: number }) {
  const q = useQuery({ queryKey: ['diff', from, to], queryFn: () => get<{ changes: Array<{ target: string; change: string; before?: unknown; after?: unknown }> }>(`/plans/${from}/diff/${to}`) });
  return (
    <Async q={q}>
      {(d) =>
        d.changes.length === 0 ? (
          <Empty title={`No executable changes from v${from}`}>Only annotations (risk, rationale) or the analysis differ.</Empty>
        ) : (
          <div className="col">
            {d.changes.map((c) => (
              <div className="q" key={c.target}>
                <div className="row"><code>{c.target}</code><Badge value={c.change} tone={c.change === 'added' ? 'ok' : c.change === 'removed' ? 'bad' : 'warn'} /></div>
                <div className="diffcell">
                  <div><h4>v{from}</h4>{c.before ? <Json value={c.before} /> : <span className="muted">—</span>}</div>
                  <div><h4>v{to}</h4>{c.after ? <Json value={c.after} /> : <span className="muted">—</span>}</div>
                </div>
              </div>
            ))}
          </div>
        )
      }
    </Async>
  );
}

// ---- version detail -----------------------------------------------------------------------------
type TabId = 'mapping' | 'risks' | 'questions' | 'plan' | 'changes' | 'trace';

function VersionDetail({ version, onSaved }: { version: number; onSaved: (v: number) => void }) {
  const detail = usePlanDetail(version);
  const rules = useRules();
  const source = useSource();
  const target = useTarget();
  const clar = useClarifications();
  const nav = useNavigate();
  const [tab, setTab] = useState<TabId>('mapping');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MappingSpec | null>(null);
  const [live, setLive] = useState<Validation | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { setEditing(false); setDraft(null); setTab('mapping'); }, [version]);

  const dry = useAction(() => actions.dryRun(version), { success: (d) => `Dry run #${d.id}: ${d.counts.accepted} accepted, ${d.counts.rejected} rejected`, onSuccess: () => nav('/dry-run') });
  const save = useAction(() => actions.savePlan(draft!, version, note), { success: (r) => `Saved as v${r.plan.version}`, onSuccess: (r) => { setEditing(false); onSaved(r.plan.version); } });
  const run = useLiveRun(detail.data?.plan.agentRunId ?? null);
  const rulesList = rules.data ?? [];
  const openBlocking = (clar.data ?? []).filter((c) => c.status === 'open' && c.blocking).length;
  const openAll = (clar.data ?? []).filter((c) => c.status === 'open').length;

  return (
    <Async q={detail}>
      {({ plan, validation, readiness, approvals }) => (
        <>
          <div className="card">
            <div className="card-head">
              <h2>Version {plan.version}</h2>
              <Badge value={plan.status} />
              <Badge value={plan.origin} tone={plan.origin === 'agent' ? 'accent' : ''} label={plan.origin === 'agent' ? 'proposed by agent' : 'edited by a person'} />
              <span className="muted small right">#{short(plan.mappingHash)}</span>
            </div>
            <dl className="kv">
              <dt>Created</dt><dd>{fmtTime(plan.createdAt)} by {plan.createdBy}</dd>
              {plan.parentVersion && <><dt>Based on</dt><dd><Link to={`/plan/${plan.parentVersion}`}>v{plan.parentVersion}</Link></dd></>}
              {plan.note && <><dt>Note</dt><dd>{plan.note}</dd></>}
              {approvals.length > 0 && <><dt>Decisions</dt><dd>{approvals.map((a) => <div key={a.id}><Badge value={a.decision} /> {a.actor}, {fmtTime(a.createdAt)}{a.comment ? ` — “${a.comment}”` : ''}</div>)}</dd></>}
            </dl>
            {plan.analysis && <p style={{ marginTop: 10 }}>{plan.analysis.summary}</p>}
            <div className="grid g4" style={{ margin: '12px 0' }}>
              <Stat label="Structural check" value={validation.valid ? 'Valid' : `${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'}`} tone={validation.valid ? 'ok' : 'bad'} sub={`${validation.warnings.length} warning${validation.warnings.length === 1 ? '' : 's'}`} />
              <Stat label="Blocking questions" value={openBlocking} tone={openBlocking ? 'warn' : 'ok'} sub={`${openAll} open in total`} />
              <Stat label="Dry run" value={readiness.dryRunId ? `#${readiness.dryRunId}` : 'none'} tone={readiness.blockers.some((b) => b.code === 'NO_DRY_RUN' || b.code === 'STALE_DRY_RUN') ? 'warn' : 'ok'} sub={readiness.blockers.some((b) => b.code === 'STALE_DRY_RUN') ? 'stale — re-run' : readiness.dryRunId ? 'matches this version' : 'run one to enable approval'} />
              <Stat label="Approval" value={plan.status === 'approved' ? 'Approved' : readiness.ready ? 'Ready' : 'Blocked'} tone={plan.status === 'approved' ? 'ok' : readiness.ready ? 'info' : 'warn'} sub={plan.status === 'approved' ? 'immutable' : `${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? '' : 's'}`} />
            </div>
            {plan.status !== 'approved' && plan.status !== 'rejected' && readiness.blockers.length > 0 && (
              <Banner kind="warn" title="Before this version can be approved">
                <ul>{readiness.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
              </Banner>
            )}
            <div className="row">
              <button className="btn primary" disabled={dry.isPending} onClick={() => dry.mutate(undefined)}>{dry.isPending && <Spinner />} Run dry run on v{plan.version}</button>
              {!editing && plan.status !== 'rejected' && <button className="btn" onClick={() => { setEditing(true); setTab('mapping'); }}>Edit as new version</button>}
              {plan.status !== 'approved' && plan.status !== 'rejected' && <Link className="btn" to="/execution">Approve…</Link>}
            </div>
            {dry.isError && <div style={{ marginTop: 10 }}><ErrorBanner error={dry.error} /></div>}
          </div>

          <div className="card">
            <Tabs<TabId>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'mapping', label: editing ? 'Mapping (editing)' : 'Mapping' },
                { id: 'risks', label: `Risks & gaps${plan.analysis ? ` (${plan.analysis.risks.length})` : ''}` },
                { id: 'questions', label: `Questions${openAll ? ` (${openAll} open)` : ''}` },
                { id: 'plan', label: 'Migration plan' },
                ...(plan.parentVersion ? [{ id: 'changes' as const, label: `Changes vs v${plan.parentVersion}` }] : []),
                ...(plan.agentRunId ? [{ id: 'trace' as const, label: 'Agent trace' }] : []),
              ]}
            />
            {tab === 'mapping' && (
              editing ? (
                source.data && target.data && rules.data ? (
                  <>
                    <Banner kind="info">Editing creates a <strong>new immutable version</strong>; v{plan.version} is never changed. Validation runs as you type.</Banner>
                    <MappingEditor initial={plan.mapping} source={source.data.schema} target={target.data.schema} rules={rulesList} onChange={setDraft} onValidation={setLive} />
                    <div className="card" style={{ position: 'sticky', bottom: 8, marginTop: 12, marginBottom: 0 }}>
                      <div className="row">
                        <label className="field grow">What did you change and why? (saved with the version)
                          <input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Finance confirmed balances are in USD" />
                        </label>
                        <button className="btn" onClick={() => { setEditing(false); setDraft(null); }}>Cancel</button>
                        <button className="btn primary" disabled={!draft || save.isPending} onClick={() => save.mutate(undefined)}>{save.isPending && <Spinner />} Save as new version</button>
                      </div>
                      {live && !live.valid && <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>{live.errors.length} structural error(s): you can save this as a draft, but it cannot be approved until they are fixed.</div>}
                      {save.isError && <div style={{ marginTop: 8 }}><ErrorBanner error={save.error} /></div>}
                    </div>
                  </>
                ) : <Loading />
              ) : target.data ? <MappingView mapping={plan.mapping} target={target.data.schema} rules={rulesList} /> : <Loading />
            )}
            {tab === 'risks' && <Analysis plan={plan.analysis} />}
            {tab === 'questions' && <Questions />}
            {tab === 'plan' && (plan.analysis ? <MigrationPlan plan={plan.analysis} /> : <Empty title="No migration plan attached" />)}
            {tab === 'changes' && plan.parentVersion && <Diff from={plan.parentVersion} to={plan.version} />}
            {tab === 'trace' && <AgentTrace run={run.run} events={run.events} error={run.error} />}
            {tab === 'mapping' && !editing && (validation.errors.length > 0 || validation.warnings.length > 0) && (
              <details style={{ marginTop: 12 }} open={!validation.valid}>
                <summary><strong>{validation.errors.length} error(s), {validation.warnings.length} warning(s)</strong></summary>
                {[...validation.errors, ...validation.warnings].map((i, k) => <div key={k} className="small" style={{ color: i.severity === 'error' ? 'var(--bad)' : 'var(--warn)' }}>{i.severity === 'error' ? '✖' : '⚠'} {i.message}</div>)}
              </details>
            )}
          </div>
        </>
      )}
    </Async>
  );
}

// ---- page ---------------------------------------------------------------------------------------
export function PlanPage() {
  const params = useParams();
  const nav = useNavigate();
  const plans = usePlans();
  const list = plans.data ?? [];
  const selected = useMemo(() => {
    const fromUrl = params.version ? Number(params.version) : null;
    if (fromUrl && list.some((p) => p.version === fromUrl)) return fromUrl;
    return list[0]?.version ?? null;
  }, [params.version, list]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mapping plan</h1>
          <p>Every plan is an immutable, numbered version. The agent proposes; you review, answer questions, and edit — each edit becomes a new version. Only a version you explicitly approve can be executed.</p>
        </div>
      </div>
      <AgentPanel selected={selected} onFinished={(v) => nav(`/plan/${v}`)} />
      <div className="split">
        <div>
          <h3>Versions</h3>
          {plans.isPending && <Loading />}
          {plans.isError && <ErrorBanner error={plans.error} onRetry={() => void plans.refetch()} />}
          {plans.data && list.length === 0 && <Empty title="No plan yet">Ask the agent to propose one.</Empty>}
          <div className="vlist">
            {list.map((p) => (
              <button key={p.version} className={`item ${p.version === selected ? 'active' : ''}`} onClick={() => nav(`/plan/${p.version}`)}>
                <div className="t">v{p.version} <Badge value={p.status} /></div>
                <div className="small muted">{p.origin === 'agent' ? '🤖 agent' : '✎ edited'} · {fmtTime(p.createdAt)}</div>
                <div className="small">{p.validation.valid ? '✓ valid' : `✖ ${p.validation.errors} errors`}{p.latestDryRun ? ` · ${p.latestDryRun.counts.accepted}/${p.latestDryRun.counts.source} accepted` : ' · no dry run'}</div>
                {p.note && <div className="small muted" title={p.note}>“{p.note.length > 60 ? `${p.note.slice(0, 60)}…` : p.note}”</div>}
              </button>
            ))}
          </div>
        </div>
        <div>{selected !== null ? <VersionDetail version={selected} onSaved={(v) => nav(`/plan/${v}`)} /> : null}</div>
      </div>
    </>
  );
}
