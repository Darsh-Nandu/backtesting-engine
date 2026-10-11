import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronDown, Download, ExternalLink, FileJson, PanelLeftClose, PanelLeftOpen, Play, Table2,
} from "lucide-react";
import type { EChartsOption } from "echarts";
import { CompareEntry, CompareResult } from "../api";
import { compact, date, downloadCSV, downloadJSON, isNum, money, num, pct, tone } from "../format";
import { usePalette } from "../store";
import { availablePeriodsT, engineStats, Period, periodStartT, WindowStats, windowStats } from "../window";
import { axisStyle, baseOption, EChart, tooltipRow } from "./EChart";
import { Card, Seg, Spinner, Tabs } from "./ui";
import type { ResultsChrome } from "./Results";

type Tab = "overview" | "returns" | "metrics";
const PERIOD_LABEL: Record<Period, string> = { YTD: "YTD", "1Y": "1Y", "3Y": "3Y", "5Y": "5Y", ALL: "All" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One line of the comparison: a strategy, the equal-weight blend, or the benchmark. */
interface Row {
  key: string; tag: string; label: string; color: string; kind: "strategy" | "blend" | "bench";
  entry: CompareEntry | null; eq: number[]; s: WindowStats; calmar: number | null;
}

/** Return per calendar year / month from an equity series (first period measured from the first value). */
function periodReturns(t: number[], v: number[], kind: "Y" | "M"): Map<string, number> {
  const out = new Map<string, number>();
  if (v.length < 2) return out;
  const keyOf = (ts: number) => { const d = new Date(ts * 1000); return kind === "Y" ? String(d.getUTCFullYear()) : `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`; };
  let prev = v[0], curKey = keyOf(t[0]), last = v[0];
  for (let i = 1; i < v.length; i++) {
    const k = keyOf(t[i]);
    if (k !== curKey) { out.set(curKey, (last / prev - 1) * 100); prev = last; curKey = k; }
    last = v[i];
  }
  out.set(curKey, (last / prev - 1) * 100);
  return out;
}

function returnsOf(v: number[]) {
  const r = new Array(Math.max(v.length - 1, 0));
  for (let i = 1; i < v.length; i++) r[i - 1] = v[i - 1] ? v[i] / v[i - 1] - 1 : 0;
  return r as number[];
}

function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

function ddOf(v: number[]) {
  let peak = -Infinity;
  return v.map((x) => { peak = Math.max(peak, x); return (x / peak - 1) * 100; });
}

const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function CompareResults({ res, chrome, onOpen }: { res: CompareResult; chrome?: ResultsChrome; onOpen: (e: CompareEntry) => void }) {
  const p = usePalette();
  const [period, setPeriod] = useState<Period>("ALL");
  const [tab, setTab] = useState<Tab>("overview");
  const capital = res.config.initial_capital;

  const from = periodStartT(res.t, period);
  const i0 = useMemo(() => { if (from == null) return 0; const k = res.t.findIndex((x) => x >= from); return k < 0 ? 0 : k; }, [res.t, from]);
  const t = useMemo(() => res.t.slice(i0), [res.t, i0]);

  // Every line is re-based to the starting capital at the window start, so curves start together.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let n = 0;
    const mk = (key: string, label: string, color: string, kind: Row["kind"], entry: CompareEntry | null, full: number[]) => {
      const raw = full.slice(i0);
      const base = raw.find((x) => x != null && x > 0) || 1;
      const eq = raw.map((x) => (x / base) * capital);
      const view = {
        series: { t, equity: eq, benchmark: res.benchmark ? res.benchmark.slice(i0) : null, exposure: entry?.exposure ? entry.exposure.slice(i0) : [] },
        trades: (entry?.trades || []).filter((tr) => from == null || tr.exit_time >= from),
        config: res.config,
      } as any;
      const s = period === "ALL" && entry ? engineStats(entry) : windowStats(view);
      if (kind === "bench") { s.benchReturn = null; s.benchCagr = null; }
      const calmar = isNum(s.cagr) && isNum(s.maxDrawdown) && s.maxDrawdown < 0 ? s.cagr / Math.abs(s.maxDrawdown) : null;
      // A short tag ties a line to its bubble and its matrix row: 1..n, B = blend, BM = benchmark.
      const tag = kind === "strategy" ? String(++n) : kind === "blend" ? "B" : "BM";
      out.push({ key, tag, label, color, kind, entry, eq, s, calmar });
    };
    res.strategies.forEach((e, i) => { if (!e.error) mk(`s${i}`, e.label, p.cmp[i % 8], "strategy", e, e.equity); });
    if (res.blend) mk("blend", res.blend.label, p.text2, "blend", res.blend, res.blend.equity);
    if (res.benchmark) mk("bench", res.benchmark_name || "Benchmark", p.bench, "bench", null, res.benchmark as number[]);
    return out;
  }, [res, i0, t, from, period, capital, p]);

  const strat = rows.filter((r) => r.kind === "strategy");
  const failed = res.strategies.filter((e) => e.error);
  const notes = res.strategies.filter((e) => !e.error && e.note).map((e) => `${e.label}: ${e.note}`);
  const warnings = [...res.warnings, ...notes];

  return (
    <div>
      <Header res={res} period={period} setPeriod={setPeriod} chrome={chrome} rows={rows} />
      {failed.length > 0 && (
        <div className="alert err" style={{ marginBottom: 16 }}><AlertTriangle size={17} style={{ flex: "none", marginTop: 2 }} />
          <div>{failed.map((e) => <div key={e.label}><b>{e.label}</b> couldn't run: {e.error}</div>)}</div></div>
      )}
      {warnings.length > 0 && (
        <div className="alert warn" style={{ marginBottom: 16 }}><AlertTriangle size={17} style={{ flex: "none", marginTop: 2 }} />
          <div>{warnings.map((w, i) => <div key={i}>{w}</div>)}</div></div>
      )}
      <LeaderCards rows={rows} period={period} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Overview" },
        { id: "returns", label: "Returns" },
        { id: "metrics", label: "All metrics", count: strat.length },
      ]} />
      {tab === "overview" && (
        <>
          <div className="ov-grid">
            <EquityCard rows={rows} t={t} currency={res.currency} capital={capital} />
            <Card title="Risk vs return" sub="Up and to the left is better">
              <RiskReturn rows={rows} />
            </Card>
          </div>
          <div className="cmp-grid2 mt">
            <Card title="Drawdowns" sub="% below each strategy's previous peak">
              <DrawdownChart rows={rows} t={t} />
            </Card>
            <Card title="Return correlation" sub="Bar-by-bar returns · lower means better diversification">
              <CorrMatrix rows={rows.filter((r) => r.kind !== "blend")} />
            </Card>
          </div>
          <RankTable rows={rows} currency={res.currency} onOpen={onOpen} />
        </>
      )}
      {tab === "returns" && (
        <>
          <Card title="Annual returns" sub="Calendar-year return of each strategy">
            <AnnualBars rows={rows} t={t} />
          </Card>
          <ConsistencyTable rows={rows} t={t} />
        </>
      )}
      {tab === "metrics" && <AllMetrics res={res} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Header({ res, period, setPeriod, chrome, rows }: {
  res: CompareResult; period: Period; setPeriod: (p: Period) => void; chrome?: ResultsChrome; rows: Row[];
}) {
  const r = res.request;
  const syms = r.symbols || [];
  const n = res.strategies.filter((e) => !e.error).length;
  const st = r.stops || ({} as any);
  const extras = [st.stop_loss_pct ? `Stop-loss ${st.stop_loss_pct}%` : "", st.take_profit_pct ? `Take-profit ${st.take_profit_pct}%` : "",
    st.trailing_pct ? `Trailing ${st.trailing_pct}%` : "", r.rules?.direction === "both" ? "Long & short" : r.rules?.direction === "short" ? "Short only" : ""].filter(Boolean);
  return (
    <div className="result-head">
      <div className="rh-main">
        <div className="rh-title-row">
          <div className="result-title">Strategy comparison</div>
          <span className="tag accent">{res.market.code}</span>
          {syms.slice(0, 4).map((s) => <span key={s} className="tag">{s.replace(/\.(NS|BO)$/, "")}</span>)}
          {syms.length > 4 && <span className="tag">+{syms.length - 4}</span>}
        </div>
        <div className="result-meta">
          {res.t.length ? `${date(res.t[0])} - ${date(res.t[res.t.length - 1])}` : ""} · {r.interval} · {n} strategies · {money(res.config.initial_capital, res.currency, true)} each
          {extras.length > 0 && ` · ${extras.join(" · ")}`}
        </div>
      </div>
      <div className="result-actions">
        <div className="rh-filter" title="Period: recomputes every card, chart and table for the selected window">
          <span className="rh-filter-label">Period</span>
          <Seg value={period} onChange={setPeriod} options={availablePeriodsT(res.t).map((x) => ({ value: x, label: PERIOD_LABEL[x] }))} />
        </div>
        {chrome && (
          <>
            <button className="btn" onClick={chrome.onToggleSettings} title={chrome.settingsOpen ? "Hide settings for a wider view" : "Show settings"}>
              {chrome.settingsOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}{chrome.settingsOpen ? "Hide settings" : "Settings"}
            </button>
            {!chrome.settingsOpen && (
              <button className="btn btn-primary" onClick={chrome.onRun} disabled={chrome.running} title="Run again (Ctrl + Enter)">
                {chrome.running ? <Spinner /> : <Play size={15} fill="currentColor" />}Run
              </button>
            )}
          </>
        )}
        <ExportMenu res={res} rows={rows} period={period} />
      </div>
    </div>
  );
}

function ExportMenu({ res, rows, period }: { res: CompareResult; rows: Row[]; period: Period }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item = (icon: ReactNode, title: string, sub: string, fn: () => void) => (
    <button className="menu-item" onClick={() => { fn(); setOpen(false); }}>{icon}<span><b>{title}</b><small>{sub}</small></span></button>
  );
  const r2 = (v: number | null) => (isNum(v) ? Math.round(v * 1000) / 1000 : "");
  return (
    <div className="menu" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><Download size={17} />Export<ChevronDown size={15} /></button>
      {open && (
        <div className="menu-pop" role="menu">
          {item(<Table2 size={18} />, "Comparison table (CSV)", `Key metrics per strategy · ${PERIOD_LABEL[period]}`, () => downloadCSV(`comparison_${res.id}.csv`, rows.map((r) => ({
            strategy: r.label, type: r.kind, total_return_pct: r2(r.s.totalReturn), cagr_pct: r2(r.s.cagr), sharpe: r2(r.s.sharpe),
            sortino: r2(r.s.sortino), max_drawdown_pct: r2(r.s.maxDrawdown), volatility_pct: r2(r.s.volatility), calmar: r2(r.calmar),
            trades: r.kind === "strategy" ? r.s.trades : "", win_rate_pct: r2(r.s.winRate), profit_factor: r2(r.s.profitFactor),
            exposure_pct: r2(r.s.exposure), fees: r2(r.s.fees) }))))}
          {item(<Table2 size={18} />, "Equity curves (CSV)", "One column per strategy", () => downloadCSV(`comparison_equity_${res.id}.csv`, res.t.map((t, i) => {
            const o: Record<string, any> = { date: new Date(t * 1000).toISOString() };
            res.strategies.forEach((e) => { if (!e.error) o[e.label] = e.equity[i]; });
            if (res.blend) o[res.blend.label] = res.blend.equity[i];
            if (res.benchmark) o[res.benchmark_name || "benchmark"] = res.benchmark[i] ?? "";
            return o;
          })))}
          {item(<FileJson size={18} />, "Full result (JSON)", "Every metric, series and trade", () => downloadJSON(`comparison_${res.id}.json`, res))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function LeaderCards({ rows, period }: { rows: Row[]; period: Period }) {
  const strat = rows.filter((r) => r.kind === "strategy");
  const blend = rows.find((r) => r.kind === "blend");
  const bench = rows.find((r) => r.kind === "bench");
  const scope = period === "ALL" ? "full period" : PERIOD_LABEL[period];
  const rank = (f: (r: Row) => number | null) => strat.filter((r) => isNum(f(r))).sort((a, b) => (f(b) as number) - (f(a) as number));
  const avg = (f: (r: Row) => number | null) => { const v = strat.map(f).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  const byRet = rank((r) => r.s.totalReturn), bySharpe = rank((r) => r.s.sharpe), byDd = rank((r) => r.s.maxDrawdown);
  const gap = (list: Row[], f: (r: Row) => number | null) => (list.length > 1 ? (f(list[0]) as number) - (f(list[1]) as number) : null);

  const cards: { label: string; who: Row | undefined; value: string; cls: string; delta: number | null; deltaText: string | null; sub: string }[] = [
    { label: "Highest return", who: byRet[0], value: pct(byRet[0]?.s.totalReturn), cls: tone(byRet[0]?.s.totalReturn),
      delta: gap(byRet, (r) => r.s.totalReturn), deltaText: byRet.length > 1 ? `${pct(gap(byRet, (r) => r.s.totalReturn), 1)} vs ${short(byRet[1].label, 14)}` : null,
      sub: `CAGR ${pct(byRet[0]?.s.cagr)} · ${scope}` },
    { label: "Best Sharpe ratio", who: bySharpe[0], value: num(bySharpe[0]?.s.sharpe), cls: "",
      delta: gap(bySharpe, (r) => r.s.sharpe), deltaText: bySharpe.length > 1 ? `+${num(gap(bySharpe, (r) => r.s.sharpe))} vs ${short(bySharpe[1].label, 14)}` : null,
      sub: `Sortino ${num(bySharpe[0]?.s.sortino)} · volatility ${pct(bySharpe[0]?.s.volatility, 1, false)}` },
    { label: "Smallest drawdown", who: byDd[0], value: pct(byDd[0]?.s.maxDrawdown), cls: "",
      delta: gap(byDd, (r) => r.s.maxDrawdown), deltaText: byDd.length > 1 ? `${num(gap(byDd, (r) => r.s.maxDrawdown), 1)} pts vs ${short(byDd[1].label, 14)}` : null,
      sub: `Longest recovery ${num(byDd[0]?.s.ddDays, 0)} days` },
  ];
  if (blend) {
    const aS = avg((r) => r.s.sharpe), aD = avg((r) => r.s.maxDrawdown);
    cards.push({ label: "Equal-weight blend", who: blend, value: pct(blend.s.totalReturn), cls: tone(blend.s.totalReturn),
      delta: isNum(blend.s.sharpe) && isNum(aS) ? blend.s.sharpe - aS : null,
      deltaText: isNum(blend.s.sharpe) && isNum(aS) ? `Sharpe ${num(blend.s.sharpe)} vs ${num(aS)} avg` : null,
      sub: `Max drawdown ${pct(blend.s.maxDrawdown, 1)} vs ${pct(aD, 1)} avg` });
  } else if (bench) {
    cards.push({ label: "Benchmark", who: bench, value: pct(bench.s.totalReturn), cls: tone(bench.s.totalReturn), delta: null, deltaText: null,
      sub: `Sharpe ${num(bench.s.sharpe)} · max drawdown ${pct(bench.s.maxDrawdown, 1)}` });
  }
  return (
    <div className="kpis kpi-cards cmp-leaders">
      {cards.map((k) => (
        <div key={k.label} className="kpi">
          <div className="kpi-label">{k.label}</div>
          <div className="kpi-who" title={k.who?.label}>
            <span className={`cmp-swatch ${k.who?.kind === "blend" ? "dashed" : ""}`} style={{ background: k.who?.kind === "blend" ? undefined : k.who?.color, color: k.who?.color }} />
            {k.who?.label ?? "-"}
          </div>
          <div className={`kpi-value num ${k.cls}`}>{k.value}</div>
          <div className="kpi-foot">
            {k.deltaText && <span className={`delta ${tone(k.delta)}`}>{(k.delta ?? 0) >= 0 ? "▲" : "▼"} {k.deltaText}</span>}
            <span className="kpi-sub">{k.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function lineStyleOf(r: Row, width = 2.2) {
  if (r.kind === "blend") return { width: 2, color: r.color, type: [6, 4] as any };
  if (r.kind === "bench") return { width: 1.6, color: r.color, type: [2, 3] as any };
  return { width, color: r.color };
}

function EquityCard({ rows, t, currency, capital }: { rows: Row[]; t: number[]; currency: string; capital: number }) {
  const p = usePalette();
  const [log, setLog] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<string | null>(null);
  const chartH = typeof window !== "undefined" && window.innerHeight < 960 ? 330 : 400;
  const toggle = (key: string) => setHidden((h) => { const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const option = useMemo<EChartsOption>(() => {
    const ax = axisStyle(p);
    const shown = rows.filter((r) => !hidden.has(r.key));
    return {
      ...baseOption(p),
      animation: false,
      legend: { show: false },
      grid: { left: 58, right: 14, top: 14, bottom: 54 },
      tooltip: {
        ...(baseOption(p).tooltip as any),
        formatter: (items: any) => {
          const arr = (Array.isArray(items) ? items : [items]).slice().sort((a: any, b: any) => (b.value[1] ?? 0) - (a.value[1] ?? 0));
          if (!arr.length) return "";
          return `<div style="font-weight:600;margin-bottom:6px">${date(arr[0].value[0] / 1000)}</div>` +
            arr.map((it: any) => tooltipRow(it.color, short(it.seriesName, 30), `${money(it.value[1], currency, true)} <span style="opacity:.6;font-weight:500">${pct((it.value[1] / capital - 1) * 100, 1)}</span>`)).join("");
        },
      },
      xAxis: { type: "time", ...ax, splitLine: { show: false } },
      yAxis: { type: log ? "log" : "value", scale: true, ...ax, axisLabel: { ...ax.axisLabel, formatter: (v: number) => compact(v) } },
      dataZoom: [
        { type: "inside", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, moveOnMouseMove: true },
        { type: "slider", height: 18, bottom: 8, borderColor: "transparent", backgroundColor: "transparent", fillerColor: p.accent + "14",
          handleStyle: { color: p.surface, borderColor: p.axis }, textStyle: { color: p.muted, fontSize: 12 }, moveHandleSize: 0,
          dataBackground: { lineStyle: { color: p.axis, opacity: 0.6 }, areaStyle: { color: p.grid, opacity: 0.5 } } },
      ],
      series: shown.map((r) => {
        const dim = hover != null && hover !== r.key;
        const ls = lineStyleOf(r, hover === r.key ? 3.4 : 2.2);
        return {
          name: r.label, type: "line", showSymbol: false, sampling: "lttb", z: hover === r.key ? 5 : r.kind === "strategy" ? 3 : 2,
          data: t.map((x, k) => [x * 1000, r.eq[k]]), lineStyle: { ...ls, opacity: dim ? 0.18 : 1 }, itemStyle: { color: r.color },
          emphasis: { focus: "series", lineStyle: { width: 3.2 } },
        };
      }) as any,
    };
  }, [rows, t, log, hidden, hover, p, currency, capital]);
  return (
    <Card title="Equity curves" sub={`Growth of ${money(capital, currency, true)} · Ctrl + scroll to zoom`}
      actions={<Seg value={log ? "log" : "lin"} onChange={(v) => setLog(v === "log")} options={[{ value: "lin", label: "Linear" }, { value: "log", label: "Log" }]} />}>
      <div className="cmp-legend" role="group" aria-label="Show or hide lines">
        {rows.map((r) => (
          <button key={r.key} className={`cmp-leg ${hidden.has(r.key) ? "off" : ""}`} onClick={() => toggle(r.key)} aria-pressed={!hidden.has(r.key)}
            onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)} title={`${hidden.has(r.key) ? "Show" : "Hide"} ${r.label}`}>
            <span className="cmp-tag" style={{ background: r.color }}>{r.tag}</span>
            {short(r.label, 30)}
            <span className={`cmp-leg-v num ${tone(r.s.totalReturn)}`}>{pct(r.s.totalReturn, 1)}</span>
          </button>
        ))}
      </div>
      <EChart option={option} height={chartH} />
    </Card>
  );
}

function RiskReturn({ rows }: { rows: Row[] }) {
  const p = usePalette();
  const chartH = typeof window !== "undefined" && window.innerHeight < 960 ? 330 : 400;
  const option = useMemo<EChartsOption>(() => {
    const ax = axisStyle(p);
    const pts = rows.filter((r) => isNum(r.s.cagr) && isNum(r.s.maxDrawdown));
    return {
      ...baseOption(p),
      grid: { left: 50, right: 22, top: 34, bottom: 46 },
      tooltip: { ...(baseOption(p).tooltip as any), trigger: "item", formatter: (it: any) => {
        const r: Row = it.data.row;
        return `<div style="font-weight:700;margin-bottom:6px">${r.label}</div>` + tooltipRow(r.color, "CAGR", pct(r.s.cagr)) +
          tooltipRow(r.color, "Max drawdown", pct(r.s.maxDrawdown)) + tooltipRow(r.color, "Sharpe", num(r.s.sharpe)) + tooltipRow(r.color, "Volatility", pct(r.s.volatility, 1, false));
      } },
      xAxis: { type: "value", name: "Max drawdown", nameLocation: "middle", nameGap: 28, nameTextStyle: { color: p.muted, fontSize: 12.5, fontWeight: 600 },
        scale: true, ...ax, axisLabel: { ...ax.axisLabel, formatter: (v: number) => `${v.toFixed(0)}%` } },
      yAxis: { type: "value", name: "CAGR", nameTextStyle: { color: p.muted, fontSize: 12.5, fontWeight: 600, align: "left" }, scale: true, ...ax,
        axisLabel: { ...ax.axisLabel, formatter: (v: number) => `${v.toFixed(0)}%` } },
      series: [{
        type: "scatter", symbolSize: 24,
        data: pts.map((r) => ({
          value: [Math.abs(r.s.maxDrawdown as number), r.s.cagr], row: r,
          symbol: r.kind === "bench" ? "roundRect" : "circle",
          itemStyle: { color: r.color, borderColor: p.surface, borderWidth: 2, opacity: r.kind === "strategy" ? 1 : 0.85 },
          label: { show: true, position: "inside", formatter: () => r.tag, color: "#fff", fontSize: r.tag.length > 1 ? 10 : 12, fontWeight: 800 },
        })),
      }] as any,
    };
  }, [rows, p]);
  return <EChart option={option} height={chartH + 96} />;
}

function DrawdownChart({ rows, t }: { rows: Row[]; t: number[] }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const ax = axisStyle(p);
    return {
      ...baseOption(p),
      animation: false,
      legend: { show: false },
      grid: { left: 50, right: 12, top: 12, bottom: 28 },
      tooltip: { ...(baseOption(p).tooltip as any), formatter: (items: any) => {
        const arr = (Array.isArray(items) ? items : [items]).slice().sort((a: any, b: any) => (a.value[1] ?? 0) - (b.value[1] ?? 0));
        return arr.length ? `<div style="font-weight:600;margin-bottom:6px">${date(arr[0].value[0] / 1000)}</div>` +
          arr.map((it: any) => tooltipRow(it.color, short(it.seriesName, 30), pct(it.value[1], 1))).join("") : "";
      } },
      xAxis: { type: "time", ...ax, splitLine: { show: false } },
      yAxis: { type: "value", max: 0, ...ax, axisLabel: { ...ax.axisLabel, formatter: (v: number) => `${v.toFixed(0)}%` } },
      dataZoom: [{ type: "inside", zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false }],
      series: rows.map((r) => ({
        name: r.label, type: "line", showSymbol: false, sampling: "lttb",
        data: (() => { const dd = ddOf(r.eq); return t.map((x, k) => [x * 1000, Math.round(dd[k] * 100) / 100]); })(),
        lineStyle: lineStyleOf(r, 1.6), itemStyle: { color: r.color }, emphasis: { focus: "series" },
      })) as any,
    };
  }, [rows, t, p]);
  return <EChart option={option} height={300} />;
}

function CorrMatrix({ rows }: { rows: Row[] }) {
  const m = useMemo(() => {
    const rets = rows.map((r) => returnsOf(r.eq));
    return rows.map((_, i) => rows.map((__, j) => (i === j ? 1 : corr(rets[i], rets[j]))));
  }, [rows]);
  const bg = (v: number | null) => {
    if (v == null) return "transparent";
    // High correlation = little diversification = warm; low or negative = cool.
    const k = Math.min(Math.abs(v), 1);
    return `color-mix(in srgb, var(${v >= 0 ? "--neg" : "--pos"}) ${Math.round(6 + k * 40)}%, var(--div-mid))`;
  };
  if (rows.length < 2) return <div className="muted" style={{ padding: "40px 0", textAlign: "center" }}>Needs at least two strategies</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <div className="heat corr" style={{ gridTemplateColumns: `minmax(104px, 1.5fr) repeat(${rows.length}, minmax(38px, 1fr))` }}>
        <div />
        {rows.map((r) => <div key={r.key} className="hh" title={r.label}><span className="cmp-tag" style={{ background: r.color }}>{r.tag}</span></div>)}
        {rows.map((r, i) => (
          <CorrRow key={r.key} r={r} i={i} vals={m[i]} bg={bg} rows={rows} />
        ))}
      </div>
    </div>
  );
}

function CorrRow({ r, i, vals, bg, rows }: { r: Row; i: number; vals: (number | null)[]; bg: (v: number | null) => string; rows: Row[] }) {
  return (
    <>
      <div className="corr-name" title={r.label}><span className="cmp-tag" style={{ background: r.color }}>{r.tag}</span>{short(r.label, 20)}</div>
      {vals.map((v, j) => (
        <div key={j} className={`hc ${i === j ? "diag" : ""}`} style={{ background: i === j ? undefined : bg(v) }}
          title={i === j ? r.label : `${r.label} vs ${rows[j].label}: ${num(v, 2)}`}>{i === j ? "" : num(v, 2)}</div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
type ColKey = "ret" | "cagr" | "sharpe" | "sortino" | "dd" | "vol" | "calmar" | "trades" | "win" | "pf" | "exp" | "fees";
const COLS: { key: ColKey; label: string; get: (r: Row) => number | null; fmt: (v: number | null, cur: string) => string; best: "max" | "min" | null; tradeOnly?: boolean }[] = [
  { key: "ret", label: "Return", get: (r) => r.s.totalReturn, fmt: (v) => pct(v), best: "max" },
  { key: "cagr", label: "CAGR", get: (r) => r.s.cagr, fmt: (v) => pct(v), best: "max" },
  { key: "sharpe", label: "Sharpe", get: (r) => r.s.sharpe, fmt: (v) => num(v), best: "max" },
  { key: "sortino", label: "Sortino", get: (r) => r.s.sortino, fmt: (v) => num(v), best: "max" },
  { key: "dd", label: "Max DD", get: (r) => r.s.maxDrawdown, fmt: (v) => pct(v), best: "max" },
  { key: "vol", label: "Volatility", get: (r) => r.s.volatility, fmt: (v) => pct(v, 1, false), best: "min" },
  { key: "calmar", label: "Calmar", get: (r) => r.calmar, fmt: (v) => num(v), best: "max" },
  { key: "trades", label: "Trades", get: (r) => r.s.trades, fmt: (v) => num(v, 0), best: null, tradeOnly: true },
  { key: "win", label: "Win rate", get: (r) => r.s.winRate, fmt: (v) => pct(v, 1, false), best: "max", tradeOnly: true },
  { key: "pf", label: "Profit factor", get: (r) => r.s.profitFactor, fmt: (v) => num(v), best: "max", tradeOnly: true },
  { key: "exp", label: "Exposure", get: (r) => r.s.exposure, fmt: (v) => pct(v, 0, false), best: null, tradeOnly: true },
  { key: "fees", label: "Fees", get: (r) => r.s.fees, fmt: (v, cur) => money(v, cur, true), best: "min", tradeOnly: true },
];

function RankTable({ rows, currency, onOpen }: { rows: Row[]; currency: string; onOpen: (e: CompareEntry) => void }) {
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 }>({ key: "sharpe", dir: -1 });
  const col = COLS.find((c) => c.key === sort.key)!;
  const strat = rows.filter((r) => r.kind === "strategy");
  const refs = rows.filter((r) => r.kind !== "strategy");
  const sorted = [...strat].sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (!isNum(x)) return 1;
    if (!isNum(y)) return -1;
    return (x - y) * sort.dir;
  });
  const bestOf = useMemo(() => {
    const out: Partial<Record<ColKey, number>> = {};
    if (strat.length < 2) return out;
    COLS.forEach((c) => {
      if (!c.best) return;
      const v = strat.map(c.get).filter(isNum);
      if (v.length) out[c.key] = c.best === "max" ? Math.max(...v) : Math.min(...v);
    });
    return out;
  }, [strat]);
  const head = (c: typeof COLS[number]) => (
    <th key={c.key} className="r" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : c.key === "vol" || c.key === "fees" ? 1 : -1 }))}
      aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {c.label}{sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} className="sort-ic" /> : <ArrowDown size={12} className="sort-ic" />)}
    </th>
  );
  const cell = (r: Row, c: typeof COLS[number]) => {
    if (c.tradeOnly && r.kind !== "strategy") return <td key={c.key} className="r dim">-</td>;
    const v = c.get(r);
    const best = r.kind === "strategy" && isNum(v) && bestOf[c.key] === v;
    const colored = c.key === "ret" || c.key === "cagr";
    return <td key={c.key} className={`r ${best ? "best" : ""} ${colored ? tone(v) : ""}`}>{best ? <span className="best-pill">{c.fmt(v, currency)}</span> : c.fmt(v, currency)}</td>;
  };
  return (
    <Card className="mt cmp-table" title="Ranking" sub={`Sorted by ${col.label} · best value in each column highlighted · click a header to sort`} bodyClass="table-wrap">
      <table className="tbl">
        <thead><tr><th style={{ width: 36 }}>#</th><th>Strategy</th>{COLS.map(head)}</tr></thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.key}>
              <td className="dim num">{i + 1}</td>
              <td className="cmp-name-cell" title={r.label}>
                <div className="cmp-name-wrap"><span className="cmp-swatch" style={{ background: r.color }} /><b>{short(r.label, 34)}</b>
                  <button className="btn btn-sm btn-ghost btn-icon cmp-open" onClick={() => r.entry && onOpen(r.entry)}
                    title="Open as a full backtest (trades, price chart, Monte Carlo)" aria-label={`Open ${r.label} as a backtest`}><ExternalLink size={14} /></button></div>
              </td>
              {COLS.map((c) => cell(r, c))}
            </tr>
          ))}
          {refs.map((r) => (
            <tr key={r.key} className="ref-row">
              <td className="dim" />
              <td className="cmp-name-cell" title={r.label}><span className="cmp-swatch dashed" style={{ color: r.color }} />{short(r.label, 34)}
                <span className="tag" style={{ marginLeft: 8 }}>{r.kind === "blend" ? "Blend" : "Benchmark"}</span></td>
              {COLS.map((c) => cell(r, c))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
function AnnualBars({ rows, t }: { rows: Row[]; t: number[] }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const per = rows.map((r) => periodReturns(t, r.eq, "Y"));
    const years = [...new Set(per.flatMap((m) => [...m.keys()]))].sort();
    return {
      ...baseOption(p),
      legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: p.text2, fontSize: 13, fontWeight: 600 }, itemWidth: 10, itemHeight: 10, formatter: (n: string) => short(n, 28) },
      grid: { left: 50, right: 10, top: 40, bottom: 28 },
      tooltip: { ...(baseOption(p).tooltip as any), axisPointer: { type: "shadow", shadowStyle: { color: p.grid + "80" } },
        formatter: (items: any) => {
          const arr = (Array.isArray(items) ? items : [items]).slice().sort((a: any, b: any) => (b.value ?? -1e9) - (a.value ?? -1e9));
          return arr.length ? `<div style="font-weight:600;margin-bottom:6px">${arr[0].axisValue}</div>` + arr.map((it: any) => tooltipRow(it.color, short(it.seriesName, 30), pct(it.value))).join("") : "";
        } },
      xAxis: { type: "category", data: years, ...axisStyle(p), splitLine: { show: false } },
      yAxis: { type: "value", ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" } },
      series: rows.map((r, i) => ({
        name: r.label, type: "bar", barMaxWidth: 16, barGap: "10%",
        itemStyle: { color: r.kind === "strategy" ? r.color : r.color + "99" },
        data: years.map((y) => { const v = per[i].get(y); return v == null ? null : Math.round(v * 100) / 100; }),
      })) as any,
    };
  }, [rows, t, p]);
  return <EChart option={option} height={360} />;
}

function ConsistencyTable({ rows, t }: { rows: Row[]; t: number[] }) {
  const data = useMemo(() => rows.map((r) => {
    const y = [...periodReturns(t, r.eq, "Y").entries()];
    const mo = [...periodReturns(t, r.eq, "M").entries()];
    const best = (a: [string, number][]) => a.reduce((b, x) => (x[1] > b[1] ? x : b), a[0]);
    const worst = (a: [string, number][]) => a.reduce((b, x) => (x[1] < b[1] ? x : b), a[0]);
    const mName = (k: string) => { const [yy, mm] = k.split("-"); return `${MONTHS[+mm - 1]} ${yy}`; };
    return {
      r, posY: y.length ? (y.filter((x) => x[1] > 0).length / y.length) * 100 : null, bestY: y.length ? best(y) : null, worstY: y.length ? worst(y) : null,
      posM: mo.length ? (mo.filter((x) => x[1] > 0).length / mo.length) * 100 : null,
      bestM: mo.length ? [mName(best(mo)[0]), best(mo)[1]] as [string, number] : null, worstM: mo.length ? [mName(worst(mo)[0]), worst(mo)[1]] as [string, number] : null,
      avgM: mo.length ? mo.reduce((s, x) => s + x[1], 0) / mo.length : null,
    };
  }), [rows, t]);
  return (
    <Card className="mt" title="Consistency" sub="How often each strategy made money, and its best and worst stretches" bodyClass="table-wrap">
      <table className="tbl">
        <thead><tr><th>Strategy</th><th className="r">Positive years</th><th className="r">Best year</th><th className="r">Worst year</th>
          <th className="r">Positive months</th><th className="r">Avg month</th><th className="r">Best month</th><th className="r">Worst month</th></tr></thead>
        <tbody>{data.map((d) => (
          <tr key={d.r.key} className={d.r.kind !== "strategy" ? "ref-row" : ""}>
            <td className="cmp-name-cell" title={d.r.label}><span className={`cmp-swatch ${d.r.kind !== "strategy" ? "dashed" : ""}`} style={{ background: d.r.kind === "strategy" ? d.r.color : undefined, color: d.r.color }} />
              {d.r.kind === "strategy" ? <b>{short(d.r.label, 34)}</b> : short(d.r.label, 34)}</td>
            <td className="r">{pct(d.posY, 0, false)}</td>
            <td className="r"><span className={tone(d.bestY?.[1])}>{pct(d.bestY?.[1], 1)}</span> <span className="dim">{d.bestY?.[0]}</span></td>
            <td className="r"><span className={tone(d.worstY?.[1])}>{pct(d.worstY?.[1], 1)}</span> <span className="dim">{d.worstY?.[0]}</span></td>
            <td className="r">{pct(d.posM, 0, false)}</td>
            <td className={`r ${tone(d.avgM)}`}>{pct(d.avgM, 2)}</td>
            <td className="r"><span className={tone(d.bestM?.[1])}>{pct(d.bestM?.[1], 1)}</span> <span className="dim">{d.bestM?.[0]}</span></td>
            <td className="r"><span className={tone(d.worstM?.[1])}>{pct(d.worstM?.[1], 1)}</span> <span className="dim">{d.worstM?.[0]}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
type Fmt = (v: any, cur: string) => string;
const METRIC_GROUPS: { title: string; items: [string, string, Fmt, "max" | "min" | null][] }[] = [
  { title: "Returns", items: [
    ["total_return_pct", "Total return", (v) => pct(v), "max"], ["cagr_pct", "CAGR", (v) => pct(v), "max"],
    ["net_profit", "Net profit", (v, c) => money(v, c, true), "max"], ["final_equity", "Final equity", (v, c) => money(v, c, true), "max"],
    ["excess_return_pct", "Excess vs benchmark", (v) => pct(v), "max"], ["alpha_pct", "Alpha (annual)", (v) => pct(v), "max"],
  ] },
  { title: "Risk", items: [
    ["volatility_pct", "Volatility", (v) => pct(v, 2, false), "min"], ["max_drawdown_pct", "Max drawdown", (v) => pct(v), "max"],
    ["avg_drawdown_pct", "Avg drawdown", (v) => pct(v), "max"], ["max_dd_duration_days", "Longest drawdown (days)", (v) => num(v, 0), "min"],
    ["ulcer_index", "Ulcer index", (v) => num(v), "min"], ["var_95_pct", "VaR 95%", (v) => pct(v), "max"], ["cvar_95_pct", "CVaR 95%", (v) => pct(v), "max"],
    ["beta", "Beta", (v) => num(v), null], ["correlation", "Correlation to benchmark", (v) => num(v), null],
  ] },
  { title: "Risk-adjusted", items: [
    ["sharpe", "Sharpe", (v) => num(v), "max"], ["sortino", "Sortino", (v) => num(v), "max"], ["calmar", "Calmar", (v) => num(v), "max"],
    ["omega", "Omega", (v) => num(v), "max"], ["recovery_factor", "Recovery factor", (v) => num(v), "max"], ["information_ratio", "Information ratio", (v) => num(v), "max"],
  ] },
  { title: "Trading", items: [
    ["trades", "Trades", (v) => num(v, 0), null], ["win_rate_pct", "Win rate", (v) => pct(v, 1, false), "max"],
    ["profit_factor", "Profit factor", (v) => num(v), "max"], ["payoff_ratio", "Payoff ratio", (v) => num(v), "max"],
    ["avg_trade_pct", "Avg trade", (v) => pct(v), "max"], ["best_trade_pct", "Best trade", (v) => pct(v), "max"], ["worst_trade_pct", "Worst trade", (v) => pct(v), "max"],
    ["avg_bars_held", "Avg bars held", (v) => num(v, 1), null], ["sqn", "SQN", (v) => num(v), "max"], ["expectancy", "Expectancy", (v, c) => money(v, c, true), "max"],
    ["exposure_pct", "Exposure", (v) => pct(v, 1, false), null], ["total_fees", "Fees", (v, c) => money(v, c, true), "min"],
  ] },
];

function AllMetrics({ res }: { res: CompareResult }) {
  const p = usePalette();
  const cols = res.strategies.map((e, i) => ({ e, color: p.cmp[i % 8] })).filter((c) => !c.e.error);
  if (res.blend) cols.push({ e: res.blend, color: p.text2 });
  const strat = cols.filter((c) => !c.e.is_blend);
  return (
    <Card title="All metrics" sub="Full period, computed by the engine · ★ marks the best strategy on each line" bodyClass="table-wrap">
      <table className="tbl cmp-metrics">
        <thead><tr><th>Metric</th>{cols.map((c) => (
          <th key={c.e.label} className="r" title={c.e.label}>
            <span className={`cmp-swatch ${c.e.is_blend ? "dashed" : ""}`} style={{ background: c.e.is_blend ? undefined : c.color, color: c.color }} />{short(c.e.label, 20)}
          </th>
        ))}</tr></thead>
        <tbody>
          {METRIC_GROUPS.map((g) => (
            <MetricGroup key={g.title} g={g} cols={cols} strat={strat} currency={res.currency} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function MetricGroup({ g, cols, strat, currency }: { g: typeof METRIC_GROUPS[number]; cols: { e: CompareEntry; color: string }[]; strat: { e: CompareEntry }[]; currency: string }) {
  const items = g.items.filter(([k]) => cols.some((c) => c.e.metrics[k] != null));
  if (!items.length) return null;
  return (
    <>
      <tr className="group-row"><td colSpan={cols.length + 1}>{g.title}</td></tr>
      {items.map(([k, l, f, dir]) => {
        const vals = strat.map((c) => c.e.metrics[k]).filter(isNum);
        const best = dir && vals.length > 1 ? (dir === "max" ? Math.max(...vals) : Math.min(...vals)) : null;
        const tradeOnly = g.title === "Trading";
        return (
          <tr key={k}>
            <td className="dim">{l}</td>
            {cols.map((c) => {
              const v = c.e.metrics[k];
              if (c.e.is_blend && tradeOnly) return <td key={c.e.label} className="r dim">-</td>;
              const isBest = !c.e.is_blend && best != null && v === best;
              return <td key={c.e.label} className={`r ${isBest ? "best" : ""}`}>{isBest ? <span className="best-pill">{f(v, currency)} ★</span> : f(v, currency)}</td>;
            })}
          </tr>
        );
      })}
    </>
  );
}
