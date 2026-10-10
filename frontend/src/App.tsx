import { useState } from "react";
import {
  AlertTriangle, CheckCircle2, Code2, Database, Footprints, Grid3x3, History, Info, LineChart, Moon,
  PanelLeftClose, PanelLeftOpen, Sun, XCircle,
} from "lucide-react";
import { BacktestPage } from "./pages/BacktestPage";
import { DataPage } from "./pages/DataPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LabPage } from "./pages/LabPage";
import { OptimizePage } from "./pages/OptimizePage";
import { WalkForwardPage } from "./pages/WalkForwardPage";
import { Spinner } from "./components/ui";
import { Page, useApp } from "./store";

const NAV: { id: Page; label: string; icon: any; title: string; sub: string; group: string }[] = [
  { id: "backtest", label: "Backtest", icon: LineChart, title: "Backtest", sub: "Simulate a strategy on historical data", group: "Research" },
  { id: "optimize", label: "Optimize", icon: Grid3x3, title: "Parameter optimisation", sub: "Grid & random search across CPU cores", group: "Research" },
  { id: "walkforward", label: "Walk-forward", icon: Footprints, title: "Walk-forward analysis", sub: "Out-of-sample validation of the optimisation process", group: "Research" },
  { id: "lab", label: "Strategy Lab", icon: Code2, title: "Strategy Lab", sub: "Write, validate and save strategies in Python", group: "Build" },
  { id: "data", label: "Data", icon: Database, title: "Market data", sub: "Explore instruments and manage uploaded datasets", group: "Build" },
  { id: "history", label: "History", icon: History, title: "Run history", sub: "Reopen and compare saved backtests", group: "Build" },
];

export default function App() {
  const { page, go, theme, toggleTheme, toasts, meta, bootError } = useApp();

  const [collapsed, setCollapsed] = useState(false);
  const cur = NAV.find((n) => n.id === page) || NAV[0];

  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
          </div>
          <div className="brand-text"><div className="brand-name">QuantForge</div><div className="brand-sub">Backtesting engine</div></div>
        </div>
        {["Research", "Build"].map((g) => (
          <div key={g}>
            <div className="nav-label">{g}</div>
            {NAV.filter((n) => n.group === g).map((n) => (
              <button key={n.id} className={`nav-item ${page === n.id ? "active" : ""}`} onClick={() => go(n.id)} title={n.label}>
                <n.icon size={16} strokeWidth={1.8} /><span className="nav-text">{n.label}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          <button className="nav-item" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}<span className="nav-text">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button className="nav-item" onClick={() => setCollapsed(!collapsed)} title="Collapse sidebar">
            {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.8} /> : <PanelLeftClose size={16} strokeWidth={1.8} />}<span className="nav-text">Collapse</span>
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1>{cur.title}</h1>
          <span className="crumb">{cur.sub}</span>
        </header>
        <div className={`content ${["backtest", "optimize", "walkforward"].includes(page) ? "split" : ""}`}>
          {bootError ? (
            <div className="alert err"><XCircle size={16} /><div><b>Cannot reach the backend API.</b> Start it with <code>./start.sh</code> (or <code>uv run python run.py</code>).<pre>{bootError}</pre></div></div>
          ) : !meta ? (
            <div className="empty"><Spinner size={24} /></div>
          ) : (
            <>
              {page === "backtest" && <BacktestPage />}
              {page === "optimize" && <OptimizePage />}
              {page === "walkforward" && <WalkForwardPage />}
              {page === "lab" && <LabPage />}
              {page === "data" && <DataPage />}
              {page === "history" && <HistoryPage />}
            </>
          )}
        </div>
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.kind === "ok" ? <CheckCircle2 size={16} color="var(--pos-text)" /> : t.kind === "err" ? <AlertTriangle size={16} color="var(--neg-text)" /> : <Info size={16} color="var(--accent)" />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
