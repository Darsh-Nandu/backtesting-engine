import { useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { AlertCircle, CheckCircle2, Crosshair, Grid3x3, Play, Square, Trophy } from "lucide-react";
import { api, Job, pollJob, StrategyInfo } from "../api";
import { ConfigPanel } from "../components/ConfigPanel";
import { axisStyle, baseOption, EChart } from "../components/EChart";
import { Histogram } from "../components/charts";
import { Card, Field, NumberInput, Progress, Seg, Select, Spinner } from "../components/ui";
import { label, num, pct, tone } from "../format";
import { useApp, usePalette } from "../store";

export interface Range { on: boolean; min: number; max: number; step: number }

export function useRanges(strat: StrategyInfo | undefined) {
  const [ranges, setRanges] = useState<Record<string, Range>>({});
  useEffect(() => {
    if (!strat) return;
    const r: Record<string, Range> = {};
    const keys = Object.keys(strat.params).filter((k) => strat.params[k].type !== "bool" && strat.params[k].type !== "str");
    keys.forEach((k, i) => {
      const s = strat.params[k];
      r[k] = { on: i < 2, min: s.min ?? s.default, max: s.max ?? s.default, step: s.step ?? 1 };
    });
    setRanges(r);
  }, [strat?.id]);
  const combos = useMemo(() => Object.values(ranges).filter((r) => r.on)
    .reduce((acc, r) => acc * Math.max(1, Math.floor((r.max - r.min) / (r.step || 1) + 1e-9) + 1), 1), [ranges]);
  const payload = useMemo(() => Object.fromEntries(Object.entries(ranges).filter(([, r]) => r.on)
    .map(([k, r]) => [k, { min: r.min, max: r.max, step: r.step }])), [ranges]);
  return { ranges, setRanges, combos, payload };
}

export function OptSettings({ ranges, setRanges, combos, objective, setObjective, method, setMethod, nIter, setNIter, minTrades, setMinTrades }: any) {
  const { meta } = useApp();
  return (
    <Card title="Optimisation settings" sub="Choose which parameters to sweep and what to maximise">
      <div className="stack">
        <div className="grid2">
          <Field label="Objective">
            <Select value={objective} onChange={setObjective}>
              {meta?.objectives.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label="Min trades"><NumberInput value={minTrades} min={0} step={1} onChange={setMinTrades} /></Field>
        </div>
        <div className="grid2">
          <Field label="Search">
            <Seg full value={method} onChange={setMethod} options={[{ value: "grid", label: "Grid" }, { value: "random", label: "Random" }]} />
          </Field>
          {method === "random" ? <Field label="Iterations"><NumberInput value={nIter} min={5} step={10} onChange={setNIter} /></Field>
            : <Field label="Combinations"><div className="input num" style={{ display: "flex", alignItems: "center", color: combos > 5000 ? "var(--neg-text)" : undefined }}>{num(combos, 0)}{combos > 5000 ? " (random 5k)" : ""}</div></Field>}
        </div>
        <table className="tbl" style={{ fontSize: 12, tableLayout: "fixed" }}>
          <thead><tr><th style={{ width: 26, padding: "9px 4px" }} /><th style={{ padding: "9px 4px" }}>Parameter</th><th className="r" style={{ width: "22%", padding: "9px 4px" }}>Min</th><th className="r" style={{ width: "22%", padding: "9px 4px" }}>Max</th><th className="r" style={{ width: "20%", padding: "9px 4px" }}>Step</th></tr></thead>
          <tbody>
            {Object.entries(ranges as Record<string, Range>).map(([k, r]) => (
              <tr key={k} style={{ opacity: r.on ? 1 : 0.5 }}>
                <td style={{ padding: "4px" }}><input type="checkbox" checked={r.on} onChange={(e) => setRanges({ ...ranges, [k]: { ...r, on: e.target.checked } })} /></td>
                <td style={{ padding: "4px", overflow: "hidden", textOverflow: "ellipsis" }} title={k}><b>{k}</b></td>
                {(["min", "max", "step"] as const).map((f) => (
                  <td key={f} className="r" style={{ padding: "4px 3px" }}>
                    <input className="input num" style={{ height: 28, width: "100%", textAlign: "right", padding: "0 6px" }} type="number" step="any" value={r[f]} disabled={!r.on}
                      onChange={(e) => setRanges({ ...ranges, [k]: { ...r, [f]: parseFloat(e.target.value) || 0 } })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {Object.keys(ranges).length === 0 && <span className="muted">This strategy has no numeric parameters to optimise.</span>}
      </div>
    </Card>
  );
}

export function JobProgress({ job, label: text }: { job: Job | null; label: string }) {
  if (!job) return null;
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Spinner /><b>{text}</b><span className="muted num" style={{ marginLeft: "auto" }}>{job.progress} / {job.total || "…"} · {job.elapsed}s</span>
      </div>
      <Progress value={job.progress} total={job.total} />
    </div>
  );
}

export function OptimizePage() {
  const { config, setConfig, strategies, toast, go } = useApp();
  const strat = strategies.find((s) => s.id === config.strategy.id);
  const { ranges, setRanges, combos, payload } = useRanges(strat);
  const [objective, setObjective] = useState("sharpe");
  const [method, setMethod] = useState("grid");
  const [nIter, setNIter] = useState(150);
  const [minTrades, setMinTrades] = useState(5);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef({ cancelled: false });

  const run = async () => {
    setError(null); setResult(null);
    cancel.current = { cancelled: false };
    try {
      const { id } = await api.startOptimize({ ...config, optimize: { objective, method, n_iter: nIter, min_trades: minTrades, ranges: payload } });
      const r = await pollJob<any>(id, setJob, cancel.current);
      setResult(r);
      toast(`Optimisation done · ${r.n_combos} combinations`);
    } catch (e: any) {
      if (e.message !== "cancelled") setError(e.message);
    } finally { setJob(null); }
  };

  const apply = (params: Record<string, any>) => {
    setConfig((c) => ({ ...c, strategy: { ...c.strategy, params: { ...c.strategy.params, ...params } } }));
    toast("Parameters applied to the backtest configuration", "info");
    go("backtest");
  };

  return (
    <div className="bt-layout">
      <div className="config">
        <ConfigPanel />
        <OptSettings {...{ ranges, setRanges, combos, objective, setObjective, method, setMethod, nIter, setNIter, minTrades, setMinTrades }} />
        {job ? (
          <button className="btn btn-run" onClick={() => (cancel.current.cancelled = true)}><Square size={14} /> Stop watching</button>
        ) : (
          <button className="btn btn-primary btn-run" onClick={run} disabled={!Object.keys(payload).length}>Optimise {num(method === "random" ? Math.min(nIter, combos) : Math.min(combos, 5000), 0)} combinations</button>
        )}
      </div>
      <div className="pane">
        <JobProgress job={job} label="Running parameter sweep in parallel…" />
        {error && <div className="alert err" style={{ marginBottom: 14 }}><AlertCircle size={16} /><div><b>Optimisation failed</b><pre>{error}</pre></div></div>}
        {result ? <OptResults r={result} onApply={apply} /> : !job && (
          <div className="card empty" style={{ minHeight: 520 }}>
            <div>
              <div className="empty-art" style={{ margin: "0 auto" }}><Grid3x3 size={36} /></div>
              <h2>Find robust parameters</h2>
              <p>Sweep up to 5,000 parameter combinations in parallel across all CPU cores. Look for broad plateaus of good performance in the heatmap - not a single lucky peak.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OptResults({ r, onApply }: { r: any; onApply: (p: Record<string, any>) => void }) {
  const best = r.best;
  const valid = r.results.filter((x: any) => x.metrics);
  const [sortKey, setSortKey] = useState<string>("score");
  const rows = useMemo(() => [...valid].sort((a: any, b: any) => {
    const av = sortKey === "score" ? a.score : a.metrics[sortKey], bv = sortKey === "score" ? b.score : b.metrics[sortKey];
    return (bv ?? -Infinity) - (av ?? -Infinity);
  }).slice(0, 200), [valid, sortKey]);
  const cols = ["total_return_pct", "cagr_pct", "sharpe", "sortino", "max_drawdown_pct", "trades", "win_rate_pct", "profit_factor"];

  const hist = useMemo(() => {
    const s: number[] = r.score_distribution || [];
    if (s.length < 3) return null;
    const lo = Math.min(...s), hi = Math.max(...s), bins = 30, w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    s.forEach((v) => counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++);
    return { counts, edges: Array.from({ length: bins + 1 }, (_, i) => lo + i * w) };
  }, [r]);

  return (
    <>
      {best ? (
        <div className="card hero">
          <div className="grade"><Trophy size={20} strokeWidth={1.8} /></div>
          <div>
            <div className="hero-title">Best: {r.objective_label} = {num(best.score, 3)}</div>
            <div className="hero-meta">
              {Object.entries(best.params).map(([k, v]) => <span key={k} className="pill">{k} = {String(v)}</span>)}
              <span className="pill">Return {pct(best.metrics.total_return_pct)}</span>
              <span className="pill">Max DD {pct(best.metrics.max_drawdown_pct)}</span>
              <span className="pill">{best.metrics.trades} trades</span>
              {r.stability_pct != null && <span className="pill" title="Share of tested combos in the top quartile">Top-quartile share {r.stability_pct}%</span>}
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => onApply(best.params)}>Apply & backtest</button>
        </div>
      ) : <div className="alert warn" style={{ marginBottom: 16 }}>No combination met the minimum-trades constraint.</div>}
      {r.warnings?.length > 0 && <div className="alert warn" style={{ marginBottom: 16 }}>{r.warnings.join("; ")}</div>}
      <div className={r.heatmap ? "charts-2" : ""}>
        {r.heatmap && (
          <Card title={`${r.objective_label} heatmap`}
            sub={`${r.heatmap.y} (rows) × ${r.heatmap.x} (columns) · best over other params · click a cell to apply`}>
            <OptHeatmap h={r.heatmap} label={r.objective_label} onPick={(x, y) => onApply({ [r.heatmap.x]: x, [r.heatmap.y]: y })} />
          </Card>
        )}
        <Card title="Score distribution" sub="A narrow, high distribution means performance is robust to parameter choice">
          {hist ? <Histogram counts={hist.counts} edges={hist.edges} unit="" height={360} neutral markers={best ? [{ value: best.score, label: "best" }] : []} /> : <span className="muted">Not enough results</span>}
        </Card>
      </div>
      <Card className="mt" title="All results" sub={`Top ${rows.length} of ${r.n_combos} · click column to sort · click row to apply`} bodyClass="table-wrap">
        <table className="tbl">
          <thead><tr>
            <th>#</th>{r.varied.map((k: string) => <th key={k}>{k}</th>)}
            <th className="r" onClick={() => setSortKey("score")}>Score{sortKey === "score" ? " ↓" : ""}</th>
            {cols.map((c) => <th key={c} className="r" onClick={() => setSortKey(c)}>{label(c)}{sortKey === c ? " ↓" : ""}</th>)}
            <th />
          </tr></thead>
          <tbody>{rows.map((x: any, i: number) => (
            <tr key={i} style={{ cursor: "pointer" }} onClick={() => onApply(x.params)}>
              <td className="muted">{i + 1}</td>
              {r.varied.map((k: string) => <td key={k}>{String(x.params[k])}</td>)}
              <td className="r">{Number.isFinite(x.score) ? num(x.score, 3) : "-"}</td>
              {cols.map((c) => <td key={c} className={`r ${["total_return_pct", "cagr_pct"].includes(c) ? tone(x.metrics[c]) : ""}`}>
                {c.endsWith("_pct") ? pct(x.metrics[c], 2, c !== "win_rate_pct" && c !== "max_drawdown_pct") : num(x.metrics[c], c === "trades" ? 0 : 3)}</td>)}
              <td />
            </tr>
          ))}</tbody>
        </table>
      </Card>
    </>
  );
}

function OptHeatmap({ h, label: lbl, onPick }: { h: any; label: string; onPick: (x: number, y: number) => void }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const data: [number, number, number | null][] = [];
    h.z.forEach((row: (number | null)[], yi: number) => row.forEach((v, xi) => data.push([xi, yi, v])));
    const vals = data.map((d) => d[2]).filter((v): v is number => v != null);
    const isLight = document.documentElement.dataset.theme === "light";
    return {
      ...baseOption(p),
      grid: { left: 56, right: 70, top: 10, bottom: 46 },
      tooltip: { ...(baseOption(p).tooltip as any), trigger: "item",
        formatter: (it: any) => `${h.x} = <b>${h.xs[it.value[0]]}</b><br/>${h.y} = <b>${h.ys[it.value[1]]}</b><br/>${lbl}: <b>${it.value[2] == null ? "-" : num(it.value[2], 3)}</b>` },
      xAxis: { type: "category", data: h.xs.map(String), name: h.x, nameLocation: "middle", nameGap: 28, nameTextStyle: { color: p.muted }, ...axisStyle(p), splitLine: { show: false } },
      yAxis: { type: "category", data: h.ys.map(String), name: h.y, nameLocation: "middle", nameGap: 40, nameTextStyle: { color: p.muted }, ...axisStyle(p), splitLine: { show: false } },
      visualMap: {
        min: Math.min(...vals), max: Math.max(...vals), calculable: true, orient: "vertical", right: 0, top: "center", itemHeight: 220,
        textStyle: { color: p.muted, fontSize: 10 }, formatter: (v: any) => num(v, 2),
        inRange: { color: isLight ? ["#eef3fa", "#d3e2f5", "#a6c4ec", "#6a9ddc", "#3570c2"] : ["#1d222b", "#22324a", "#2d4b74", "#4776b3", "#8fb6ea"] },
      },
      series: [{ type: "heatmap", data, itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: h.xs.length * h.ys.length <= 120, fontSize: 9.5, color: p.text, textBorderColor: p.surface, textBorderWidth: 2, formatter: (it: any) => it.value[2] == null ? "" : num(it.value[2], 2) },
        emphasis: { itemStyle: { borderColor: p.text, borderWidth: 1.5 } } }],
    };
  }, [h, p, lbl]);
  return <EChart option={option} height={360} onClick={(e: any) => onPick(h.xs[e.value[0]], h.ys[e.value[1]])} />;
}
