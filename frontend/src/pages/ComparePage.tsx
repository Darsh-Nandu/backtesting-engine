import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Copy, GitCompare, Play, Plus, SlidersHorizontal, X } from "lucide-react";
import { api, CompareEntry, CompareResult, StrategyInfo } from "../api";
import { ConfigPanel, ParamForm } from "../components/ConfigPanel";
import { CompareResults } from "../components/CompareResults";
import { Section, Spinner } from "../components/ui";
import { useApp, usePalette } from "../store";

export const MAX_COMPARE = 8;
const PICKS_KEY = "qf.compare.picks";
const DEFAULT_PICKS = ["BuyAndHold", "SmaCross", "MacdCross", "RsiReversion"];

interface Pick { key: string; id: string; params: Record<string, any> }

const uid = () => Math.random().toString(36).slice(2, 10);

// The last comparison survives switching between modules.
let cached: CompareResult | null = null;

function loadPicks(): Pick[] {
  try {
    const v = JSON.parse(localStorage.getItem(PICKS_KEY) || "null");
    if (Array.isArray(v) && v.length) return v.filter((p) => p && p.id).map((p) => ({ key: uid(), id: p.id, params: p.params || {} }));
  } catch { /* ignore */ }
  return DEFAULT_PICKS.map((id) => ({ key: uid(), id, params: {} }));
}

/** Readable, unique labels: "SMA Crossover", "SMA Crossover (fast 50, slow 200)", ... */
export function pickLabels(picks: { id: string; params: Record<string, any> }[], strategies: StrategyInfo[]): string[] {
  const raw = picks.map((p) => {
    const info = strategies.find((s) => s.id === p.id);
    if (!info) return p.id.replace(/^custom:/, "");
    const changed = Object.entries(p.params).filter(([k, v]) => info.params[k] && v != null && v !== "" && v !== info.params[k].default);
    return changed.length ? `${info.name} (${changed.map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")})` : info.name;
  });
  const seen: Record<string, number> = {};
  return raw.map((l) => { seen[l] = (seen[l] || 0) + 1; return seen[l] > 1 ? `${l} #${seen[l]}` : l; });
}

export function ComparePage() {
  const { config, strategies, toast, setConfig, setResult, go } = useApp();
  const [picks, setPicksState] = useState<Pick[]>(loadPicks);
  const [res, setRes] = useState<CompareResult | null>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("qf.compare.settingsOpen") !== "0"; } catch { return true; }
  });
  const toggleSettings = () => setSettingsOpen((o) => {
    try { localStorage.setItem("qf.compare.settingsOpen", o ? "0" : "1"); } catch { /* ignore */ }
    return !o;
  });

  const setPicks = useCallback((fn: (p: Pick[]) => Pick[]) => {
    setPicksState((cur) => {
      const next = fn(cur).slice(0, MAX_COMPARE);
      try { localStorage.setItem(PICKS_KEY, JSON.stringify(next.map(({ id, params }) => ({ id, params })))); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Drop picks whose strategy no longer exists (e.g. a deleted custom strategy).
  const known = useMemo(() => picks.filter((p) => strategies.some((s) => s.id === p.id)), [picks, strategies]);
  const labels = useMemo(() => pickLabels(known, strategies), [known, strategies]);

  const busy = useRef(false);
  const run = useCallback(async () => {
    if (busy.current) return;
    if (known.length < 2) { setError("Pick at least two strategies to compare."); return; }
    busy.current = true;
    setLoading(true); setError(null);
    try {
      const r = await api.compare(config, known.map((p, i) => ({ id: p.id, params: p.params, label: labels[i] })));
      cached = r;
      setRes(r);
      const ok = r.strategies.filter((s) => !s.error);
      const best = [...ok].sort((a, b) => (b.metrics.sharpe ?? -1e9) - (a.metrics.sharpe ?? -1e9))[0];
      toast(`Compared ${ok.length} strategies${best ? ` · best Sharpe: ${best.label}` : ""}`);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [config, known, labels, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !loading) run(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, loading]);

  // Open one strategy of the comparison as a full backtest (same data and settings).
  const openInBacktest = useCallback(async (e: CompareEntry) => {
    if (!e.id) return;
    const strategy = { id: e.id, params: e.params || {} };
    toast(`Opening ${e.label} as a full backtest…`, "info");
    try {
      const r = await api.backtest({ ...config, strategy });
      setConfig((c) => ({ ...c, strategy }));
      setResult(r);
      go("backtest");
    } catch (err: any) {
      toast(err.message || String(err), "err");
    }
  }, [config, setConfig, setResult, go, toast]);

  const canRun = known.length >= 2 && config.symbols.length > 0;
  return (
    <div className={`bt-layout ${settingsOpen || !res ? "" : "collapsed"}`}>
      <div className="config" aria-hidden={!settingsOpen && !!res}>
        <ConfigPanel title="Compare settings"
          strategySection={<StrategyPicker picks={known} setPicks={setPicks} labels={labels} />}
          footer={
            <button className="btn btn-primary btn-run" onClick={run} disabled={loading || !canRun} title="Ctrl + Enter">
              {loading ? <><Spinner /> Comparing…</> : <><Play size={14} fill="currentColor" />Compare {known.length} {known.length === 1 ? "strategy" : "strategies"}<span className="kbd">Ctrl ↵</span></>}
            </button>
          } />
      </div>
      <div className="pane">
        {error && (
          <div className="alert err" style={{ marginBottom: 14 }}>
            <AlertCircle size={16} style={{ flex: "none", marginTop: 1 }} />
            <div><b>Comparison failed</b><pre>{error}</pre></div>
          </div>
        )}
        {loading && !res ? <Skeleton /> : res ? (
          <div data-compare-id={res.id} style={{ opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}>
            <CompareResults key={res.id} res={res} onOpen={openInBacktest}
              chrome={{ settingsOpen, onToggleSettings: toggleSettings, onRun: run, running: loading }} />
          </div>
        ) : <Welcome onRun={run} canRun={canRun} n={known.length} />}
      </div>
    </div>
  );
}

function StrategyPicker({ picks, setPicks, labels }: {
  picks: Pick[]; setPicks: (fn: (p: Pick[]) => Pick[]) => void; labels: string[];
}) {
  const { strategies } = useApp();
  const p = usePalette();
  const [open, setOpen] = useState<string | null>(null);
  const full = picks.length >= MAX_COMPARE;

  const grouped = useMemo(() => {
    const g: Record<string, StrategyInfo[]> = {};
    strategies.filter((s) => !s.broken).forEach((s) => (g[s.category] ||= []).push(s));
    return g;
  }, [strategies]);

  const add = (id: string) => { if (id) setPicks((ps) => [...ps, { key: uid(), id, params: {} }]); };
  const addGroup = (cat: string) => setPicks((ps) => {
    const have = new Set(ps.map((x) => x.id));
    return [...ps, ...grouped[cat].filter((s) => !have.has(s.id)).map((s) => ({ key: uid(), id: s.id, params: {} }))];
  });

  return (
    <Section title="Strategies" summary={`${picks.length} selected`}>
      <div className="hint" style={{ marginTop: -4 }}>
        Each strategy runs on the same data, capital, costs and trading rules. Add one twice to compare parameter sets.
      </div>
      <div className="cmp-picks" role="list" aria-label="Selected strategies">
        {picks.map((pk, i) => {
          const info = strategies.find((s) => s.id === pk.id);
          const isOpen = open === pk.key;
          const nParams = info ? Object.keys(info.params).length : 0;
          return (
            <div key={pk.key} className={`cmp-pick ${isOpen ? "open" : ""}`} role="listitem">
              <div className="cmp-pick-row">
                <span className="cmp-swatch" style={{ background: p.cmp[i % 8] }} />
                <button className="cmp-pick-name" onClick={() => setOpen(isOpen ? null : pk.key)} disabled={!nParams}
                  title={nParams ? "Edit parameters" : "No parameters"}>
                  <b>{labels[i]}</b><small>{info?.category}{info?.source === "custom" || pk.id.startsWith("custom:") ? " · my strategy" : ""}</small>
                </button>
                {nParams > 0 && (
                  <button className={`btn btn-sm btn-ghost btn-icon ${isOpen ? "on" : ""}`} onClick={() => setOpen(isOpen ? null : pk.key)}
                    title="Edit parameters" aria-label={`Edit parameters of ${labels[i]}`}><SlidersHorizontal size={15} /></button>
                )}
                <button className="btn btn-sm btn-ghost btn-icon" disabled={full} title="Duplicate (compare another parameter set)"
                  aria-label={`Duplicate ${labels[i]}`}
                  onClick={() => { const key = uid(); setPicks((ps) => [...ps.slice(0, i + 1), { key, id: pk.id, params: { ...pk.params } }, ...ps.slice(i + 1)]); setOpen(key); }}>
                  <Copy size={15} /></button>
                <button className="btn btn-sm btn-ghost btn-icon" title="Remove" aria-label={`Remove ${labels[i]}`}
                  onClick={() => setPicks((ps) => ps.filter((x) => x.key !== pk.key))}><X size={16} /></button>
              </div>
              {isOpen && info && (
                <div className="cmp-pick-body">
                  <ParamForm strat={info} values={pk.params} onChange={(params) => setPicks((ps) => ps.map((x) => (x.key === pk.key ? { ...x, params } : x)))} />
                  <button className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={() => setPicks((ps) => ps.map((x) => (x.key === pk.key ? { ...x, params: {} } : x)))}>
                    Reset to defaults</button>
                </div>
              )}
            </div>
          );
        })}
        {!picks.length && <div className="cmp-empty">No strategies selected yet</div>}
      </div>
      <div className="cmp-add">
        <Plus size={16} className="cmp-add-icon" />
        <select className="select" value="" disabled={full} aria-label="Add strategy" onChange={(e) => add(e.target.value)}>
          <option value="">{full ? `Maximum of ${MAX_COMPARE} strategies` : "Add a strategy"}</option>
          {Object.entries(grouped).map(([cat, list]) => (
            <optgroup key={cat} label={cat}>{list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
          ))}
        </select>
      </div>
      <div className="cmp-quick">
        <span className="muted">Add a group:</span>
        {Object.keys(grouped).map((cat) => (
          <button key={cat} className="cmp-chip" disabled={full} onClick={() => addGroup(cat)}>{cat}</button>
        ))}
        {picks.length > 0 && <button className="cmp-chip ghost" onClick={() => setPicks(() => [])}>Clear</button>}
      </div>
    </Section>
  );
}

function Skeleton() {
  return (
    <div>
      <div className="skeleton" style={{ height: 44, width: "40%", marginBottom: 18 }} />
      <div className="skeleton" style={{ height: 112, marginBottom: 20 }} />
      <div className="skeleton" style={{ height: 460 }} />
    </div>
  );
}

function Welcome({ onRun, canRun, n }: { onRun: () => void; canRun: boolean; n: number }) {
  return (
    <div className="card empty" style={{ minHeight: 520 }}>
      <div>
        <div className="empty-art" style={{ margin: "0 auto" }}><GitCompare size={28} strokeWidth={1.6} /></div>
        <h2>Compare strategies side by side</h2>
        <p>Pick two or more strategies on the left (built-in or your own). They all run on the same market data, capital, costs and trading rules, so the results are directly comparable.</p>
        <button className="btn btn-primary" style={{ marginTop: 22, height: 38, padding: "0 18px" }} onClick={onRun} disabled={!canRun}>
          {canRun ? `Compare ${n} strategies` : "Pick at least two strategies"}</button>
        <div className="feature-list">
          <span>Overlaid equity & drawdowns</span>
          <span>Risk vs return map</span>
          <span>Correlation & equal-weight blend</span>
        </div>
      </div>
    </div>
  );
}
