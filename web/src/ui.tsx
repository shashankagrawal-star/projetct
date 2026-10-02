import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

// ---- small primitives ---------------------------------------------------------------------------
export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Banner({ kind, title, children, onRetry }: { kind: 'error' | 'warn' | 'ok' | 'info'; title?: string; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="grow">
        {title && <strong className="title">{title}</strong>}
        {children}
      </div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  const blockers = e && Array.isArray(e.details) ? (e.details as any[]) : [];
  return (
    <Banner kind="error" title={e ? e.message : error instanceof Error ? error.message : 'Something went wrong'} {...(onRetry ? { onRetry } : {})}>
      {blockers.length > 0 && (
        <ul>
          {blockers.map((b, i) => (
            <li key={i}>{typeof b === 'object' && b && 'message' in b ? String(b.message) : JSON.stringify(b)}</li>
          ))}
        </ul>
      )}
      {e && <div className="small">code: {e.code}</div>}
    </Banner>
  );
}

const TONES: Record<string, string> = {
  approved: 'ok', completed: 'ok', succeeded: 'ok', pass: 'ok', loaded: 'ok', accepted: 'ok', low: 'ok', answered: 'ok',
  proposed: 'info', running: 'info', skipped_existing: 'info', medium: 'warn', draft: 'warn', pending: 'warn', open: 'warn', dismissed: '',
  rejected: 'bad', failed: 'bad', fail: 'bad', high: 'bad', rolled_back: 'bad',
};
export const Badge = ({ value, label, tone }: { value: string; label?: string; tone?: string }) => (
  <span className={`badge ${tone ?? TONES[value] ?? ''}`}>{label ?? value.replace(/_/g, ' ')}</span>
);

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'info' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Pager({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  return (
    <div className="pager">
      <span className="muted small">
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <button className="btn sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        ← Prev
      </button>
      <button className="btn sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next →
      </button>
    </div>
  );
}

export const Json = ({ value }: { value: unknown }) => <pre className="json">{JSON.stringify(value, null, 2)}</pre>;

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(820px,100%)' } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title, children, confirmLabel, danger, busy, disabled, onConfirm, onClose,
}: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; disabled?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <div className="actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy || disabled}>
          {busy && <Spinner />} {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---- toasts -------------------------------------------------------------------------------------
type ToastKind = 'ok' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; text: string }
const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- formatting ---------------------------------------------------------------------------------
export const fmtTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtMinor = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : (n / 100).toLocaleString(undefined, { minimumFractionDigits: 2 }));
export const short = (hash: string): string => hash.slice(0, 10);
export const pct = (n: number, total: number): string => (total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`);
export const cellText = (v: unknown): string => (v === null || v === undefined ? '∅' : typeof v === 'string' ? (v === '' ? '""' : v) : JSON.stringify(v));
