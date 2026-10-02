import { useEffect, useState } from 'react';
import { get } from '../api';
import type { AgentEvent, AgentRun } from '../types';
import { Badge, Json, Spinner } from '../ui';

/** Polls one agent run with a cursor so only new events travel over the wire. */
export function useLiveRun(runId: number | null) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setRun(null);
    setEvents([]);
    setError(null);
    if (runId === null) return;
    let stopped = false;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await get<{ run: AgentRun; events: AgentEvent[] }>(`/agent/runs/${runId}?after=${after}`);
        if (stopped) return;
        setRun(res.run);
        const last = res.events[res.events.length - 1];
        if (last) {
          after = last.seq;
          setEvents((prev) => [...prev, ...res.events]);
        }
        if (res.run.status === 'running') timer = setTimeout(tick, 900);
      } catch (e) {
        if (!stopped) setError(e);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { run, events, error };
}

const ICON: Record<string, string> = { start: '▶', thinking: '💭', assistant_text: '💬', tool_call: '🔧', tool_result: '↩', proposal: '📋', warning: '⚠', error: '✖', end: '■' };

function summarize(ev: AgentEvent): string {
  const p = ev.payload;
  switch (ev.type) {
    case 'start':
      return `${p?.mode === 'llm' ? `LLM ${p?.model}` : 'rule-based engine'} · ${p?.kind}${p?.baseVersion ? ` of v${p.baseVersion}` : ''}`;
    case 'tool_call':
      return p && Object.keys(p).length ? JSON.stringify(p).slice(0, 110) : 'no arguments';
    case 'tool_result':
      return p?.isError ? 'error returned to the agent' : 'ok';
    case 'assistant_text':
    case 'thinking':
      return String(p?.text ?? '').slice(0, 160);
    case 'proposal':
      return `v${p?.version} · ${p?.fields} fields · ${p?.risks} risks · ${p?.questions} questions`;
    case 'error':
      return String(p?.message ?? '');
    case 'end':
      return String(p?.status ?? '');
    default:
      return '';
  }
}

export function AgentTrace({ run, events, error }: { run: AgentRun | null; events: AgentEvent[]; error?: unknown }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {run?.status === 'running' && <Spinner />}
        {run && <Badge value={run.status} />}
        {run && <Badge value={run.mode} tone={run.mode === 'llm' ? 'accent' : 'warn'} label={run.mode === 'llm' ? run.model ?? 'llm' : 'rule-based (no LLM)'} />}
        {run && run.mode === 'llm' && (run.inputTokens > 0 || run.outputTokens > 0) && (
          <span className="muted small">
            {run.inputTokens.toLocaleString()} in / {run.outputTokens.toLocaleString()} out tokens
          </span>
        )}
        {run?.error && <span className="small" style={{ color: 'var(--bad)' }}>{run.error}</span>}
        {error ? <span className="small" style={{ color: 'var(--bad)' }}>Lost contact with the server while following this run.</span> : null}
      </div>
      <div className="trace" aria-live="polite">
        {events.length === 0 && <div className="muted">Waiting for the first step…</div>}
        {events.map((ev) => (
          <div className="ev" key={ev.seq}>
            <span aria-hidden>{ICON[ev.type] ?? '•'}</span>
            <span className="k">{ev.name ?? ev.type}</span>
            <div className="grow">
              {ev.type === 'tool_result' || ev.type === 'tool_call' ? (
                <details>
                  <summary>
                    {summarize(ev)} {ev.durationMs !== null && <span className="muted">· {ev.durationMs} ms</span>}
                  </summary>
                  <Json value={ev.payload} />
                </details>
              ) : (
                <span style={{ color: ev.type === 'error' ? 'var(--bad)' : undefined, fontStyle: ev.type === 'thinking' ? 'italic' : undefined }}>{summarize(ev)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
