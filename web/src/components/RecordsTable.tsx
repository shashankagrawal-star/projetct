import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { get } from '../api';
import type { FieldError, RecordsPage, RunRecord } from '../types';
import { Async } from '../queries';
import { Badge, Empty, Pager, cellText } from '../ui';

const STAGE_TONE: Record<string, string> = { transform: 'warn', validate: 'bad', duplicate: 'info', load: 'accent' };

export function ErrorEvidence({ errors }: { errors: FieldError[] }) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Stage</th><th>Target field</th><th>Rule</th><th>Code</th><th>Source value</th><th>Result</th><th>Why</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => (
            <tr key={i}>
              <td><Badge value={e.stage} tone={STAGE_TONE[e.stage] ?? ''} /></td>
              <td className="mono">{e.targetField}</td>
              <td className="mono">{e.rule ?? '—'}</td>
              <td className="mono">{e.code}</td>
              <td className="mono">{e.sourceField ? <><span className="muted">{e.sourceField}=</span>{cellText(e.sourceValue)}</> : '—'}</td>
              <td className="mono">{e.transformedValue !== undefined ? cellText(e.transformedValue) : '—'}</td>
              <td>{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ r, open, toggle }: { r: RunRecord; open: boolean; toggle: () => void }) {
  const bad = new Set(r.errors.flatMap((e) => [e.sourceField, e.targetField].filter(Boolean) as string[]));
  const fieldsOf = (obj: Record<string, unknown>) => Object.entries(obj).map(([k, v]) => <div key={k} style={bad.has(k) ? { color: 'var(--bad)', fontWeight: 700 } : undefined}>{k}: {cellText(v)}</div>);
  return (
    <Fragment>
      <tr className={`clickable ${open ? 'expanded' : ''}`} onClick={toggle} aria-expanded={open}>
        <td className="mono nowrap">{open ? '▾' : '▸'} {r.sourceKey}</td>
        <td><Badge value={r.status} /></td>
        <td>{r.errors.length === 0 ? <span className="muted">—</span> : r.errors.map((e, i) => <span key={i} className="chip" title={e.message}>{e.targetField}: {e.code}</span>)}</td>
        <td className="mono small">{cellText(r.source.email_addr ?? r.source.full_name)}</td>
      </tr>
      {open && (
        <tr className="expanded">
          <td colSpan={4}>
            <div className="diffcell">
              <div>
                <h4>Source record</h4>
                <pre className="json">{fieldsOf(r.source)}</pre>
              </div>
              <div>
                <h4>Transformed ({r.status === 'rejected' ? 'not loaded' : 'target shape'})</h4>
                <pre className="json">{fieldsOf(r.transformed)}</pre>
              </div>
            </div>
            {r.errors.length > 0 && (
              <>
                <h4 style={{ marginTop: 8 }}>Field-level evidence</h4>
                <ErrorEvidence errors={r.errors} />
              </>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Browsable per-record evidence for a dry run or an execution, with status / error-code filters and search. */
export function RecordsTable({ kind, id, statuses, codes, initialStatus = '', initialCode = '' }: { kind: 'dry-runs' | 'executions'; id: number; statuses: string[]; codes: string[]; initialStatus?: string; initialCode?: string }) {
  const [status, setStatus] = useState(initialStatus);
  const [code, setCode] = useState(initialCode);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const limit = 25;
  const query = useQuery({
    queryKey: ['records', kind, id, status, code, q, offset],
    queryFn: () => get<RecordsPage>(`/${kind}/${id}/records?limit=${limit}&offset=${offset}${status ? `&status=${status}` : ''}${code ? `&code=${code}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); setOpenKey(null); };

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="field">Status
          <select value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
            <option value="">All</option>
            {statuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label className="field">Error code
          <select value={code} onChange={(e) => reset(setCode)(e.target.value)}>
            <option value="">Any</option>
            {codes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field grow">Search (key or any source value)
          <input type="text" value={q} placeholder="e.g. C-0036 or gmail" onChange={(e) => reset(setQ)(e.target.value)} />
        </label>
        {(status || code || q) && <button className="btn sm" onClick={() => { setStatus(''); setCode(''); setQ(''); setOffset(0); }}>Clear filters</button>}
      </div>
      <Async q={query} label="Loading records…">
        {(page) =>
          page.records.length === 0 ? (
            <Empty title="No records match these filters" />
          ) : (
            <>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Source key</th><th>Status</th><th>Errors</th><th>Identity</th></tr></thead>
                  <tbody>
                    {page.records.map((r) => <Row key={r.sourceKey} r={r} open={openKey === r.sourceKey} toggle={() => setOpenKey(openKey === r.sourceKey ? null : r.sourceKey)} />)}
                  </tbody>
                </table>
              </div>
              <Pager total={page.total} offset={offset} limit={limit} onChange={(o) => { setOffset(o); setOpenKey(null); }} />
              <div className="muted small" style={{ marginTop: 6 }}>{page.total} record{page.total === 1 ? '' : 's'} match. Click a row for source vs. transformed values and the evidence for each error.</div>
            </>
          )
        }
      </Async>
    </div>
  );
}
