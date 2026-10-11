import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, CandlestickChart, ChartNoAxesCombined, Check, CheckCircle2, ChevronDown, ChevronRight, Code2, Database,
  FlaskConical, Footprints, GitCompare, Grid3x3, History, Info, LineChart, Moon, Palette, Sigma, Sun, XCircle,
} from "lucide-react";
import { BacktestPage } from "./pages/BacktestPage";
import { ComparePage } from "./pages/ComparePage";
import { ChartPage } from "./chart/ChartPage";
import { DataPage } from "./pages/DataPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LabPage } from "./pages/LabPage";
import { OptimizePage } from "./pages/OptimizePage";
import { WalkForwardPage } from "./pages/WalkForwardPage";
import { Spinner } from "./components/ui";
import { PALETTES, Page, useApp } from "./store";

interface NavPage { id: Page; label: string; icon: any; title: string; sub: string }
interface Section { id: "analysis" | "backtesting"; label: string; icon: any; blurb: string; pages: NavPage[] }

// Two sections, each with its own sub-pages.
const SECTIONS: Section[] = [
  {
    id: "analysis", label: "Analysis", icon: ChartNoAxesCombined, blurb: "Study your own CSV data",
    pages: [
      { id: "chart", label: "Chart", icon: CandlestickChart, title: "Chart", sub: "Candles, indicators and drawing tools for your datasets" },
      { id: "quant", label: "Quant analysis", icon: Sigma, title: "Quant analysis", sub: "Returns, risk, seasonality, drawdowns and correlation" },
    ],
  },
  {
    id: "backtesting", label: "Backtesting", icon: FlaskConical, blurb: "Test strategies on market data",
    pages: [
      { id: "backtest", label: "Backtest", icon: LineChart, title: "Backtest", sub: "Simulate a strategy on historical data" },
      { id: "compare", label: "Compare", icon: GitCompare, title: "Strategy comparison", sub: "Run several strategies on the same data, side by side" },
      { id: "optimize", label: "Optimize", icon: Grid3x3, title: "Parameter optimisation", sub: "Grid and random search across CPU cores" },
      { id: "walkforward", label: "Walk-forward", icon: Footprints, title: "Walk-forward analysis", sub: "Out-of-sample validation" },
      { id: "lab", label: "Strategy Lab", icon: Code2, title: "Strategy Lab", sub: "Write and test strategies in Python" },
      { id: "history", label: "History", icon: History, title: "Run history", sub: "Saved backtests" },
      { id: "data", label: "Market data", icon: Database, title: "Market data", sub: "Instruments and uploaded datasets" },
    ],
  },
];
const sectionOf = (p: Page) => SECTIONS.find((sec) => sec.pages.some((x) => x.id === p)) || SECTIONS[1];

/** The last sub-page used in each section, so switching sections returns you to where you were. */
function useLastPages(page: Page) {
  const [last, setLast] = useState<Record<string, Page>>(() => {
    try { return JSON.parse(localStorage.getItem("qf.nav.last") || "{}"); } catch { return {}; }
  });
  useEffect(() => {
    const sec = sectionOf(page).id;
    if (last[sec] === page) return;
    const next = { ...last, [sec]: page };
    setLast(next);
    try { localStorage.setItem("qf.nav.last", JSON.stringify(next)); } catch { /* private mode */ }
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  return last;
}

/** Appearance menu in the app bar: light or dark mode, and the colour palette. */
function Appearance() {
  const { theme, setTheme, palette, setPalette } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="appearance" ref={ref}>
      <button className="icon-btn appearance-btn" aria-label="Appearance" title="Appearance: mode and colour palette"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Palette size={18} strokeWidth={2.1} /><span className="appearance-dot" aria-hidden="true" />
      </button>
      {open && (
        <div className="appearance-pop" role="dialog" aria-label="Appearance">
          <div className="ap-title">Mode</div>
          <div className="ap-modes" role="radiogroup" aria-label="Mode">
            {(["light", "dark"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={theme === m} className={`ap-mode ${theme === m ? "on" : ""}`} onClick={() => setTheme(m)}>
                {m === "light" ? <Sun size={16} strokeWidth={2.2} /> : <Moon size={16} strokeWidth={2.2} />}{m === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
          <div className="ap-title">Colour palette</div>
          <div className="ap-palettes" role="radiogroup" aria-label="Colour palette">
            {PALETTES.map((x) => (
              <button key={x.id} role="radio" aria-checked={palette === x.id} aria-label={x.label} className={`ap-pal ${palette === x.id ? "on" : ""}`} onClick={() => setPalette(x.id)}>
                <span className="ap-swatch" aria-hidden="true">
                  <i style={{ background: x.swatch[0] }} />
                  <span className="sw-body" style={{ background: x.swatch[2] }}><i style={{ background: x.swatch[1] }} /><i /></span>
                </span>
                <span><b>{x.label}</b><small>{x.blurb}</small></span>
                {palette === x.id && <span className="ap-check"><Check size={13} strokeWidth={3} /></span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { page, go, theme, toggleTheme, toasts, meta, bootError, result } = useApp();
  const section = sectionOf(page);
  const cur = section.pages.find((x) => x.id === page) || section.pages[0];
  const last = useLastPages(page);
  const split = ["backtest", "compare", "optimize", "walkforward"].includes(page);
  const charting = page === "chart" || page === "quant";
  const [menu, setMenu] = useState<string | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const openMenu = (id: string | null) => { window.clearTimeout(closeTimer.current); setMenu(id); };
  const closeMenuSoon = () => { window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setMenu(null), 160); };
  const goSection = (sec: Section) => { setMenu(null); go(last[sec.id] && sec.pages.some((x) => x.id === last[sec.id]) ? last[sec.id] : sec.pages[0].id); };

  return (
    <div className="app">
      <header className="appbar topbar">
        <h1 className="sr-only">{cur.title}</h1>
        <div className="brand" title="QuantForge">
          <div className="brand-logo" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
          </div>
          <span className="brand-text"><span className="brand-name">QuantForge</span><span className="brand-tag">Quant research studio</span></span>
        </div>
        <nav className="sections" aria-label="Sections">
          {SECTIONS.map((sec) => (
            <div key={sec.id} className="section-tab-wrap" onMouseEnter={() => openMenu(sec.id)} onMouseLeave={closeMenuSoon}>
              <button className={`nav-section ${section.id === sec.id ? "active" : ""}`} aria-label={sec.label} aria-current={section.id === sec.id ? "true" : undefined}
                aria-haspopup="menu" aria-expanded={menu === sec.id} onClick={() => goSection(sec)}
                onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); openMenu(sec.id); } }}>
                <sec.icon size={18} strokeWidth={2.1} />
                <span className="nav-section-text">{sec.label}</span>
                <span className="nav-count" aria-hidden="true">{sec.pages.length}</span>
                <ChevronDown size={15} className="nav-caret" />
              </button>
              {menu === sec.id && (
                <div className="nav-menu" role="menu" aria-label={`${sec.label} pages`} onMouseEnter={() => openMenu(sec.id)} onMouseLeave={closeMenuSoon}>
                  <div className="nav-menu-head">
                    <span className="nav-menu-head-ic"><sec.icon size={17} strokeWidth={2.2} /></span>
                    <span><b>{sec.label}</b><small>{sec.blurb}</small></span>
                  </div>
                  {sec.pages.map((x) => (
                    <button key={x.id} role="menuitem" className={`nav-menu-item ${page === x.id ? "active" : ""}`} onClick={() => { setMenu(null); go(x.id); }}>
                      <span className="nav-menu-ic"><x.icon size={18} strokeWidth={2} /></span>
                      <span><b>{x.label}</b><small>{x.sub}</small></span>
                      <ArrowRight size={16} className="nav-menu-go" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="appbar-right">
          <span className="status-pill" title="Data sources">
            <span className={`dot ${bootError ? "neg" : "live"}`} />{bootError ? "Offline" : section.id === "analysis" ? "Your CSV data" : "Yahoo Finance"}
          </span>
          <Appearance />
          <button className="icon-btn theme-toggle" onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}>
            {theme === "dark" ? <Sun size={18} strokeWidth={2.1} /> : <Moon size={18} strokeWidth={2.1} />}
          </button>
        </div>
      </header>

      <nav className="subnav" aria-label={`${section.label} pages`}>
        <span className="subnav-crumb"><section.icon size={15} strokeWidth={2.3} />{section.label}<ChevronRight size={14} /></span>
        <div className="subnav-items">
          {section.pages.map((x) => (
            <button key={x.id} className={`nav-item ${page === x.id ? "active" : ""}`} onClick={() => go(x.id)}
              aria-current={page === x.id ? "page" : undefined} aria-label={x.label} title={x.sub}>
              <x.icon size={16} strokeWidth={2.1} /><span className="nav-text">{x.label}</span>
            </button>
          ))}
        </div>
        <span className="subnav-desc"><Info size={15} /><span>{cur.sub}</span></span>
      </nav>

      <main className={`content ${split ? "split" : ""} ${charting ? "full" : ""}`}>
        {bootError ? (
          <div className="alert err"><XCircle size={16} /><div><b>Cannot reach the QuantForge engine.</b> Start it with <code>./start.sh</code> (or <code>uv run python run.py</code>).<pre>{bootError}</pre></div></div>
        ) : !meta ? (
          <div className="empty"><Spinner size={22} /></div>
        ) : (
          <>
            {/* One chart workspace for both Analysis pages, so switching keeps your chart, drawings and data loaded. */}
            {charting && <ChartPage view={page === "quant" ? "analysis" : "chart"} />}
            {page === "backtest" && <BacktestPage />}
            {page === "compare" && <ComparePage />}
            {page === "optimize" && <OptimizePage />}
            {page === "walkforward" && <WalkForwardPage />}
            {page === "lab" && <LabPage />}
            {page === "data" && <DataPage />}
            {page === "history" && <HistoryPage />}
          </>
        )}
      </main>

      <footer className="statusbar">
        <span><span className={`dot ${bootError ? "neg" : "live"}`} />{bootError ? "Engine offline" : "Engine ready"}</span>
        <span className="sb-sep" />
        <span>{section.label} · {cur.label}</span>
        {meta && <><span className="sb-sep" /><span>{meta.markets.length - 1} markets</span></>}
        {result && page === "backtest" && (
          <><span className="sb-sep" /><span className="num">Last run {result.elapsed_ms} ms · {result.metrics.bars?.toLocaleString()} bars · {result.trades.length} trades</span></>
        )}
        <span className="sb-right">End-of-day and delayed intraday data · QuantForge 1.0</span>
      </footer>

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "ok" ? <CheckCircle2 size={17} color="var(--pos-text)" /> : t.kind === "err" ? <AlertTriangle size={17} color="var(--neg-text)" /> : <Info size={17} color="var(--accent)" />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
