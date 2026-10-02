import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { getActor, setActor } from './api';
import { DataPage } from './pages/Data';
import { DryRunPage } from './pages/DryRun';
import { ExecutePage } from './pages/Execute';
import { HistoryPage } from './pages/History';
import { OverviewPage } from './pages/Overview';
import { PlanPage } from './pages/Plan';
import { useConfig, useOverview } from './queries';
import { Badge } from './ui';

function ActorInput() {
  const [name, setName] = useState(getActor());
  return (
    <label className="row small muted" title="Recorded in the audit history for every action you take. This is attribution, not authentication.">
      Acting as
      <input
        type="text"
        value={name}
        maxLength={60}
        aria-label="Your name (recorded in the audit history)"
        style={{ width: 130 }}
        onChange={(e) => {
          setName(e.target.value);
          setActor(e.target.value.trim() || 'reviewer');
        }}
      />
    </label>
  );
}

export function App() {
  const config = useConfig();
  const overview = useOverview();
  const o = overview.data;
  const agent = config.data?.agent;

  const dot = (done: boolean, warn = false) => (done ? 'num done' : warn ? 'num warn' : 'num');
  const items = [
    { to: '/', label: 'Overview', n: '•', cls: 'num', end: true },
    { to: '/data', label: 'Source & target', n: '1', cls: dot(!!o) },
    { to: '/plan', label: 'Mapping plan', n: '2', cls: dot(!!o?.plans.approved, !!o?.plans.count) },
    { to: '/dry-run', label: 'Dry run', n: '3', cls: dot(!!o?.dryRun, false) },
    { to: '/execution', label: 'Approve & execute', n: '4', cls: dot(o?.execution?.status === 'completed', o?.execution?.status === 'failed') },
    { to: '/history', label: 'History', n: '5', cls: 'num' },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden />
          Migration Workbench
        </div>
        <span className="muted small">legacy_customers → customers · mock staging store</span>
        <div className="right row">
          {agent && (
            <span title={agent.mode === 'llm' ? 'Plans are proposed by a Claude agent using read-only inspection tools.' : 'No ANTHROPIC_API_KEY on this server: proposals come from the deterministic rule-based fallback engine, not an LLM.'}>
              <Badge value={agent.mode} tone={agent.mode === 'llm' ? 'accent' : 'warn'} label={agent.mode === 'llm' ? `Agent: ${agent.model}` : 'Agent: rule-based fallback (no LLM)'} />
            </span>
          )}
          <ActorInput />
        </div>
      </header>
      <aside className="sidebar">
        <nav className="nav" aria-label="Workflow">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className={i.cls}>{i.cls.includes('done') ? '✓' : i.n}</span>
              {i.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/plan/:version" element={<PlanPage />} />
          <Route path="/dry-run" element={<DryRunPage />} />
          <Route path="/execution" element={<ExecutePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
