// The Analysis view of the Analyze workspace: a quant dashboard for the current CSV dataset.
import { ReactNode, useEffect, useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import type { EChartsOption } from "echarts";
import { axisStyle, baseOption, EChart, tooltipRow } from "../components/EChart";
import { usePalette } from "../store";
import { chartApi, Dataset } from "./api";
import {
  acf, alignCloses, averageBy, beta, computeStats, corr, drawdowns, drawdownTable, histogram, normalPdf,
  periodReturns, periodsPerYear, qqPoints, returns, rollMean, rolling, rollStd, Stats, volumeProfile,
} from "./analysis";
import type { Bars } from "./types";
import { isDaily } from "./types";

type Period = "1Y" | "3Y" | "5Y" | "10Y" | "All";
type RollMetric = "vol" | "sharpe" | "ret" | "beta" | "corr";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PEER_COLORS = ["#2962ff", "#ff9800", "#9c27b0", "#00bcd4", "#e91e63", "#795548", "#4caf50"];

const f = (v: number | null | undefined, d = 2, suf = "") => (v == null || !Number.isFinite(v) ? "-" : `${v.toFixed(d)}${suf}`);
const fs = (v: number | null | undefined, d = 2, suf = "%") => (v == null || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${suf}`);
const tone = (v?: number | null) => (v == null || !Number.isFinite(v) || v === 0 ? "" : v > 0 ? "up" : "down");
const dstr = (t: number, daily: boolean) => { const d = new Date(t * 1000); return daily ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace("T", " "); };

function slicePeriod(b: Bars, p: Period): Bars {
  if (p === "All" || !b.t.length) return b;
  const yrs = p === "1Y" ? 1 : p === "3Y" ? 3 : p === "5Y" ? 5 : 10;
  const from = b.t[b.t.length - 1] - yrs * 31557600;
  const i = Math.max(0, b.t.findIndex((t) => t >= from));
  return { ...b, t: b.t.slice(i), o: b.o.slice(i), h: b.h.slice(i), l: b.l.slice(i), c: b.c.slice(i), v: b.v.slice(i) };
}

function Card({ title, sub, actions, children, className = "" }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`an-card ${className}`}>
      <header><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>{actions && <div className="an-actions">{actions}</div>}</header>
      <div className="an-body">{children}</div>
    </section>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return <div className="an-seg">{options.map((o) => <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.l}</button>)}</div>;
}

export function AnalysisView({ symbol, label, chartBars, datasets, compare, shift }: {
  symbol: string; label: string; chartBars: Bars | null; datasets: Dataset[]; compare: string[]; shift: (t: number) => number;
}) {
  const p = usePalette();
  const [dataset, setDataset] = useState<"daily" | "chart">("daily");
  const [period, setPeriod] = useState<Period>("5Y");
  const [benchSym, setBenchSym] = useState("");
  const [peers, setPeers] = useState<string[]>(() => compare.slice(0, 5));
  const [win, setWin] = useState(63);
  const [metric, setMetric] = useState<RollMetric>("vol");
  const [logScale, setLogScale] = useState(false);
  const [daily, setDaily] = useState<Bars | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [others, setOthers] = useState<Record<string, Bars | "error">>({});

  // Benchmark and peers are other uploaded datasets.
  const others_ = datasets.map((d) => `CSV:${d.name}`).filter((x) => x.toUpperCase() !== symbol.toUpperCase());
  const bench = benchSym;
  const nice = (x: string) => x.replace(/^CSV:/i, "");
  const bn = bench ? nice(bench) : "benchmark";
  const useChart = dataset === "chart" && chartBars && !isDaily(chartBars.interval);
  const iv = useChart ? chartBars!.interval : "1D";

  useEffect(() => {
    let off = false;
    setDaily(null); setErr(null);
    chartApi.bars(symbol, "1D").then((b) => { if (!off) setDaily(b); }).catch((e) => { if (!off) setErr(e.message || String(e)); });
    return () => { off = true; };
  }, [symbol]);

  // Benchmark and peers at the same interval as the dataset being analysed.
  const wanted = useMemo(() => [...new Set([bench, ...peers].filter((x) => x && x !== symbol))], [bench, peers, symbol]);
  useEffect(() => {
    let off = false;
    wanted.forEach((sym) => {
      const key = `${sym}|${iv}`;
      if (others[key]) return;
      chartApi.bars(sym, iv as any).then((b) => { if (!off) setOthers((m) => ({ ...m, [key]: b })); })
        .catch(() => { if (!off) setOthers((m) => ({ ...m, [key]: "error" })); });
    });
    return () => { off = true; };
  }, [wanted.join(","), iv]); // eslint-disable-line react-hooks/exhaustive-deps

  const full = useChart ? chartBars : daily;
  const base = useMemo(() => (full ? slicePeriod(full, useChart ? "All" : period) : null), [full, period, useChart]);
  const dailyData = !useChart;
  const ppy = base ? periodsPerYear(base) : 252;
  const st: Stats | null = useMemo(() => (base && base.c.length > 5 ? computeStats(base, ppy) : null), [base, ppy]);
  const r = useMemo(() => (base ? returns(base.c) : []), [base]);
  const benchBars = others[`${bench}|${iv}`];
  const benchAligned = useMemo(() => {
    if (!base || !benchBars || benchBars === "error") return null;
    const a = alignCloses([base, benchBars], dailyData);
    return a.t.length > 10 ? a : null;
  }, [base, benchBars, dailyData]);
  const benchStats = useMemo(() => {
    if (!benchAligned) return null;
    const ra = returns(benchAligned.closes[0]), rb = returns(benchAligned.closes[1]);
    const b = beta(ra, rb), m = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    return { beta: b, corr: corr(ra, rb), alpha: b == null ? null : (m(ra) - b * m(rb)) * ppy * 100, ra, rb };
  }, [benchAligned, ppy]);

  if (err) return <div className="an-root"><div className="an-empty"><b>Couldn't load {label}</b><p>{err}</p></div></div>;
  if (!base || !st) return <div className="an-root"><div className="an-empty"><div className="ct-spinner" /><p>Loading {label}…</p></div></div>;

  const intraday = !dailyData;
  const ddSeries = drawdowns(base.c);

  // ---------------------------------------------------------------- charts
  const ax = axisStyle(p);
  const priceOpt: EChartsOption = (() => {
    const series: any[] = [
      { name: label, type: "line", showSymbol: false, sampling: "lttb", data: base.t.map((t, i) => [t * 1000, base.c[i]]), lineStyle: { width: 2, color: p.series[0] }, itemStyle: { color: p.series[0] }, xAxisIndex: 0, yAxisIndex: 0 },
      { name: "Drawdown", type: "line", showSymbol: false, sampling: "lttb", data: base.t.map((t, i) => [t * 1000, ddSeries[i]]), lineStyle: { width: 1.2, color: p.neg }, areaStyle: { color: p.neg + "30" }, itemStyle: { color: p.neg }, xAxisIndex: 1, yAxisIndex: 1 },
    ];
    if (benchAligned) {
      const k = base.c[0] / benchAligned.closes[1][0];
      series.push({ name: bn, type: "line", showSymbol: false, sampling: "lttb", data: benchAligned.t.map((t, i) => [t * 1000, benchAligned.closes[1][i] * k]), lineStyle: { width: 1.4, color: p.bench, type: [5, 4] }, itemStyle: { color: p.bench }, xAxisIndex: 0, yAxisIndex: 0 });
    }
    return {
      ...baseOption(p), animation: false, axisPointer: { link: [{ xAxisIndex: "all" }] },
      legend: { top: 0, right: 0, textStyle: { color: p.text2, fontSize: 12.5 }, itemWidth: 14, itemHeight: 3, icon: "rect", data: [label, ...(benchAligned ? [bn] : []), "Drawdown"] },
      grid: [{ left: 64, right: 14, top: 26, height: "58%" }, { left: 64, right: 14, top: "74%", bottom: 26 }],
      tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => `<b>${dstr(items[0].value[0] / 1000, !intraday)}</b>` + items.map((it: any) => tooltipRow(it.color, it.seriesName, it.seriesName === "Drawdown" ? f(it.value[1], 2, "%") : f(it.value[1]))).join("") },
      xAxis: [{ type: "time", gridIndex: 0, ...ax, axisLabel: { show: false }, splitLine: { show: false } }, { type: "time", gridIndex: 1, ...ax, splitLine: { show: false } }],
      yAxis: [{ type: logScale ? "log" : "value", scale: true, gridIndex: 0, ...ax }, { type: "value", gridIndex: 1, max: 0, ...ax, splitNumber: 2, axisLabel: { ...ax.axisLabel, formatter: "{value}%" } }],
      dataZoom: [{ type: "inside", xAxisIndex: [0, 1], zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false }],
      series,
    };
  })();

  const hist = histogram(r.map((x) => x * 100), 60);
  const m = r.reduce((s, x) => s + x, 0) / r.length * 100, sd = Math.sqrt(r.reduce((s, x) => s + (x * 100 - m) ** 2, 0) / (r.length - 1));
  const distOpt: EChartsOption = {
    ...baseOption(p), grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    legend: { top: 0, right: 0, textStyle: { color: p.text2, fontSize: 12.5 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => `<b>${f(+items[0].axisValue, 2, "%")}</b>` + items.map((it: any) => tooltipRow(it.color, it.seriesName, it.seriesName === "Normal" ? f(it.value, 1) : String(it.value))).join("") },
    xAxis: { type: "category", data: hist.centers.map((c) => c.toFixed(2)), ...ax, axisLabel: { ...ax.axisLabel, formatter: (v: string) => `${(+v).toFixed(1)}%` } },
    yAxis: { type: "value", ...ax },
    series: [
      { name: "Bars", type: "bar", barCategoryGap: "8%", data: hist.counts.map((c, i) => ({ value: c, itemStyle: { color: hist.centers[i] < 0 ? p.neg + "bb" : p.pos + "bb" } })),
        markLine: { symbol: "none", silent: true, label: { color: p.text2, fontSize: 11, formatter: "{b}" }, lineStyle: { color: p.text2, type: "dashed" },
          data: [{ name: `VaR 95% ${f(st.var95)}%`, xAxis: hist.centers.findIndex((c) => c >= st.var95).toString() }] } },
      { name: "Normal", type: "line", smooth: true, showSymbol: false, data: hist.centers.map((c) => normalPdf(c, m, sd) * r.length * hist.w), lineStyle: { color: p.accent, width: 2 }, itemStyle: { color: p.accent } },
    ] as any,
  };

  const qq = qqPoints(r);
  const qqOpt: EChartsOption = {
    ...baseOption(p), grid: { left: 8, right: 14, top: 14, bottom: 28, containLabel: true },
    tooltip: { ...(baseOption(p).tooltip as any), trigger: "item", formatter: (it: any) => `Normal ${f(it.value[0])}σ<br/>Actual <b>${f(it.value[1])}σ</b>` },
    xAxis: { type: "value", name: "Normal quantile", nameLocation: "middle", nameGap: 24, nameTextStyle: { color: p.muted }, ...ax, min: -4, max: 4 },
    yAxis: { type: "value", ...ax, scale: true },
    series: [
      { type: "scatter", symbolSize: 4, data: qq, itemStyle: { color: p.series[0], opacity: 0.7 } },
      { type: "line", data: [[-4, -4], [4, 4]], showSymbol: false, lineStyle: { color: p.bench, type: "dashed" }, silent: true },
    ] as any,
  };

  // Seasonality
  const monthKey = (t: number) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; };
  const monthly = periodReturns(base.t, base.c, monthKey);
  const yearly = periodReturns(base.t, base.c, (t) => String(new Date(t * 1000).getUTCFullYear()));
  const years = [...new Set([...monthly.keys()].map((k) => +k.split("-")[0]))].sort((a, b) => b - a);
  const byMonth = MONTHS.map((_, mo) => { const v = [...monthly.entries()].filter(([k]) => +k.split("-")[1] === mo).map(([, x]) => x); return { mean: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null, pos: v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : null, n: v.length }; });
  const local = (t: number) => new Date(shift(t) * 1000);
  const byWeekday = averageBy(base.t, base.c, (t) => (intraday ? local(t) : new Date(t * 1000)).getUTCDay(), 7);
  const byHour = intraday ? averageBy(base.t, base.c, (t) => local(t).getUTCHours(), 24) : null;
  const maxAbsMonth = Math.max(1, ...[...monthly.values()].map(Math.abs).sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(monthly.size * 0.95))));
  const heat = (v: number | undefined, scale = maxAbsMonth) => v == null ? "transparent" : `color-mix(in srgb, ${v >= 0 ? "var(--ct-up)" : "var(--ct-down)"} ${Math.round(8 + Math.min(Math.abs(v) / scale, 1) * 52)}%, transparent)`;

  const barOpt = (labels: string[], rows: { mean: number | null; pctPos?: number | null; pos?: number | null; n: number }[], title: string): EChartsOption => ({
    ...baseOption(p), grid: { left: 8, right: 8, top: 26, bottom: 8, containLabel: true },
    legend: { top: 0, right: 0, textStyle: { color: p.text2, fontSize: 12 }, itemWidth: 12, itemHeight: 8 },
    tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow" }, formatter: (items: any) => { const i = items[0].dataIndex, row = rows[i]; return `<b>${labels[i]}</b>` + tooltipRow(p.series[0], title, fs(row.mean, 3)) + tooltipRow(p.accent, "Positive", f(row.pctPos ?? row.pos, 0, "%")) + tooltipRow(p.muted, "Samples", String(row.n)); } },
    xAxis: { type: "category", data: labels, ...ax },
    yAxis: [{ type: "value", ...ax, axisLabel: { ...ax.axisLabel, formatter: (v: number) => `${v.toFixed(2)}%` } }, { type: "value", min: 0, max: 100, ...ax, splitLine: { show: false }, axisLabel: { ...ax.axisLabel, formatter: "{value}%" } }],
    series: [
      { name: title, type: "bar", data: rows.map((x) => ({ value: x.mean == null ? null : +x.mean.toFixed(4), itemStyle: { color: (x.mean ?? 0) >= 0 ? p.pos : p.neg, borderRadius: 3 } })) },
      { name: "% positive", type: "line", yAxisIndex: 1, data: rows.map((x) => x.pctPos ?? x.pos), showSymbol: true, symbolSize: 5, lineStyle: { color: p.accent, width: 1.5 }, itemStyle: { color: p.accent } },
    ] as any,
  });

  // Rolling
  const rollOpt: EChartsOption = (() => {
    let vals: (number | null)[] = [], t = base.t.slice(1), name = "";
    if (metric === "vol") { vals = rolling(r, win, rollStd).map((v) => (v == null ? null : v * Math.sqrt(ppy) * 100)); name = "Volatility %"; }
    if (metric === "sharpe") { vals = r.map((_, i) => (i + 1 >= win ? (() => { const a = r.slice(i + 1 - win, i + 1), s = rollStd(a); return s ? (rollMean(a) / s) * Math.sqrt(ppy) : null; })() : null)); name = "Sharpe"; }
    if (metric === "ret") { vals = base.c.slice(1).map((c, i) => (i + 1 >= win ? (c / base.c[i + 1 - win] - 1) * 100 : null)); name = `${win}-bar return %`; }
    if ((metric === "beta" || metric === "corr") && benchStats && benchAligned) {
      t = benchAligned.t.slice(1);
      vals = benchStats.ra.map((_, i) => (i + 1 >= win ? (metric === "beta" ? beta : corr)(benchStats.ra.slice(i + 1 - win, i + 1), benchStats.rb.slice(i + 1 - win, i + 1)) : null));
      name = metric === "beta" ? `Beta vs ${bn}` : `Correlation vs ${bn}`;
    }
    return {
      ...baseOption(p), animation: false, grid: { left: 8, right: 14, top: 14, bottom: 8, containLabel: true },
      tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => `<b>${dstr(items[0].value[0] / 1000, !intraday)}</b>` + tooltipRow(p.series[0], name, f(items[0].value[1])) },
      xAxis: { type: "time", ...ax, splitLine: { show: false } }, yAxis: { type: "value", scale: true, ...ax },
      dataZoom: [{ type: "inside", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false }],
      series: [{ name, type: "line", showSymbol: false, sampling: "lttb", data: t.map((x, i) => [x * 1000, vals[i] == null ? null : +(vals[i] as number).toFixed(4)]), lineStyle: { color: p.series[0], width: 1.6 }, areaStyle: metric === "ret" ? { color: p.series[0] + "20" } : undefined,
        markLine: metric === "ret" || metric === "sharpe" || metric === "corr" ? { symbol: "none", silent: true, data: [{ yAxis: 0 }], lineStyle: { color: p.muted, type: "dashed" }, label: { show: false } } : undefined }] as any,
    };
  })();

  const ac = acf(r, 30), band = 1.96 / Math.sqrt(r.length);
  const acfOpt: EChartsOption = {
    ...baseOption(p), grid: { left: 8, right: 14, top: 14, bottom: 8, containLabel: true },
    tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow" }, formatter: (items: any) => `Lag <b>${items[0].axisValue}</b>: ${f(items[0].value, 3)} (95% band ±${f(band, 3)})` },
    xAxis: { type: "category", data: ac.map((_, i) => String(i + 1)), ...ax }, yAxis: { type: "value", ...ax, min: +(-Math.max(band * 1.4, ...ac.map(Math.abs))).toFixed(3), max: +Math.max(band * 1.4, ...ac.map(Math.abs)).toFixed(3) },
    series: [
      { type: "bar", data: ac.map((v) => ({ value: +v.toFixed(4), itemStyle: { color: Math.abs(v) > band ? p.series[0] : p.series[0] + "55", borderRadius: 2 } })) },
      ...[band, -band].map((y) => ({ type: "line", data: ac.map(() => +y.toFixed(4)), showSymbol: false, silent: true, lineStyle: { color: p.neg, type: "dashed", width: 1 }, tooltip: { show: false } })),
    ] as any,
  };

  const vp = volumeProfile(base, 0, base.c.length - 1, 30, 70);
  const vpOpt: EChartsOption = {
    ...baseOption(p), grid: { left: 8, right: 18, top: 10, bottom: 8, containLabel: true },
    tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow" }, formatter: (items: any) => { const row = vp.rows[items[0].dataIndex]; return `<b>${f(row.lo)} - ${f(row.hi)}</b>` + tooltipRow(p.pos, "Up volume", (row.up / 1e6).toFixed(2) + "M") + tooltipRow(p.neg, "Down volume", (row.down / 1e6).toFixed(2) + "M"); } },
    yAxis: { type: "category", data: vp.rows.map((x) => f((x.lo + x.hi) / 2)), ...ax, axisLabel: { ...ax.axisLabel, fontSize: 11 } },
    xAxis: { type: "value", ...ax, axisLabel: { ...ax.axisLabel, formatter: (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(0)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v)) } },
    series: [
      { name: "Up", type: "bar", stack: "v", data: vp.rows.map((x, k) => ({ value: Math.round(x.up), itemStyle: { color: k >= vp.vaLo && k <= vp.vaHi ? p.pos : p.pos + "66" } })) },
      { name: "Down", type: "bar", stack: "v", data: vp.rows.map((x, k) => ({ value: Math.round(x.down), itemStyle: { color: k === vp.poc ? p.accent : k >= vp.vaLo && k <= vp.vaHi ? p.neg : p.neg + "66" } })) },
    ] as any,
  };

  // Peers
  const peerSeries = [{ sym: symbol, label, bars: base }, ...wanted.map((sym) => ({ sym, label: nice(sym), bars: others[`${sym}|${iv}`] }))]
    .filter((x) => x.bars && x.bars !== "error") as { sym: string; label: string; bars: Bars }[];
  const aligned = peerSeries.length > 1 ? alignCloses(peerSeries.map((x) => slicePeriod(x.bars, useChart ? "All" : period)), dailyData) : null;
  const peerRets = aligned ? aligned.closes.map(returns) : [];
  const perfOpt: EChartsOption | null = aligned && aligned.t.length > 2 ? {
    ...baseOption(p), animation: false, grid: { left: 8, right: 14, top: 30, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, textStyle: { color: p.text2, fontSize: 12.5 }, itemWidth: 14, itemHeight: 3, icon: "rect" },
    tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => `<b>${dstr(items[0].value[0] / 1000, !intraday)}</b>` + items.sort((a: any, b: any) => b.value[1] - a.value[1]).map((it: any) => tooltipRow(it.color, it.seriesName, f(it.value[1], 1))).join("") },
    xAxis: { type: "time", ...ax, splitLine: { show: false } }, yAxis: { type: "value", scale: true, ...ax },
    dataZoom: [{ type: "inside", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false }],
    series: aligned.closes.map((cl, k) => ({ name: peerSeries[k].label, type: "line", showSymbol: false, sampling: "lttb", data: aligned.t.map((t, i) => [t * 1000, +((cl[i] / cl[0]) * 100).toFixed(3)]), lineStyle: { width: k ? 1.6 : 2.4, color: PEER_COLORS[k % PEER_COLORS.length] }, itemStyle: { color: PEER_COLORS[k % PEER_COLORS.length] } })) as any,
  } : null;

  const dds = drawdownTable(base.t, base.c, 8);
  const missing = wanted.filter((sym) => others[`${sym}|${iv}`] === "error");

  const exportCsv = () => {
    const rows: [string, string][] = [
      ["Symbol", label], ["Dataset", useChart ? `${chartBars!.interval} bars` : `daily, ${period}`], ["From", dstr(base.t[0], !intraday)], ["To", dstr(base.t[base.t.length - 1], !intraday)],
      ...Object.entries(st).map(([k, v]) => [k, typeof v === "number" ? String(+v.toFixed(6)) : String(v)] as [string, string]),
      ["beta", String(benchStats?.beta ?? "")], ["correlation", String(benchStats?.corr ?? "")], ["benchmark", bench ? bn : "none"],
    ];
    const blob = new Blob([rows.map((r) => r.map((x) => `"${x}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${label.replace(/[^A-Z0-9.-]/gi, "_")}_analysis.csv`; a.click();
  };

  const kpis: [string, string, string][] = [
    ["Total return", fs(st.total), tone(st.total)], ["CAGR", fs(st.cagr), tone(st.cagr)], ["Volatility (ann.)", f(st.vol, 1, "%"), ""],
    ["Sharpe", f(st.sharpe), ""], ["Sortino", f(st.sortino), ""], ["Max drawdown", f(st.maxDd, 1, "%"), "down"],
    [bench ? `Beta vs ${bn}` : "Beta (pick a benchmark)", f(benchStats?.beta), ""], ["Hurst exponent", f(st.hurst), ""],
  ];
  const statRows: [string, string, string?][] = [
    ["Period", `${dstr(base.t[0], !intraday)} → ${dstr(base.t[base.t.length - 1], !intraday)}`], ["Bars", `${st.bars.toLocaleString()} (${f(st.years, 1)} years)`],
    ["Last / first", `${f(st.last)} / ${f(st.first)}`], ["High / low", `${f(st.high)} / ${f(st.low)}`], ["From period high", fs(st.fromHigh), tone(st.fromHigh)],
    ["Best / worst bar", `${fs(st.best)} / ${fs(st.worst)}`], ["Positive bars", f(st.pctPos, 1, "%")], ["Avg up / avg down", `${fs(st.avgUp, 3)} / ${fs(st.avgDown, 3)}`],
    ["Payoff (avg up ÷ avg down)", f(st.payoff)], ["Longest up / down streak", `${st.maxUpStreak} / ${st.maxDownStreak} bars`],
    ["Calmar", f(st.calmar)], ["Ulcer index", f(st.ulcer)], ["Skewness", f(st.skew)], ["Excess kurtosis", f(st.kurt)],
    ["VaR 95% (1 bar)", f(st.var95, 2, "%")], ["CVaR 95% (1 bar)", f(st.cvar95, 2, "%")], ["Lag-1 autocorrelation", f(st.acf1, 3)],
    ["Mean-reversion half-life", st.halfLife == null ? "None (trending)" : `${f(st.halfLife, 0)} bars`],
    [`Correlation vs ${bn}`, f(benchStats?.corr)], [`Alpha vs ${bn} (ann.)`, fs(benchStats?.alpha)], ["Avg volume per bar", st.avgVol >= 1e6 ? `${(st.avgVol / 1e6).toFixed(2)}M` : st.avgVol.toFixed(0)],
  ];
  const hurstNote = st.hurst == null ? "" : st.hurst > 0.55 ? "trending" : st.hurst < 0.45 ? "mean-reverting" : "close to a random walk";

  return (
    <div className="an-root">
      <div className="an-head">
        <div className="an-title"><h2>{label}</h2><span>{useChart ? `${chartBars!.interval} bars from the chart` : "Daily history"} · your CSV</span></div>
        <div className="an-controls">
          <label>Data</label>
          <Seg value={dataset} onChange={setDataset} options={[{ v: "daily", l: "Daily history" }, ...(chartBars && !isDaily(chartBars.interval) ? [{ v: "chart" as const, l: `Chart (${chartBars.interval})` }] : [])]} />
          {!useChart && <><label>Period</label><Seg value={period} onChange={setPeriod} options={(["1Y", "3Y", "5Y", "10Y", "All"] as Period[]).map((x) => ({ v: x, l: x }))} /></>}
          <label>Benchmark</label>
          <select className="an-input" value={bench} onChange={(e) => setBenchSym(e.target.value)} aria-label="Benchmark" title="Another uploaded dataset to compare against">
            <option value="">None</option>
            {others_.map((x) => <option key={x} value={x}>{nice(x)}</option>)}
          </select>
          <button className="ct-btn" onClick={exportCsv} title="Download the statistics as CSV"><Download size={15} style={{ verticalAlign: -3, marginRight: 6 }} />Export</button>
        </div>
      </div>

      <div className="an-kpis">
        {kpis.map(([k, v, c]) => <div key={k} className="an-kpi"><span>{k}</span><b className={c}>{v}</b></div>)}
      </div>

      <div className="an-grid g21">
        <Card title="Price and drawdown" sub={benchAligned ? `Rebased ${bn} dashed · Ctrl + scroll to zoom` : "Ctrl + scroll to zoom"}
          actions={<Seg value={logScale ? "log" : "lin"} onChange={(v) => setLogScale(v === "log")} options={[{ v: "lin", l: "Linear" }, { v: "log", l: "Log" }]} />}>
          <EChart option={priceOpt} height={360} />
        </Card>
        <Card title="Statistics" sub={hurstNote ? `Hurst ${f(st.hurst)}: ${hurstNote}` : undefined}>
          <div className="an-stats">{statRows.map(([k, v, c]) => <div key={k}><span>{k}</span><b className={c}>{v}</b></div>)}</div>
        </Card>
      </div>

      <div className="an-grid g11">
        <Card title="Return distribution" sub={`${r.length.toLocaleString()} bar returns vs a normal curve · skew ${f(st.skew)}, excess kurtosis ${f(st.kurt)}`}><EChart option={distOpt} height={280} /></Card>
        <Card title="Q-Q plot" sub="Points above the line on the right (below on the left) mean fatter tails than normal"><EChart option={qqOpt} height={280} /></Card>
      </div>

      {!intraday ? (
        <Card title="Monthly returns" sub="% per calendar month · yearly total on the right" className="an-full">
          <div className="an-heat-wrap">
            <div className="an-heat" style={{ gridTemplateColumns: `52px repeat(12, minmax(42px, 1fr)) 70px` }}>
              <div />{MONTHS.map((x) => <div key={x} className="hh">{x}</div>)}<div className="hh">Year</div>
              {years.map((y) => (
                <Row key={y}>
                  <div className="hh">{y}</div>
                  {MONTHS.map((_, mo) => { const v = monthly.get(`${y}-${mo}`); return <div key={mo} className="hc" style={{ background: heat(v) }} title={v != null ? `${MONTHS[mo]} ${y}: ${fs(v)}` : ""}>{v != null ? v.toFixed(1) : ""}</div>; })}
                  <div className="hc yr" style={{ background: heat(yearly.get(String(y)), maxAbsMonth * 3) }}>{yearly.get(String(y)) != null ? yearly.get(String(y))!.toFixed(1) : ""}</div>
                </Row>
              ))}
              <div className="hh">Avg</div>
              {byMonth.map((x, mo) => <div key={mo} className="hc avg" style={{ background: heat(x.mean ?? undefined) }} title={`${x.n} years, ${f(x.pos, 0, "%")} positive`}>{x.mean != null ? x.mean.toFixed(1) : ""}</div>)}
              <div />
            </div>
          </div>
        </Card>
      ) : (
        <Card title="Weekday × hour" sub="Average bar return (%) by local weekday and hour of the day" className="an-full">
          <HourWeekHeat t={base.t} c={base.c} local={local} heat={heat} />
        </Card>
      )}

      <div className="an-grid g111">
        {!intraday && <Card title="Average return by month"><EChart option={barOpt(MONTHS, byMonth.map((x) => ({ mean: x.mean, pos: x.pos, n: x.n })), "Avg monthly return")} height={240} /></Card>}
        <Card title="Average return by weekday"><EChart option={barOpt(WD, byWeekday, "Avg bar return")} height={240} /></Card>
        {byHour ? <Card title="Average return by hour"><EChart option={barOpt(byHour.map((_, h) => `${h}:00`).filter((_, h) => byHour[h].n), byHour.filter((x) => x.n), "Avg bar return")} height={240} /></Card>
          : <Card title="Yearly returns"><EChart option={barOpt([...yearly.keys()], [...yearly.values()].map((v) => ({ mean: v, pos: v > 0 ? 100 : 0, n: 1 })), "Yearly return")} height={240} /></Card>}
      </div>

      <div className="an-grid g21">
        <Card title="Rolling statistics" sub={`${win}-bar window`}
          actions={<>
            <Seg value={metric} onChange={setMetric} options={[{ v: "vol", l: "Volatility" }, { v: "sharpe", l: "Sharpe" }, { v: "ret", l: "Return" }, { v: "beta", l: "Beta" }, { v: "corr", l: "Correlation" }]} />
            <Seg value={win} onChange={setWin} options={[21, 63, 126, 252].map((w) => ({ v: w, l: String(w) }))} />
          </>}>
          {(metric === "beta" || metric === "corr") && !benchStats ? <div className="an-note">{bench ? `Waiting for ${bn} data (or its dates don't overlap this dataset).` : "Pick a benchmark dataset above to see rolling beta and correlation."}</div> : <EChart option={rollOpt} height={260} />}
        </Card>
        <Card title="Autocorrelation" sub="Return correlation with its own past (lags 1-30) · bars outside the red band are significant"><EChart option={acfOpt} height={260} /></Card>
      </div>

      <div className="an-grid g12">
        <Card title="Volume profile" sub={`Volume traded at each price · POC ${f((vp.rows[vp.poc].lo + vp.rows[vp.poc].hi) / 2)} · value area ${f(vp.rows[vp.vaLo].lo)} - ${f(vp.rows[vp.vaHi].hi)}`}>
          {base.v.some((x) => x > 0) ? <EChart option={vpOpt} height={380} /> : <div className="an-note">This dataset has no volume.</div>}
        </Card>
        <Card title="Relative performance and correlation" sub="Growth of 100 on common dates"
          actions={<div className="an-peer-add">
            <select className="an-input" value="" aria-label="Add a dataset to compare" onChange={(e) => { if (e.target.value) setPeers([...new Set([...peers, e.target.value])].slice(0, 6)); }}>
              <option value="">{others_.length ? "Add a dataset…" : "Upload more CSVs to compare"}</option>
              {others_.filter((x) => !peers.includes(x) && x !== bench).map((x) => <option key={x} value={x}>{nice(x)}</option>)}
            </select>
          </div>}>
          <div className="an-chips">
            {[bench, ...peers.filter((x) => x !== bench)].filter(Boolean).map((sym) => (
              <span key={sym} className="an-chip">{nice(sym)}{sym === bench ? " (benchmark)" : <button onClick={() => setPeers(peers.filter((x) => x !== sym))} aria-label={`Remove ${sym}`}><X size={12} /></button>}</span>
            ))}
            {missing.length > 0 && <span className="an-warn">Couldn't load {missing.map(nice).join(", ")}</span>}
          </div>
          {perfOpt ? <EChart option={perfOpt} height={230} /> : <div className="an-note">{others_.length ? "Add another dataset to compare." : "Upload more CSV files to compare them here."}</div>}
          {aligned && peerSeries.length > 1 && (
            <table className="an-table">
              <thead><tr><th>Symbol</th><th>Return</th><th>Volatility</th><th>Sharpe</th><th>Max DD</th>{peerSeries.map((x, k) => <th key={x.sym} title={x.label} style={{ color: PEER_COLORS[k % PEER_COLORS.length] }}>{x.label.slice(0, 8)}</th>)}</tr></thead>
              <tbody>{peerSeries.map((x, k) => {
                const cl = aligned.closes[k], rr = peerRets[k], s2 = rollStd(rr), mm = rollMean(rr);
                return (
                  <tr key={x.sym}>
                    <td style={{ color: PEER_COLORS[k % PEER_COLORS.length] }}><b>{x.label}</b></td>
                    <td className={tone(cl[cl.length - 1] / cl[0] - 1)}>{fs((cl[cl.length - 1] / cl[0] - 1) * 100, 1)}</td>
                    <td>{f(s2 * Math.sqrt(ppy) * 100, 1, "%")}</td><td>{f(s2 ? (mm / s2) * Math.sqrt(ppy) : null)}</td>
                    <td className="down">{f(Math.min(...drawdowns(cl)), 1, "%")}</td>
                    {peerRets.map((other, j) => { const cv = j === k ? 1 : corr(rr, other); return <td key={j} className="an-corr" style={{ background: cv == null ? undefined : `color-mix(in srgb, ${cv >= 0 ? "var(--ct-down)" : "var(--ct-up)"} ${Math.round(Math.abs(cv) * 45)}%, transparent)` }}>{f(cv)}</td>; })}
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Largest drawdowns" className="an-full">
        <table className="an-table">
          <thead><tr><th>#</th><th>Depth</th><th>Peak</th><th>Trough</th><th>Recovered</th><th>Length</th><th>Recovery</th></tr></thead>
          <tbody>{dds.map((d, i) => (
            <tr key={i}><td>{i + 1}</td><td className="down"><b>{f(d.depth, 2, "%")}</b></td><td>{dstr(d.start, !intraday)}</td><td>{dstr(d.trough, !intraday)}</td>
              <td>{d.end ? dstr(d.end, !intraday) : <span className="an-warn">Not yet</span>}</td><td>{d.bars} bars</td><td>{d.recovery == null ? "-" : `${d.recovery} bars`}</td></tr>
          ))}</tbody>
        </table>
      </Card>
    </div>
  );
}

const Row = ({ children }: { children: ReactNode }) => <>{children}</>;

function HourWeekHeat({ t, c, local, heat }: { t: number[]; c: number[]; local: (t: number) => Date; heat: (v: number | undefined, s?: number) => string }) {
  const grid = new Map<string, { s: number; n: number }>();
  for (let i = 1; i < c.length; i++) {
    const d = local(t[i]), k = `${d.getUTCDay()}-${d.getUTCHours()}`, r = (c[i] / c[i - 1] - 1) * 100;
    const g = grid.get(k) || { s: 0, n: 0 };
    g.s += r; g.n++; grid.set(k, g);
  }
  const hours = [...new Set([...grid.keys()].map((k) => +k.split("-")[1]))].sort((a, b) => a - b);
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => hours.some((h) => grid.has(`${d}-${h}`)));
  const vals = [...grid.values()].map((g) => Math.abs(g.s / g.n)).sort((a, b) => a - b);
  const scale = vals[Math.floor(vals.length * 0.9)] || 1;
  return (
    <div className="an-heat-wrap">
      <div className="an-heat" style={{ gridTemplateColumns: `52px repeat(${hours.length}, minmax(46px, 1fr))` }}>
        <div />{hours.map((h) => <div key={h} className="hh">{h}:00</div>)}
        {days.map((d) => (
          <Row key={d}>
            <div className="hh">{WD[d]}</div>
            {hours.map((h) => { const g = grid.get(`${d}-${h}`); const v = g ? g.s / g.n : undefined; return <div key={h} className="hc" style={{ background: heat(v, scale) }} title={g ? `${WD[d]} ${h}:00 · ${g.n} bars` : ""}>{v != null ? v.toFixed(3) : ""}</div>; })}
          </Row>
        ))}
      </div>
    </div>
  );
}
