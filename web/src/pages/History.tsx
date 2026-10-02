import { useState } from 'react';
import { AgentTrace, useLiveRun } from '../components/AgentTrace';
import { Async, useAgentRuns, useHistory } from '../queries';
import { Badge, Empty, Pager, Tabs, fmtTime, Json } from '../ui';

const FILTERS = [
  { id: '', label: 'Everything' }, { id: 'plan.', label: 'Plans & approvals' }, { id: 'clarification.', label: 'Questions' }, { id: 'agent.', label: 'Agent' },
  { id: 'dry_run.', label: 'Dry runs' }, { id: 'execution.', label: 'Executions, retries, rollbacks' },
];
const TONE = (e: string) => (/failed|rejected|rolled_back/.test(e) ? 'bad' : /completed|approved|answered/.test(e) ? 'ok' : /retried/.test(e) ? 'warn' : 'info');

function AuditLog() {
  const [prefix, setPrefix] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useHistory(prefix, offset);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        {FILTERS.map((f) => <button key={f.id} className={`btn sm ${prefix === f.id ? 'primary' : ''}`} onClick={() => { setPrefix(f.id); setOffset(0); }}>{f.label}</button>)}
      </div>
      <Async q={q}>
        {(h) => h.entries.length === 0 ? <Empty title="No history yet">Actions appear here as soon as they happen.</Empty> : (
          <>
            <div className="tablewrap"><table>
              <thead><tr><th>When</th><th>Who</th><th>Event</th><th>About</th><th>Details</th></tr></thead>
              <tbody>{h.entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap small">{fmtTime(e.ts)}</td><td>{e.actor}</td>
                  <td><Badge value={e.event} tone={TONE(e.event)} /></td>
                  <td className="small">{e.entityType.replace('_', ' ')} <code>{e.entityId}</code></td>
                  <td className="small"><details><summary className="muted">{Object.keys(e.details).slice(0, 4).join(', ') || '—'}</summary><Json value={e.details} /></details></td>
                </tr>))}</tbody></table></div>
            <Pager total={h.total} offset={offset} limit={25} onChange={setOffset} />
            <p className="muted small" style={{ marginTop: 8 }}>{h.total} events. This log is append-only: the database rejects any update or delete.</p>
          </>
        )}
      </Async>
    </>
  );
}

function AgentRuns() {
  const runs = useAgentRuns();
  const [sel, setSel] = useState<number | null>(null);
  const live = useLiveRun(sel);
  return (
    <Async q={runs}>
      {(list) => list.length === 0 ? <Empty title="No agent runs yet" /> : (
        <div className="split">
          <div className="vlist">
            {list.map((r) => (
              <button key={r.id} className={`item ${sel === r.id ? 'active' : ''}`} onClick={() => setSel(r.id)}>
                <div className="t">Run #{r.id} <Badge value={r.status} /></div>
                <div className="small muted">{r.kind}{r.baseVersion ? ` of v${r.baseVersion}` : ''} · {r.mode === 'llm' ? r.model : 'rule-based'} · {fmtTime(r.startedAt)}</div>
                <div className="small">{r.resultVersion ? `→ v${r.resultVersion}` : r.error ? 'failed' : ''}</div>
              </button>
            ))}
          </div>
          <div className="card">{sel === null ? <span className="muted">Select a run to see every tool call it made.</span> : <AgentTrace run={live.run} events={live.events} error={live.error} />}</div>
        </div>
      )}
    </Async>
  );
}

export function HistoryPage() {
  const [tab, setTab] = useState<'audit' | 'agent'>('audit');
  return (
    <>
      <div className="page-head"><div><h1>History</h1><p>Who did what, when: approvals, executions, retries and rollbacks, plus a replay of every agent run and the tools it called.</p></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'audit', label: 'Audit log' }, { id: 'agent', label: 'Agent runs' }]} />
      <div className="card">{tab === 'audit' ? <AuditLog /> : <AgentRuns />}</div>
    </>
  );
}
