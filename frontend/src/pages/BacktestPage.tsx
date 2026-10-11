import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Globe2, Layers, LineChart, Play, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { ConfigPanel } from "../components/ConfigPanel";
import { Results } from "../components/Results";
import { Spinner } from "../components/ui";
import { useApp } from "../store";

export function BacktestPage() {
  const { config, result, setResult, toast } = useApp();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("qf.settingsOpen") !== "0"; } catch { return true; }
  });
  const toggleSettings = () => setSettingsOpen((o) => {
    try { localStorage.setItem("qf.settingsOpen", o ? "0" : "1"); } catch { /* ignore */ }
    return !o;
  });

  const busy = useRef(false);
  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true); setError(null);
    try {
      const r = await api.backtest(config);
      setResult(r);
      toast(`Backtest finished · ${r.trades.length} trades · ${r.metrics.total_return_pct > 0 ? "+" : ""}${r.metrics.total_return_pct}%`);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [config, setResult, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !loading) run(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, loading]);

  return (
    <div className={`bt-layout ${settingsOpen || !result ? "" : "collapsed"}`}>
      <div className="config" aria-hidden={!settingsOpen && !!result}>
        <ConfigPanel footer={
          <button className="btn btn-primary btn-run" onClick={run} disabled={loading || !config.symbols.length} title="Ctrl + Enter">
            {loading ? <><Spinner /> Running…</> : <><Play size={14} fill="currentColor" />Run backtest<span className="kbd">Ctrl ↵</span></>}
          </button>
        } />
      </div>
      <div className="pane">
        {error && (
          <div className="alert err" style={{ marginBottom: 14 }}>
            <AlertCircle size={16} style={{ flex: "none", marginTop: 1 }} />
            <div><b>Backtest failed</b><pre>{error}</pre></div>
          </div>
        )}
        {loading && !result ? <LoadingSkeleton /> : result ? (
          <div data-result-id={result.id} style={{ opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}><Results key={result.id} res={result}
            chrome={{ settingsOpen, onToggleSettings: toggleSettings, onRun: run, running: loading }} /></div>
        ) : <Welcome onRun={run} />}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="skeleton" style={{ height: 44, width: "40%", marginBottom: 18 }} />
      <div className="skeleton" style={{ height: 92, marginBottom: 20 }} />
      <div className="skeleton" style={{ height: 460 }} />
    </div>
  );
}

function Welcome({ onRun }: { onRun: () => void }) {
  return (
    <div className="card empty" style={{ minHeight: 520 }}>
      <div>
        <div className="empty-art" style={{ margin: "0 auto" }}><LineChart size={28} strokeWidth={1.6} /></div>
        <h2>Ready when you are</h2>
        <p>Choose a market, a few symbols and a strategy on the left, then run the backtest. Everything else has sensible defaults.</p>
        <button className="btn btn-primary" style={{ marginTop: 22, height: 38, padding: "0 18px" }} onClick={onRun}>Run with current settings</button>
        <div className="feature-list">
          <span><Globe2 size={14} />14 markets or your own CSV</span>
          <span><ShieldCheck size={14} />Realistic costs, no look-ahead</span>
          <span><Layers size={14} />Portfolios up to 50 symbols</span>
        </div>
      </div>
    </div>
  );
}
