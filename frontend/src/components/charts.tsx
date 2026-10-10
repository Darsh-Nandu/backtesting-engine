import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { BacktestResult, MonteCarlo, Trade } from "../api";
import { compact, date, money, num, pct } from "../format";
import { usePalette } from "../store";
import { axisStyle, baseOption, EChart, tooltipRow } from "./EChart";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pairs(t: number[], v: (number | null)[] | null | undefined) {
  if (!v) return [];
  const out: [number, number | null][] = new Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = [t[i] * 1000, v[i]];
  return out;
}

/* ------------------------------------------------------------------ */
export function EquityChart({ res, log = false, height = 440 }: { res: BacktestResult; log?: boolean; height?: number }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const s = res.series;
    const cur = res.currency;
    const ax = axisStyle(p);
    const series: any[] = [
      {
        name: "Strategy", type: "line", data: pairs(s.t, s.equity), showSymbol: false, xAxisIndex: 0, yAxisIndex: 0,
        lineStyle: { width: 2, color: p.series[0] }, itemStyle: { color: p.series[0] },
        areaStyle: log ? undefined : {
          color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [
            { offset: 0, color: p.series[0] + "22" }, { offset: 1, color: p.series[0] + "00" }] },
        },
        z: 3, sampling: "lttb",
      },
    ];
    if (s.benchmark) {
      series.push({
        name: res.benchmark_name || "Benchmark", type: "line", data: pairs(s.t, s.benchmark), showSymbol: false,
        xAxisIndex: 0, yAxisIndex: 0, lineStyle: { width: 1.3, color: p.bench, type: [4, 4] },
        itemStyle: { color: p.bench }, z: 2, sampling: "lttb",
      });
    }
    series.push({
      name: "Drawdown", type: "line", data: pairs(s.t, s.drawdown), showSymbol: false, xAxisIndex: 1, yAxisIndex: 1,
      lineStyle: { width: 1, color: p.neg + "cc" }, itemStyle: { color: p.neg },
      areaStyle: { color: p.neg + "26" }, sampling: "lttb",
    });
    return {
      ...baseOption(p),
      animation: false,
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      legend: { show: false },
      grid: [{ left: 56, right: 12, top: 12, height: "60%" }, { left: 56, right: 12, top: "74%", bottom: 44 }],
      tooltip: {
        ...(baseOption(p).tooltip as any),
        formatter: (items: any) => {
          const arr = Array.isArray(items) ? items : [items];
          if (!arr.length) return "";
          let h = `<div style="font-weight:600;margin-bottom:6px">${date(arr[0].value[0] / 1000)}</div>`;
          for (const it of arr) {
            const v = it.value[1];
            h += tooltipRow(it.color, it.seriesName, it.seriesName === "Drawdown" ? pct(v) : money(v, cur));
          }
          return h;
        },
      },
      xAxis: [
        { type: "time", gridIndex: 0, ...ax, axisLabel: { show: false }, splitLine: { show: false } },
        { type: "time", gridIndex: 1, ...ax, splitLine: { show: false } },
      ],
      yAxis: [
        { type: log ? "log" : "value", gridIndex: 0, scale: true, ...ax,
          axisLabel: { ...ax.axisLabel, formatter: (v: number) => compact(v) } },
        { type: "value", gridIndex: 1, max: 0, min: (v: { min: number }) => Math.min(Math.floor(v.min), -1), ...ax, splitNumber: 2,
          axisLabel: { ...ax.axisLabel, formatter: (v: number) => `${Math.abs(v) < 1 && v !== 0 ? v.toFixed(1) : v.toFixed(0)}%` } },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1], zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, moveOnMouseMove: true },
        { type: "slider", xAxisIndex: [0, 1], height: 18, bottom: 8, borderColor: "transparent",
          backgroundColor: "transparent", fillerColor: p.accent + "14", handleStyle: { color: p.surface, borderColor: p.axis },
          dataBackground: { lineStyle: { color: p.axis, opacity: 0.6 }, areaStyle: { color: p.grid, opacity: 0.5 } },
          selectedDataBackground: { lineStyle: { color: p.accent, opacity: 0.5 }, areaStyle: { color: p.accent, opacity: 0.08 } },
          textStyle: { color: p.muted, fontSize: 10 }, moveHandleSize: 0 },
      ],
      series,
    };
  }, [res, log, p]);
  return <EChart option={option} height={height} />;
}

/* ------------------------------------------------------------------ */
export function Histogram({ counts, edges, height = 240, unit = "%", markers = [], neutral = false }: {
  counts: number[]; edges: number[]; height?: number; unit?: string; markers?: { value: number; label: string }[]; neutral?: boolean;
}) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const centers = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
    return {
      ...baseOption(p),
      grid: { left: 44, right: 14, top: 18, bottom: 30 },
      tooltip: {
        ...(baseOption(p).tooltip as any), trigger: "item",
        formatter: (it: any) => `${num(edges[it.dataIndex], 2)}${unit} → ${num(edges[it.dataIndex + 1], 2)}${unit}<br/><b>${it.value[1]}</b> obs.`,
      },
      xAxis: { type: "value", ...axisStyle(p), splitLine: { show: false }, axisLabel: { ...axisStyle(p).axisLabel, formatter: `{value}${unit}` } },
      yAxis: { type: "value", ...axisStyle(p) },
      series: [{
        type: "bar", barWidth: "92%",
        data: centers.map((c, i) => ({ value: [c, counts[i]], itemStyle: { color: neutral ? p.series[0] + "b3" : (c >= 0 ? p.pos : p.neg) + "cc", borderRadius: [3, 3, 0, 0] } })),
        markLine: markers.length ? {
          symbol: "none", silent: true, label: { color: p.text2, fontSize: 10, formatter: "{b}" },
          lineStyle: { color: p.text2, type: "dashed" }, data: markers.map((m) => ({ xAxis: m.value, name: m.label })),
        } : undefined,
      }],
    };
  }, [counts, edges, p, unit, markers, neutral]);
  return <EChart option={option} height={height} />;
}

export function ReturnsHistogram({ res, height = 260 }: { res: BacktestResult; height?: number }) {
  const { counts, edges, mean, var95 } = useMemo(() => {
    const r = res.returns_dist.filter((v): v is number => v != null && v !== 0);
    if (!r.length) return { counts: [], edges: [], mean: 0, var95: 0 };
    const sorted = [...r].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.005)], hi = sorted[Math.ceil(sorted.length * 0.995) - 1];
    const bins = 50, w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const v of r) counts[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))]++;
    const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * w);
    return { counts, edges, mean: r.reduce((a, b) => a + b, 0) / r.length, var95: sorted[Math.floor(sorted.length * 0.05)] };
  }, [res]);
  if (!counts.length) return <div className="empty" style={{ padding: 30 }}>No returns</div>;
  return <Histogram counts={counts} edges={edges} height={height}
    markers={[{ value: mean, label: "mean" }, { value: var95, label: "VaR 95" }]} />;
}

/* ------------------------------------------------------------------ */
export function YearlyBars({ res, height = 260 }: { res: BacktestResult; height?: number }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const ys = res.yearly;
    const hasB = ys.some((y) => y.bench != null);
    return {
      ...baseOption(p),
      legend: { show: hasB, top: 0, right: 0, textStyle: { color: p.text2, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      grid: { left: 48, right: 10, top: hasB ? 30 : 14, bottom: 26 },
      tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow", shadowStyle: { color: p.grid + "80" } },
        valueFormatter: (v: any) => pct(v) },
      xAxis: { type: "category", data: ys.map((y) => String(y.year)), ...axisStyle(p), splitLine: { show: false } },
      yAxis: { type: "value", ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" } },
      series: [
        { name: "Strategy", type: "bar", barGap: "12%", barMaxWidth: 22, itemStyle: { color: p.series[0] },
          data: ys.map((y) => ({ value: y.ret, itemStyle: { color: p.series[0], borderRadius: y.ret >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })) },
        ...(hasB ? [{ name: res.benchmark_name || "Benchmark", type: "bar" as const, barMaxWidth: 22, itemStyle: { color: p.bench + "99" },
          data: ys.map((y) => ({ value: y.bench, itemStyle: { color: p.bench + "99", borderRadius: (y.bench ?? 0) >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })) }] : []),
      ] as any,
    };
  }, [res, p]);
  return <EChart option={option} height={height} />;
}

/* ------------------------------------------------------------------ */
export function LineChart({ t, values, name, color, height = 220, unit = "", refLine, area }: {
  t: number[]; values: (number | null)[]; name: string; color: string; height?: number; unit?: string; refLine?: number; area?: boolean;
}) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => ({
    ...baseOption(p),
    animation: values.length < 1500,
    grid: { left: 48, right: 14, top: 14, bottom: 26 },
    tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => {
      const it = items[0];
      return `<div style="font-weight:600;margin-bottom:4px">${date(it.value[0] / 1000)}</div>` +
        tooltipRow(color, name, it.value[1] == null ? "-" : `${num(it.value[1], 2)}${unit}`);
    } },
    xAxis: { type: "time", ...axisStyle(p), splitLine: { show: false } },
    yAxis: { type: "value", scale: true, ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: `{value}${unit}` } },
    series: [{
      name, type: "line", showSymbol: false, data: pairs(t, values), sampling: "lttb",
      lineStyle: { width: 1.4, color }, itemStyle: { color },
      areaStyle: area ? { color: color + "18" } : undefined,
      markLine: refLine != null ? { symbol: "none", silent: true, label: { show: false },
        lineStyle: { color: p.axis, type: "dashed" }, data: [{ yAxis: refLine }] } : undefined,
    }],
  }), [t, values, name, color, p, unit, refLine, area]);
  return <EChart option={option} height={height} />;
}

/* ------------------------------------------------------------------ */
export function TradeScatter({ trades, height = 300, x = "bars_held" }: { trades: Trade[]; height?: number; x?: "bars_held" | "mae_pct" | "mfe_pct" }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const xl = { bars_held: "Bars held", mae_pct: "Max adverse excursion %", mfe_pct: "Max favourable excursion %" }[x];
    const mk = (win: boolean) => trades.filter((t) => (t.pnl > 0) === win).map((t) => ({ value: [t[x], t.return_pct], t }));
    return {
      ...baseOption(p),
      legend: { top: 0, right: 0, textStyle: { color: p.text2, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      grid: { left: 52, right: 14, top: 30, bottom: 40 },
      tooltip: { ...(baseOption(p).tooltip as any), trigger: "item", formatter: (it: any) => {
        const t: Trade = it.data.t;
        return `<b>#${t.id} ${t.symbol}</b> · ${t.side}<br/>${date(t.entry_time)} → ${date(t.exit_time)}<br/>` +
          `Return <b>${pct(t.return_pct)}</b> · ${t.bars_held} bars<br/>MAE ${pct(t.mae_pct)} · MFE ${pct(t.mfe_pct)}<br/><span style="opacity:.7">${t.exit_reason}</span>`;
      } },
      xAxis: { type: "value", name: xl, nameLocation: "middle", nameGap: 26, nameTextStyle: { color: p.muted, fontSize: 11 }, ...axisStyle(p) },
      yAxis: { type: "value", ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" } },
      series: [
        { name: "Winners", type: "scatter", symbolSize: 8, data: mk(true), itemStyle: { color: p.pos, opacity: 0.85, borderColor: p.surface, borderWidth: 1 } },
        { name: "Losers", type: "scatter", symbolSize: 8, data: mk(false), itemStyle: { color: p.neg, opacity: 0.85, borderColor: p.surface, borderWidth: 1 } },
      ],
    };
  }, [trades, p, x]);
  return <EChart option={option} height={height} />;
}

/* ------------------------------------------------------------------ */
export function PnlBars({ trades, height = 240, currency }: { trades: Trade[]; height?: number; currency: string }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    let cum = 0;
    const cumData = trades.map((t) => (cum += t.pnl));
    return {
      ...baseOption(p),
      grid: { left: 64, right: 14, top: 14, bottom: 26 },
      tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow", shadowStyle: { color: p.grid + "80" } },
        formatter: (items: any) => {
          const i = items[0].dataIndex, t = trades[i];
          return `<b>Trade #${t.id}</b> ${t.symbol}<br/>${tooltipRow(t.pnl >= 0 ? p.pos : p.neg, "P&L", money(t.pnl, currency))}${tooltipRow(p.series[0], "Cumulative", money(cumData[i], currency))}`;
        } },
      xAxis: { type: "category", data: trades.map((t) => `#${t.id}`), ...axisStyle(p), axisLabel: { show: false }, splitLine: { show: false } },
      yAxis: { type: "value", ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: (v: number) => compact(v) } },
      series: [
        { type: "bar", data: trades.map((t) => ({ value: t.pnl, itemStyle: { color: t.pnl >= 0 ? p.pos : p.neg, borderRadius: t.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })), barMaxWidth: 12 },
        { type: "line", data: cumData, showSymbol: false, lineStyle: { color: p.series[0], width: 2 }, itemStyle: { color: p.series[0] } },
      ],
    };
  }, [trades, p, currency]);
  return <EChart option={option} height={height} />;
}

/* ------------------------------------------------------------------ */
export function MonteCarloFan({ mc, actual, currency, height = 340 }: {
  mc: MonteCarlo; actual?: { t: number[]; equity: number[] }; currency: string; height?: number;
}) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const x = mc.time_axis ? mc.x.map((v) => v * 1000) : mc.x;
    const b = mc.bands;
    const band = (lo: number[], hi: number[], name: string, op: string) => [
      { name: name + "lo", type: "line", data: x.map((xv, i) => [xv, lo[i]]), stack: name, lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
      { name, type: "line", data: x.map((xv, i) => [xv, hi[i] - lo[i]]), stack: name, lineStyle: { opacity: 0 }, showSymbol: false, areaStyle: { color: p.series[0] + op }, silent: true, tooltip: { show: false } },
    ];
    const series: any[] = [
      ...band(b.p5, b.p95, "5-95%", "26"),
      ...band(b.p25, b.p75, "25-75%", "40"),
      ...mc.sample_paths.slice(0, 20).map((path) => ({
        type: "line", data: x.map((xv, i) => [xv, path[i]]), showSymbol: false, silent: true,
        lineStyle: { width: 0.6, color: p.muted, opacity: 0.2 }, tooltip: { show: false },
      })),
      { name: "Median", type: "line", data: x.map((xv, i) => [xv, b.p50[i]]), showSymbol: false, lineStyle: { width: 2, color: p.series[0] }, itemStyle: { color: p.series[0] } },
      { name: "5th pct", type: "line", data: x.map((xv, i) => [xv, b.p5[i]]), showSymbol: false, lineStyle: { width: 1, color: p.neg + "aa", type: "dashed" }, itemStyle: { color: p.neg } },
      { name: "95th pct", type: "line", data: x.map((xv, i) => [xv, b.p95[i]]), showSymbol: false, lineStyle: { width: 1, color: p.pos + "aa", type: "dashed" }, itemStyle: { color: p.pos } },
    ];
    if (actual && mc.time_axis) {
      series.push({ name: "Actual", type: "line", data: pairs(actual.t, actual.equity), showSymbol: false, sampling: "lttb",
        lineStyle: { width: 1.3, color: p.text2 }, itemStyle: { color: p.text2 } });
    }
    return {
      ...baseOption(p),
      grid: { left: 64, right: 16, top: 16, bottom: 30 },
      tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => {
        const arr = (items as any[]).filter((i) => i.seriesName && !i.seriesName.endsWith("lo"));
        if (!arr.length) return "";
        const head = mc.time_axis ? date(arr[0].value[0] / 1000) : `Trade ${arr[0].value[0]}`;
        return `<div style="font-weight:600;margin-bottom:4px">${head}</div>` + arr.map((i) => tooltipRow(i.color, i.seriesName, money(i.value[1], currency))).join("");
      } },
      xAxis: { type: mc.time_axis ? "time" : "value", ...axisStyle(p), splitLine: { show: false },
        name: mc.time_axis ? undefined : "Trade #", nameLocation: "middle", nameGap: 22 },
      yAxis: { type: "value", scale: true, ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: (v: number) => compact(v) } },
      series,
    };
  }, [mc, actual, p, currency]);
  return <EChart option={option} height={height} />;
}

/* ------------------------------------------------------------------ */
export function MonthlyHeatmap({ res }: { res: BacktestResult }) {
  const { years, grid, yearly, maxAbs } = useMemo(() => {
    const years = [...new Set(res.monthly.map((m) => m.year))].sort();
    const grid: Record<string, number> = {};
    res.monthly.forEach((m) => (grid[`${m.year}-${m.month}`] = m.ret));
    const yearly: Record<number, number> = {};
    res.yearly.forEach((y) => (yearly[y.year] = y.ret));
    const vals = res.monthly.map((m) => Math.abs(m.ret)).filter((v) => v != null).sort((a, b) => a - b);
    const maxAbs = vals.length ? vals[Math.floor(vals.length * 0.95)] || 1 : 1;
    return { years, grid, yearly, maxAbs };
  }, [res]);
  const bg = (v: number | undefined, scale = maxAbs) => {
    if (v == null) return "transparent";
    const k = Math.min(Math.abs(v) / scale, 1);
    const pctMix = Math.round(6 + k * 42);
    return `color-mix(in srgb, var(${v >= 0 ? "--pos" : "--neg"}) ${pctMix}%, var(--div-mid))`;
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <div className="heat" style={{ gridTemplateColumns: `48px repeat(12, minmax(38px, 1fr)) 64px`, minWidth: 600 }}>
        <div />
        {MONTHS.map((m) => <div key={m} className="hh">{m}</div>)}
        <div className="hh">Year</div>
        {years.map((y) => (
          <Row key={y} y={y} grid={grid} yearly={yearly} bg={bg} maxAbs={maxAbs} />
        ))}
      </div>
    </div>
  );
}

function Row({ y, grid, yearly, bg, maxAbs }: { y: number; grid: Record<string, number>; yearly: Record<number, number>; bg: (v: number | undefined, s?: number) => string; maxAbs: number }) {
  return (
    <>
      <div className="hh">{y}</div>
      {Array.from({ length: 12 }, (_, m) => {
        const v = grid[`${y}-${m + 1}`];
        return (
          <div key={m} className="hc" style={{ background: bg(v) }} title={v != null ? `${MONTHS[m]} ${y}: ${pct(v)}` : ""}>
            {v != null ? num(v, 1) : ""}
          </div>
        );
      })}
      <div className="hc" style={{ background: bg(yearly[y], maxAbs * 3), fontWeight: 600 }}>{yearly[y] != null ? num(yearly[y], 1) : ""}</div>
    </>
  );
}

/* ------------------------------------------------------------------ */
export function Spark({ values, color, height = 34 }: { values: number[]; color: string; height?: number }) {
  const d = useMemo(() => {
    const v = values.filter((x) => x != null);
    if (v.length < 2) return "";
    const step = Math.max(1, Math.floor(v.length / 120));
    const pts = v.filter((_, i) => i % step === 0);
    const lo = Math.min(...pts), hi = Math.max(...pts), r = hi - lo || 1;
    return pts.map((y, i) => `${(i / (pts.length - 1)) * 100},${height - ((y - lo) / r) * (height - 4) - 2}`).join(" ");
  }, [values, height]);
  if (!d) return null;
  return (
    <svg className="kpi-spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
