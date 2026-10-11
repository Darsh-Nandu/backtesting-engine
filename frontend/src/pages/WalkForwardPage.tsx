import { useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { AlertCircle, Footprints, Play, Square } from "lucide-react";
import { api, Job, pollJob } from "../api";
import { ConfigPanel } from "../components/ConfigPanel";
import { axisStyle, baseOption, EChart, tooltipRow } from "../components/EChart";
import { Card, Field, NumberInput, Toggle } from "../components/ui";
import { compact, date, money, num, pct, tone } from "../format";
import { useApp, usePalette } from "../store";
import { JobProgress, OptSettings, useRanges } from "./OptimizePage";

export function WalkForwardPage() {
  const { config, strategies, toast } = useApp();
  const strat = strategies.find((s) => s.id === config.strategy.id);
  const { ranges, setRanges, combos, payload } = useRanges(strat);
  const [objective, setObjective] = useState("sharpe");
  const [method, setMethod] = useState("grid");
  const [nIter, setNIter] = useState(60);
  const [minTrades, setMinTrades] = useState(3);
  const [splits, setSplits] = useState(5);
  const [trainPct, setTrainPct] = useState(70);
  const [anchored, setAnchored] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef({ cancelled: false });

  const run = async () => {
    setError(null); setResult(null);
    cancel.current = { cancelled: false };
    try {
      const { id } = await api.startWalkForward({
        ...config,
        optimize: { objective, method, n_iter: nIter, min_trades: minTrades, ranges: payload },
        walk_forward: { splits, train_pct: trainPct, anchored },
      });
      const r = await pollJob<any>(id, setJob, cancel.current);
      setResult(r);
      toast("Walk-forward analysis complete");
    } catch (e: any) {
      if (e.message !== "cancelled") setError(e.message);
    } finally { setJob(null); }
  };

  return (
    <div className="bt-layout">
      <div className="config">
        <ConfigPanel hideParams />
        <OptSettings {...{ ranges, setRanges, combos, objective, setObjective, method, setMethod, nIter, setNIter, minTrades, setMinTrades }} />
        <Card title="Walk-forward windows">
          <div className="stack">
            <div className="grid2">
              <Field label="Folds"><NumberInput value={splits} min={2} max={20} step={1} onChange={setSplits} /></Field>
              <Field label="In-sample share"><NumberInput value={trainPct} min={30} max={90} step={5} onChange={setTrainPct} suffix="%" /></Field>
            </div>
            <Toggle checked={anchored} onChange={setAnchored} label="Anchored (expanding training window)" />
          </div>
        </Card>
        {job ? <button className="btn btn-run" onClick={() => (cancel.current.cancelled = true)}><Square size={14} /> Stop watching</button>
          : <button className="btn btn-primary btn-run" onClick={run} disabled={!Object.keys(payload).length}>Run walk-forward</button>}
      </div>
      <div className="pane">
        <JobProgress job={job} label="Optimising each in-sample window, then testing out-of-sample…" />
        {error && <div className="alert err" style={{ marginBottom: 14 }}><AlertCircle size={16} /><div><b>Walk-forward failed</b><pre>{error}</pre></div></div>}
        {result ? <WFResults r={result} currency={result.currency || "USD"} /> : !job && (
          <div className="card empty" style={{ minHeight: 520 }}>
            <div>
              <div className="empty-art" style={{ margin: "0 auto" }}><Footprints size={36} /></div>
              <h2>The honest backtest</h2>
              <p>Walk-forward analysis repeatedly optimises on a training window and then trades the <i>next, unseen</i> window with those parameters. The stitched out-of-sample equity curve is what you could realistically have achieved.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WFResults({ r }: { r: any; currency: string }) {
  const p = usePalette();
  const { config, meta } = useApp();
  const cur = meta?.markets.find((m) => m.code === config.market)?.currency || "USD";
  const o = r.overall;
  const eff = r.efficiency_pct;
  const tiles = [
    { k: "OOS total return", v: pct(o.total_return_pct), c: tone(o.total_return_pct) },
    { k: "OOS CAGR", v: pct(o.cagr_pct), c: tone(o.cagr_pct) },
    { k: "OOS Sharpe", v: num(o.sharpe), c: "" },
    { k: "OOS max drawdown", v: pct(o.max_drawdown_pct), c: "" },
    { k: "WF efficiency", v: eff == null ? "n/a" : eff > 300 ? ">300%" : `${num(eff, 0)}%`, c: eff == null ? "" : eff >= 50 ? "pos" : "neg",
      sub: eff == null ? "No in-sample edge to compare" : "Above 50% is healthy" },
    { k: "Folds profitable", v: `${r.folds.filter((f: any) => (f.oos_metrics?.total_return_pct ?? 0) > 0).length} / ${r.folds.length}`, c: "" },
  ];

  const equityOpt = useMemo<EChartsOption>(() => {
    const t = r.series.t.map((x: number) => x * 1000);
    const series: any[] = [{
      name: "Out-of-sample equity", type: "line", showSymbol: false, data: t.map((x: number, i: number) => [x, r.series.equity[i]]),
      lineStyle: { width: 2, color: p.series[0] }, itemStyle: { color: p.series[0] },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: p.series[0] + "22" }, { offset: 1, color: p.series[0] + "00" }] } },
    }];
    if (r.series.benchmark) series.push({ name: r.benchmark_name, type: "line", showSymbol: false,
      data: t.map((x: number, i: number) => [x, r.series.benchmark[i]]), lineStyle: { width: 1.3, color: p.bench, type: [4, 4] }, itemStyle: { color: p.bench } });
    const marks = r.folds.map((f: any, i: number) => [
      { xAxis: new Date(f.test_start).getTime(), itemStyle: { color: i % 2 ? p.grid + "00" : p.grid + "66" }, name: `F${f.fold}` },
      { xAxis: new Date(f.test_end).getTime() },
    ]);
    series[0].markArea = { silent: true, data: marks, label: { color: p.muted, fontSize: 12, position: "insideTop" } };
    return {
      ...baseOption(p),
      grid: { left: 64, right: 16, top: 24, bottom: 30 },
      tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => `<b>${date(items[0].value[0] / 1000)}</b>` + items.map((it: any) => tooltipRow(it.color, it.seriesName, money(it.value[1], cur))).join("") },
      xAxis: { type: "time", ...axisStyle(p), splitLine: { show: false } },
      yAxis: { type: "value", scale: true, ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: (v: number) => compact(v) } },
      series,
    };
  }, [r, p, cur]);

  const foldOpt = useMemo<EChartsOption>(() => ({
    ...baseOption(p),
    legend: { top: 0, right: 0, textStyle: { color: p.text2, fontSize: 13 }, itemWidth: 10, itemHeight: 10 },
    grid: { left: 48, right: 10, top: 30, bottom: 26 },
    tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow", shadowStyle: { color: p.grid + "80" } }, valueFormatter: (v: any) => num(v, 3) },
    xAxis: { type: "category", data: r.folds.map((f: any) => `Fold ${f.fold}`), ...axisStyle(p), splitLine: { show: false } },
    yAxis: { type: "value", ...axisStyle(p) },
    series: [
      { name: "In-sample", type: "bar", barMaxWidth: 26, data: r.folds.map((f: any) => f.is_score), itemStyle: { color: p.series[6], borderRadius: [4, 4, 0, 0] } },
      { name: "Out-of-sample", type: "bar", barMaxWidth: 26, data: r.folds.map((f: any) => f.oos_score), itemStyle: { color: p.series[0], borderRadius: [4, 4, 0, 0] } },
    ],
  }), [r, p]);

  return (
    <>
      <div className="kpis">
        {tiles.map((t) => <div key={t.k} className="kpi"><div className="kpi-label">{t.k}</div><div className={`kpi-value num ${t.c}`}>{t.v}</div>{t.sub && <div className="kpi-sub">{t.sub}</div>}</div>)}
      </div>
      <Card title="Stitched out-of-sample equity" sub={`${r.folds.length} ${r.anchored ? "anchored" : "rolling"} folds · shaded bands mark each test window`}>
        <EChart option={equityOpt} height={380} />
      </Card>
      <div className="charts-2 mt">
        <Card title={`${r.objective_label}: in-sample vs out-of-sample`} sub="Large drops signal overfitting">
          <EChart option={foldOpt} height={280} />
        </Card>
        <Card title="Window timeline">
          <Timeline folds={r.folds} />
        </Card>
      </div>
      <Card className="mt" title="Fold details" bodyClass="table-wrap">
        <table className="tbl">
          <thead><tr><th>Fold</th><th>Train</th><th>Test</th><th>Chosen parameters</th><th className="r">IS score</th><th className="r">OOS score</th><th className="r">OOS return</th><th className="r">OOS max DD</th><th className="r">OOS trades</th></tr></thead>
          <tbody>{r.folds.map((f: any) => (
            <tr key={f.fold}>
              <td>{f.fold}</td><td className="dim">{date(f.train_start)} → {date(f.train_end)}</td><td>{date(f.test_start)} → {date(f.test_end)}</td>
              <td>{Object.entries(f.best_params).map(([k, v]) => <span key={k} className="pill" style={{ marginRight: 4 }}>{k}={String(v)}</span>)}</td>
              <td className="r">{num(f.is_score, 3)}</td><td className={`r ${tone(f.oos_score)}`}>{num(f.oos_score, 3)}</td>
              <td className={`r ${tone(f.oos_metrics?.total_return_pct)}`}>{pct(f.oos_metrics?.total_return_pct)}</td>
              <td className="r">{pct(f.oos_metrics?.max_drawdown_pct)}</td><td className="r">{f.oos_metrics?.trades ?? "-"}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
    </>
  );
}

function Timeline({ folds }: { folds: any[] }) {
  const t0 = Math.min(...folds.map((f) => new Date(f.train_start).getTime()));
  const t1 = Math.max(...folds.map((f) => new Date(f.test_end).getTime()));
  const x = (d: string) => ((new Date(d).getTime() - t0) / (t1 - t0)) * 100;
  return (
    <div className="stack" style={{ gap: 9, paddingTop: 6 }}>
      {folds.map((f) => (
        <div key={f.fold} className="row" style={{ gap: 10 }}>
          <span className="muted num" style={{ width: 48, fontSize: 13.5 }}>Fold {f.fold}</span>
          <div style={{ position: "relative", flex: 1, height: 18, background: "var(--surface-2)", borderRadius: 5 }}>
            <div title="Training" style={{ position: "absolute", left: `${x(f.train_start)}%`, width: `${x(f.train_end) - x(f.train_start)}%`, top: 0, bottom: 0, background: "color-mix(in srgb, var(--s7) 55%, transparent)", borderRadius: "5px 0 0 5px" }} />
            <div title="Testing" style={{ position: "absolute", left: `${x(f.test_start)}%`, width: `${Math.max(x(f.test_end) - x(f.test_start), 1)}%`, top: 0, bottom: 0, background: "var(--s1)", borderRadius: "0 5px 5px 0" }} />
          </div>
        </div>
      ))}
      <div className="legend" style={{ marginTop: 6 }}>
        <span><i style={{ background: "color-mix(in srgb, var(--s7) 55%, transparent)" }} />In-sample (optimise)</span>
        <span><i style={{ background: "var(--s1)" }} />Out-of-sample (trade)</span>
      </div>
    </div>
  );
}
