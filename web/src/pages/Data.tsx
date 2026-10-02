import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../api';
import { Async, useRules, useSource, useTarget } from '../queries';
import type { SourceRecord_ } from '../types';
import { Badge, Empty, Pager, Stat, Tabs, cellText } from '../ui';

type TabId = 'source' | 'target' | 'records' | 'store' | 'rules';

function SourceRecords({ fields }: { fields: string[] }) {
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const query = useQuery({ queryKey: ['source-records', offset, q], queryFn: () => get<{ total: number; rows: SourceRecord_[] }>(`/source/records?limit=25&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`), placeholderData: (p) => p });
  return (
    <>
      <label className="field" style={{ maxWidth: 360, marginBottom: 10 }}>Search any value
        <input type="text" value={q} placeholder="e.g. gmail, C-0036, Atlantis" onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </label>
      <Async q={query}>
        {(p) => p.rows.length === 0 ? <Empty title="No records match" /> : (
          <>
            <div className="tablewrap">
              <table>
                <thead><tr>{fields.map((f) => <th key={f}>{f}</th>)}</tr></thead>
                <tbody>{p.rows.map((r, i) => <tr key={i}>{fields.map((f) => <td key={f} className="mono small">{cellText(r[f])}</td>)}</tr>)}</tbody>
              </table>
            </div>
            <Pager total={p.total} offset={offset} limit={25} onChange={setOffset} />
          </>
        )}
      </Async>
    </>
  );
}

function TargetRecords({ fields }: { fields: string[] }) {
  const [offset, setOffset] = useState(0);
  const [origin, setOrigin] = useState('all');
  const query = useQuery({ queryKey: ['target-records', offset, origin], queryFn: () => get<{ total: number; rows: Array<Record<string, unknown>> }>(`/target/records?limit=25&offset=${offset}&origin=${origin}`), placeholderData: (p) => p });
  return (
    <>
      <label className="field" style={{ maxWidth: 220, marginBottom: 10 }}>Show
        <select value={origin} onChange={(e) => { setOrigin(e.target.value); setOffset(0); }}>
          <option value="all">All rows</option><option value="seed">Pre-existing only</option><option value="migrated">Migrated only</option>
        </select>
      </label>
      <Async q={query}>
        {(p) => p.rows.length === 0 ? <Empty title="The target has no rows here yet">Migrated rows appear after an execution.</Empty> : (
          <>
            <div className="tablewrap">
              <table>
                <thead><tr><th>origin</th>{fields.map((f) => <th key={f}>{f}</th>)}<th>source_key</th></tr></thead>
                <tbody>{p.rows.map((r, i) => <tr key={i}><td>{r.execution_id ? <Badge value={`exec #${r.execution_id}`} tone="accent" /> : <Badge value="pre-existing" />}</td>{fields.map((f) => <td key={f} className="mono small">{cellText(r[f])}</td>)}<td className="mono small">{cellText(r.source_key)}</td></tr>)}</tbody>
              </table>
            </div>
            <Pager total={p.total} offset={offset} limit={25} onChange={setOffset} />
          </>
        )}
      </Async>
    </>
  );
}

export function DataPage() {
  const source = useSource();
  const target = useTarget();
  const rules = useRules();
  const [tab, setTab] = useState<TabId>('source');
  return (
    <>
      <div className="page-head"><div><h1>Source & target</h1><p>What is being migrated and where to. The sample is bounded (documented maximum {500} records) and the target is a mock staging store seeded with a few pre-existing customers.</p></div></div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="Source records" value={source.data?.total ?? '…'} sub="legacy_customers (sample)" />
        <Stat label="Source fields" value={source.data?.schema.fields.length ?? '…'} />
        <Stat label="Target rows" value={target.data?.total ?? '…'} sub={target.data ? `${target.data.preExisting} pre-existing · ${target.data.migrated} migrated` : ''} />
        <Stat label="Target fields" value={target.data?.schema.fields.length ?? '…'} />
      </div>
      <Tabs<TabId> value={tab} onChange={setTab} tabs={[{ id: 'source', label: 'Source schema' }, { id: 'target', label: 'Target schema' }, { id: 'records', label: 'Source records' }, { id: 'store', label: 'Target store' }, { id: 'rules', label: 'Supported rules' }]} />
      {tab === 'source' && <Async q={source}>{({ schema }) => (
        <div className="card"><h2>{schema.name}</h2><p className="muted">{schema.description}</p>
          <div className="tablewrap"><table><thead><tr><th>Field</th><th>Type</th><th>Nullable</th><th>Description</th></tr></thead>
            <tbody>{schema.fields.map((f) => <tr key={f.name}><td className="mono">{f.name}{f.name === schema.primaryKey && <Badge value="key" tone="accent" />}</td><td>{f.type}</td><td>{f.nullable ? 'yes' : 'no'}</td><td>{f.description}</td></tr>)}</tbody></table></div></div>
      )}</Async>}
      {tab === 'target' && <Async q={target}>{({ schema }) => (
        <div className="card"><h2>{schema.name}</h2><p className="muted">{schema.description}</p>
          <div className="tablewrap"><table><thead><tr><th>Field</th><th>Type</th><th>Constraints</th><th>Description</th></tr></thead>
            <tbody>{schema.fields.map((f) => <tr key={f.name}><td className="mono">{f.name}{f.required && <span style={{ color: 'var(--bad)' }}> *</span>}</td><td>{f.type}</td>
              <td className="small">{[f.unique && 'unique', f.enum && `one of ${f.enum.join(', ')}`, f.pattern && <code key="p">{f.pattern}</code>, f.maxLength && `≤ ${f.maxLength} chars`].filter(Boolean).map((x, i) => <span key={i} style={{ marginRight: 8 }}>{x}</span>)}</td><td>{f.description}</td></tr>)}</tbody></table></div></div>
      )}</Async>}
      {tab === 'records' && source.data && <div className="card"><SourceRecords fields={source.data.schema.fields.map((f) => f.name)} /></div>}
      {tab === 'store' && target.data && <div className="card"><TargetRecords fields={target.data.schema.fields.map((f) => f.name)} /></div>}
      {tab === 'rules' && <Async q={rules}>{(list) => (
        <div className="card"><h2>Supported transformation rules</h2>
          <p className="muted">The complete, closed set. The agent and the editor can only pick from these — there is no arbitrary code or expression language. Rules marked ⚠ approximate or discard information.</p>
          <div className="tablewrap"><table><thead><tr><th>Rule</th><th>Output</th><th>Parameters</th><th>What it does</th></tr></thead>
            <tbody>{list.map((r) => <tr key={r.id}><td className="mono nowrap">{r.id} {r.lossy && <span title="lossy">⚠</span>}</td><td>{r.outputType}</td>
              <td className="small">{r.params.length === 0 ? <span className="muted">none</span> : r.params.map((p) => <div key={p.name}><code>{p.name}{p.required ? '*' : ''}</code>: {p.type}</div>)}</td><td>{r.description}</td></tr>)}</tbody></table></div></div>
      )}</Async>}
    </>
  );
}
