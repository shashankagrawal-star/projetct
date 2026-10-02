import { useEffect, useMemo, useState } from 'react';
import { post } from '../api';
import type { FieldMapping, MappingSpec, ParamSpec, Risk, RuleInfo, SourceSchema, Step, TargetSchema, Validation } from '../types';
import { Badge } from '../ui';

const paramText = (v: unknown): string => (Array.isArray(v) ? v.join(' | ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

export function StepChips({ steps, rules }: { steps: Step[]; rules: Map<string, RuleInfo> }) {
  if (steps.length === 0) return <span className="muted">copy as-is</span>;
  return (
    <>
      {steps.map((s, i) => {
        const info = rules.get(s.rule);
        const params = s.params && Object.keys(s.params).length ? Object.entries(s.params).map(([k, v]) => `${k}=${paramText(v)}`).join(', ') : '';
        return (
          <span key={i} className={`chip ${info?.lossy ? 'lossy' : ''}`} title={`${info?.description ?? 'unknown rule'}${info?.lossy ? '\n⚠ LOSSY: approximates or discards information' : ''}`}>
            {i > 0 && '→ '}
            {s.rule}
            {params && <span className="muted">({params.length > 70 ? `${params.slice(0, 70)}…` : params})</span>}
          </span>
        );
      })}
    </>
  );
}

export function MappingView({ mapping, target, rules }: { mapping: MappingSpec; target: TargetSchema; rules: RuleInfo[] }) {
  const byName = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);
  const byTarget = new Map(mapping.fields.map((f) => [f.target, f]));
  return (
    <>
      <div className="tablewrap">
        <table className="mapping-table">
          <thead>
            <tr><th>Target field</th><th>Source</th><th>Transformation</th><th>Risk</th><th>Rationale</th></tr>
          </thead>
          <tbody>
            {target.fields.map((tf) => {
              const fm = byTarget.get(tf.name);
              return (
                <tr key={tf.name}>
                  <td>
                    <strong className="mono">{tf.name}</strong>{tf.required && <span title="required" style={{ color: 'var(--bad)' }}> *</span>}
                    <div className="muted small">{tf.type}{tf.unique ? ' · unique' : ''}{tf.enum ? ` · ${tf.enum.join('/')}` : ''}</div>
                  </td>
                  <td className="mono">{fm ? (fm.source ?? <Badge value="no source" tone="warn" />) : <Badge value="unmapped" tone="bad" />}</td>
                  <td>{fm ? <StepChips steps={fm.steps} rules={byName} /> : '—'}</td>
                  <td>{fm ? <Badge value={fm.risk} /> : '—'}</td>
                  <td className="small">{fm?.rationale || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mapping.unmappedSource.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h4>Source fields deliberately not migrated</h4>
          {mapping.unmappedSource.map((u) => (
            <div key={u.field} className="small"><code>{u.field}</code> — {u.reason}</div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- editor -------------------------------------------------------------------------------------
function parseScalar(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw);
  return raw;
}

function ParamInput({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const label = `${spec.name}${spec.required ? '*' : ''}`;
  const [draft, setDraft] = useState(() => (spec.type === 'record' ? JSON.stringify(value ?? {}, null, 1) : ''));
  const [bad, setBad] = useState(false);
  switch (spec.type) {
    case 'string':
      return <label className="field">{label}<input type="text" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} title={spec.description} /></label>;
    case 'integer':
      return <label className="field">{label}<input type="number" value={(value as number | undefined) ?? ''} style={{ width: 90 }} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} title={spec.description} /></label>;
    case 'boolean':
      return <label className="check small"><input type="checkbox" checked={value !== false} onChange={(e) => onChange(e.target.checked)} />{spec.name}</label>;
    case 'enum':
      return <label className="field">{label}<select value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>{!spec.required && <option value="">(none)</option>}{spec.enum?.map((o) => <option key={o}>{o}</option>)}</select></label>;
    case 'scalar':
      return <label className="field">{label}<input type="text" value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : parseScalar(e.target.value))} title={`${spec.description} Numbers and true/false are typed automatically.`} /></label>;
    case 'string[]': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="field">{label}
          <div className="row" style={{ gap: 4 }}>
            {list.map((v, i) => <span key={`${v}${i}`} className="chip">{v}<button className="btn ghost sm" style={{ padding: 0 }} aria-label={`remove ${v}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button></span>)}
            {spec.enum ? (
              <select value="" aria-label={`add ${spec.name}`} onChange={(e) => e.target.value && onChange([...list, e.target.value])}>
                <option value="">+ add</option>
                {spec.enum.filter((o) => !list.includes(o)).map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input type="text" placeholder="type + Enter" style={{ width: 120 }} onKeyDown={(e) => { if (e.key === 'Enter' && e.currentTarget.value.trim()) { onChange([...list, e.currentTarget.value.trim()]); e.currentTarget.value = ''; } }} />
            )}
          </div>
        </div>
      );
    }
    case 'record':
      return (
        <label className="field" style={{ minWidth: 260 }}>{label} <span className="muted">(JSON object)</span>
          <textarea value={draft} rows={3} style={bad ? { borderColor: 'var(--bad)' } : undefined} onChange={(e) => {
            setDraft(e.target.value);
            try { const parsed = JSON.parse(e.target.value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { onChange(parsed); setBad(false); } else setBad(true); } catch { setBad(true); }
          }} />
          {bad && <span style={{ color: 'var(--bad)' }}>Not a valid JSON object — the previous valid value is still in use.</span>}
        </label>
      );
  }
}

function StepEditor({ step, rules, onChange, onMove, onRemove }: { step: Step; rules: RuleInfo[]; onChange: (s: Step) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const info = rules.find((r) => r.id === step.rule);
  const setParam = (name: string, v: unknown) => {
    const next = { ...(step.params ?? {}) };
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0 && !info?.params.find((p) => p.name === name)?.required)) delete next[name];
    else next[name] = v;
    onChange({ ...step, params: next });
  };
  return (
    <div className="card" style={{ padding: 8, marginBottom: 6, background: 'var(--surface-2)' }}>
      <div className="row">
        <select value={step.rule} aria-label="Rule" onChange={(e) => onChange({ rule: e.target.value, params: {} })}>
          {rules.map((r) => <option key={r.id} value={r.id}>{r.label}{r.lossy ? ' ⚠' : ''}</option>)}
          {!info && <option value={step.rule}>{step.rule} (unknown)</option>}
        </select>
        <span className="right row" style={{ gap: 2 }}>
          <button className="btn ghost sm" onClick={() => onMove(-1)} aria-label="Move step up">↑</button>
          <button className="btn ghost sm" onClick={() => onMove(1)} aria-label="Move step down">↓</button>
          <button className="btn ghost sm" onClick={onRemove} aria-label="Remove step">✕</button>
        </span>
      </div>
      {info && <div className="muted small" style={{ margin: '4px 0' }}>{info.description}</div>}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {info?.params.map((p) => <ParamInput key={`${step.rule}.${p.name}`} spec={p} value={step.params?.[p.name]} onChange={(v) => setParam(p.name, v)} />)}
      </div>
    </div>
  );
}

function defaultStep(rule: RuleInfo): Step {
  const params: Record<string, unknown> = {};
  for (const p of rule.params) if (p.default !== undefined && p.required) params[p.name] = p.default;
  return { rule: rule.id, params };
}

export function MappingEditor({ initial, source, target, rules, onChange, onValidation }: { initial: MappingSpec; source: SourceSchema; target: TargetSchema; rules: RuleInfo[]; onChange: (m: MappingSpec) => void; onValidation?: (v: Validation | null) => void }) {
  const [mapping, setMapping] = useState<MappingSpec>(() => JSON.parse(JSON.stringify(initial)) as MappingSpec);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    onChange(mapping);
    const t = setTimeout(() => {
      post<Validation>('/validate-mapping', { mapping }).then((v) => { setValidation(v); onValidation?.(v); }).catch(() => { setValidation(null); onValidation?.(null); });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping]);

  const update = (target: string, fn: (f: FieldMapping) => FieldMapping | null) =>
    setMapping((m) => ({
      ...m,
      fields: m.fields.flatMap((f) => {
        if (f.target !== target) return [f];
        const next = fn(f);
        return next ? [next] : [];
      }),
    }));
  const usedSources = new Set(mapping.fields.map((f) => f.source).filter(Boolean) as string[]);
  const dropped = new Set(mapping.unmappedSource.map((u) => u.field));
  const issuesFor = (t: string) => [...(validation?.errors ?? []), ...(validation?.warnings ?? [])].filter((i) => i.targetField === t);

  return (
    <div>
      {target.fields.map((tf) => {
        const fm = mapping.fields.find((f) => f.target === tf.name);
        const issues = issuesFor(tf.name);
        return (
          <div className="card" key={tf.name} style={{ padding: 12, marginBottom: 10 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <strong className="mono">{tf.name}</strong>{tf.required && <span style={{ color: 'var(--bad)' }}>*</span>}
              <span className="muted small">{tf.type}{tf.enum ? ` (${tf.enum.join('/')})` : ''}{tf.pattern ? ` · ${tf.pattern}` : ''}{tf.maxLength ? ` · ≤${tf.maxLength}` : ''}{tf.unique ? ' · unique' : ''}</span>
              {fm && <button className="btn ghost sm right" onClick={() => update(tf.name, () => null)}>Remove mapping</button>}
            </div>
            {!fm ? (
              <button className="btn sm" onClick={() => setMapping((m) => ({ ...m, fields: [...m.fields, { target: tf.name, source: null, steps: [{ rule: 'constant', params: { value: '' } }], risk: 'high', rationale: '' }] }))}>+ Add mapping</button>
            ) : (
              <>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <label className="field">Source field
                    <select value={fm.source ?? ''} onChange={(e) => update(tf.name, (f) => ({ ...f, source: e.target.value || null }))}>
                      <option value="">— none (needs a constant) —</option>
                      {source.fields.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                  </label>
                  <label className="field">Risk
                    <select value={fm.risk} onChange={(e) => update(tf.name, (f) => ({ ...f, risk: e.target.value as Risk }))}>
                      <option>low</option><option>medium</option><option>high</option>
                    </select>
                  </label>
                  <label className="field grow">Rationale
                    <input type="text" value={fm.rationale} maxLength={1000} onChange={(e) => update(tf.name, (f) => ({ ...f, rationale: e.target.value }))} />
                  </label>
                </div>
                <div style={{ marginTop: 8 }}>
                  {fm.steps.map((s, i) => (
                    <StepEditor
                      key={i}
                      step={s}
                      rules={rules}
                      onChange={(ns) => update(tf.name, (f) => ({ ...f, steps: f.steps.map((x, j) => (j === i ? ns : x)) }))}
                      onRemove={() => update(tf.name, (f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))}
                      onMove={(d) => update(tf.name, (f) => {
                        const steps = [...f.steps];
                        const j = i + d;
                        if (j < 0 || j >= steps.length) return f;
                        [steps[i], steps[j]] = [steps[j]!, steps[i]!];
                        return { ...f, steps };
                      })}
                    />
                  ))}
                  {adding === tf.name ? (
                    <select autoFocus value="" onBlur={() => setAdding(null)} onChange={(e) => { const r = rules.find((x) => x.id === e.target.value); if (r) update(tf.name, (f) => ({ ...f, steps: [...f.steps, defaultStep(r)] })); setAdding(null); }}>
                      <option value="">Choose a rule…</option>
                      {rules.map((r) => <option key={r.id} value={r.id}>{r.label}{r.lossy ? ' ⚠' : ''}</option>)}
                    </select>
                  ) : (
                    <button className="btn sm" onClick={() => setAdding(tf.name)}>+ Add step</button>
                  )}
                </div>
              </>
            )}
            {issues.map((i, k) => <div key={k} className="small" style={{ color: i.severity === 'error' ? 'var(--bad)' : 'var(--warn)', marginTop: 4 }}>{i.severity === 'error' ? '✖' : '⚠'} {i.message}</div>)}
          </div>
        );
      })}

      <div className="card" style={{ padding: 12 }}>
        <h3>Source fields not migrated</h3>
        <p className="muted small">Every source field must be mapped or explicitly dropped here. Dropping is a data-loss decision a reviewer should acknowledge.</p>
        {source.fields.filter((s) => !usedSources.has(s.name)).map((s) => (
          <label className="check small" key={s.name} style={{ marginBottom: 4 }}>
            <input type="checkbox" checked={dropped.has(s.name)} onChange={(e) => setMapping((m) => ({ ...m, unmappedSource: e.target.checked ? [...m.unmappedSource, { field: s.name, reason: 'Not migrated: no target field with the same meaning.' }] : m.unmappedSource.filter((u) => u.field !== s.name) }))} />
            <span><code>{s.name}</code> — drop</span>
          </label>
        ))}
        {source.fields.every((s) => usedSources.has(s.name)) && <span className="muted small">All source fields are mapped.</span>}
      </div>

      {validation && (validation.errors.some((e) => !e.targetField) || validation.warnings.some((e) => !e.targetField)) && (
        <div className="card" style={{ padding: 12 }}>
          <h3>Other issues</h3>
          {[...validation.errors, ...validation.warnings].filter((i) => !i.targetField).map((i, k) => <div key={k} className="small" style={{ color: i.severity === 'error' ? 'var(--bad)' : 'var(--warn)' }}>{i.severity === 'error' ? '✖' : '⚠'} {i.message}</div>)}
        </div>
      )}
    </div>
  );
}
