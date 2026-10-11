import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { ExternalLink, GitCompare, History, Star, Trash2, X } from "lucide-react";
import { api, BacktestResult, RunSummary } from "../api";
import { axisStyle, baseOption, EChart, tooltipRow } from "../components/EChart";
import { Card, Spinner } from "../components/ui";
import { date, num, pct, relTime, tone } from "../format";
import { useApp, usePalette } from "../store";

export function HistoryPage() {
  const { setResult, go, toast } = useApp();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [compare, setCompare] = useState<BacktestResult[] | null>(null);
  const [loadingCmp, setLoadingCmp] = useState(false);
  const [q, setQ] = useState("");

  const refresh = () => api.runs().then(setRuns).catch(() => setRuns([]));
  useEffect(() => { refresh(); }, []);

  const open = async (id: string) => {
    const r = await api.run(id);
    setResult(r);
    go("backtest");
  };

  const doCompare = async () => {
    setLoadingCmp(true);
    try { setCompare(await Promise.all(sel.map((id) => api.run(id)))); } finally { setLoadingCmp(false); }
  };

  const filtered = (runs || []).filter((r) => !q || `${r.name} ${r.strategy} ${r.symbols.join(" ")} ${r.market}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.starred) - Number(a.starred));

  if (runs === null) return <div className="empty"><Spinner size={22} /></div>;
  if (!runs.length) {
    return <div className="card empty" style={{ minHeight: 460 }}><div>
      <div className="empty-art" style={{ margin: "0 auto" }}><History size={34} /></div>
      <h2>No saved runs yet</h2><p>Every backtest you run is saved automatically so you can reopen and compare them later.</p>
      <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => go("backtest")}>Run a backtest</button>
    </div></div>;
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {compare && <Compare runs={compare} onClose={() => setCompare(null)} />}
      <Card title="Backtest history" sub={`${runs.length} runs · select up to 8 to compare`}
        actions={<>
          <input className="input" style={{ width: 220, height: 30 }} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-sm btn-primary" disabled={sel.length < 2 || loadingCmp} onClick={doCompare}>
            {loadingCmp ? <Spinner size={13} /> : <GitCompare size={14} />}Compare {sel.length || ""}</button>
          {sel.length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setSel([])}>Clear</button>}
        </>}
        bodyClass="table-wrap">
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 30 }} /><th style={{ width: 30 }} /><th>Run</th><th>Market · symbols</th><th>Period</th>
            <th className="r">Return</th><th className="r">CAGR</th><th className="r">Sharpe</th><th className="r">Max DD</th><th className="r">Trades</th><th />
          </tr></thead>
          <tbody>{filtered.map((r) => {
            const s = r.summary;
            return (
              <tr key={r.id} className={sel.includes(r.id) ? "sel" : ""}>
                <td><input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id].slice(-8) : sel.filter((x) => x !== r.id))} /></td>
                <td><button className="btn btn-sm btn-ghost btn-icon" title="Star" onClick={async () => { await api.patchRun(r.id, { starred: !r.starred }); refresh(); }}>
                  <Star size={14} fill={r.starred ? "var(--warn)" : "none"} color={r.starred ? "var(--warn)" : "currentColor"} /></button></td>
                <td>
                  <div style={{ fontWeight: 600, cursor: "text" }} title="Double-click to rename"
                    onDoubleClick={async () => { const n = prompt("Rename run", r.name); if (n) { await api.patchRun(r.id, { name: n }); refresh(); } }}>{r.name}</div>
                  <div className="muted" style={{ fontSize: 13.5 }}>{r.name !== r.strategy ? `${r.strategy} · ` : ""}{relTime(r.created)}</div>
                </td>
                <td style={{ whiteSpace: "normal", minWidth: 160 }}><span className="pill accent">{r.market}</span> <span className="dim">{r.symbols.slice(0, 3).join(", ")}{r.symbols.length > 3 ? ` +${r.symbols.length - 3}` : ""}</span></td>
                <td className="dim">{s.period?.[0] ? `${date(s.period[0])} → ${date(s.period[1])}` : "-"}</td>
                <td className={`r ${tone(s.total_return_pct)}`}><b>{pct(s.total_return_pct)}</b></td>
                <td className={`r ${tone(s.cagr_pct)}`}>{pct(s.cagr_pct)}</td>
                <td className="r">{num(s.sharpe)}</td>
                <td className="r neg">{pct(s.max_drawdown_pct)}</td>
                <td className="r">{s.trades ?? "-"}</td>
                <td className="r" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-sm" onClick={() => open(r.id)}><ExternalLink size={13} />Open</button>{" "}
                  <button className="btn btn-sm btn-icon btn-danger" onClick={async () => {
                    if (!confirm("Delete this run?")) return;
                    await api.deleteRun(r.id); setSel(sel.filter((x) => x !== r.id)); refresh(); toast("Run deleted", "info");
                  }}><Trash2 size={13} /></button>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </Card>
    </div>
  );
}

function Compare({ runs, onClose }: { runs: BacktestResult[]; onClose: () => void }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => ({
    ...baseOption(p),
    legend: { top: 0, left: 0, textStyle: { color: p.text2, fontSize: 13.5 }, itemWidth: 14, itemHeight: 3, icon: "rect" },
    grid: { left: 52, right: 16, top: 34, bottom: 30 },
    tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) =>
      `<b>${date(items[0].value[0] / 1000)}</b>` + items.map((it: any) => tooltipRow(it.color, it.seriesName, num(it.value[1], 1))).join("") },
    xAxis: { type: "time", ...axisStyle(p), splitLine: { show: false } },
    yAxis: { type: "value", scale: true, ...axisStyle(p) },
    dataZoom: [{ type: "inside", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false }],
    series: runs.map((r, i) => {
      const e0 = r.series.equity[0];
      return {
        name: `${i + 1}. ${r.name || r.strategy.name}`, type: "line", showSymbol: false, sampling: "lttb",
        data: r.series.t.map((t, k) => [t * 1000, (r.series.equity[k] / e0) * 100]),
        lineStyle: { width: 1.8, color: p.series[i % 8] }, itemStyle: { color: p.series[i % 8] },
      };
    }) as any,
  }), [runs, p]);
  const keys: [string, string, (v: any) => string][] = [
    ["total_return_pct", "Total return", (v) => pct(v)], ["cagr_pct", "CAGR", (v) => pct(v)], ["sharpe", "Sharpe", (v) => num(v)],
    ["sortino", "Sortino", (v) => num(v)], ["max_drawdown_pct", "Max drawdown", (v) => pct(v)], ["volatility_pct", "Volatility", (v) => pct(v, 2, false)],
    ["calmar", "Calmar", (v) => num(v)], ["trades", "Trades", (v) => num(v, 0)], ["win_rate_pct", "Win rate", (v) => pct(v, 1, false)],
    ["profit_factor", "Profit factor", (v) => num(v)], ["exposure_pct", "Exposure", (v) => pct(v, 1, false)], ["total_fees", "Fees", (v) => num(v, 0)],
  ];
  const best = (k: string) => {
    const vals = runs.map((r) => r.metrics[k]).filter((v) => v != null);
    if (!vals.length || ["trades", "total_fees", "exposure_pct", "volatility_pct"].includes(k)) return null;
    return Math.max(...vals);
  };
  return (
    <Card title="Run comparison" sub="Growth of 100 - each run's equity indexed to 100 at its start"
      actions={<button className="btn btn-sm btn-ghost btn-icon" onClick={onClose}><X size={15} /></button>}>
      <EChart option={option} height={360} />
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead><tr><th>Metric</th>{runs.map((r, i) => <th key={r.id} className="r"><span className="dot" style={{ background: p.series[i % 8], marginRight: 6 }} />{i + 1}. {r.name || r.strategy.name}</th>)}</tr></thead>
          <tbody>{keys.map(([k, l, f]) => {
            const b = best(k);
            return <tr key={k}><td className="dim">{l}</td>{runs.map((r) => (
              <td key={r.id} className="r" style={{ fontWeight: b != null && r.metrics[k] === b ? 700 : 400 }}>{f(r.metrics[k])}{b != null && r.metrics[k] === b ? " ★" : ""}</td>
            ))}</tr>;
          })}</tbody>
        </table>
      </div>
    </Card>
  );
}
