import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Download, FileJson, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Play, Sparkles, Table2 } from "lucide-react";
import type { EChartsOption } from "echarts";
import { BacktestResult, Trade } from "../api";
import { date, downloadCSV, downloadJSON, isNum, label, money, num, pct, tone } from "../format";
import { usePalette } from "../store";
import { availablePeriods, engineStats, Period, periodStart, sliceResult, WindowStats, windowStats } from "../window";
import { downloadDashboard } from "../exportDashboard";
import {
  EquityChart, Histogram, LineChart, MonteCarloFan, MonthlyHeatmap, PnlBars, ReturnsHistogram, TradeScatter,
  YearlyBars,
} from "./charts";
import { baseOption, EChart } from "./EChart";
import { PriceChart } from "./PriceChart";
import { Card, Seg, Spinner, Tabs, Toggle } from "./ui";

type Tab = "overview" | "price" | "trades" | "analytics" | "montecarlo" | "details";

export interface ResultsChrome {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onRun: () => void;
  running: boolean;
}

export function Results({ res, chrome }: { res: BacktestResult; chrome?: ResultsChrome }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [focusTrade, setFocusTrade] = useState<Trade | null>(null);
  const [symbol, setSymbol] = useState(Object.keys(res.symbols)[0]);
  const [period, setPeriod] = useState<Period>("ALL");
  const sym = res.symbols[symbol] ? symbol : Object.keys(res.symbols)[0];

  // One filter drives everything below it: KPIs, charts and tables are all computed for the window.
  const view = useMemo(() => sliceResult(res, periodStart(res, period)), [res, period]);
  const stats = useMemo(() => (period === "ALL" ? engineStats(res) : windowStats(view)), [res, view, period]);

  const openTrade = (t: Trade) => { setSymbol(t.symbol); setFocusTrade(t); setTab("price"); };

  return (
    <div>
      <Header res={res} period={period} setPeriod={setPeriod} chrome={chrome} />
      {res.warnings.length > 0 && (
        <div className="alert warn" style={{ marginBottom: 16 }}><AlertTriangle size={17} style={{ flex: "none", marginTop: 2 }} />
          <div>{res.warnings.map((w, i) => <div key={i}>{w}</div>)}</div></div>
      )}
      <KpiCards res={res} s={stats} period={period} />
      <StatStrip res={res} s={stats} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Overview" },
        { id: "price", label: "Chart" },
        { id: "trades", label: "Trades", count: view.trades.length },
        { id: "analytics", label: "Analysis" },
        { id: "montecarlo", label: "Monte Carlo" },
        { id: "details", label: "Details" },
      ]} />
      {tab === "overview" && <Overview res={view} onAllTrades={() => setTab("trades")} onTrade={openTrade} />}
      {tab === "price" && (
        <PriceTab res={res} symbol={sym} setSymbol={(s) => { setSymbol(s); setFocusTrade(null); }} focusTrade={focusTrade} onTrade={setFocusTrade} />
      )}
      {tab === "trades" && <TradesTab res={view} onOpen={openTrade} />}
      {tab === "analytics" && <Analytics res={view} />}
      {tab === "montecarlo" && <MonteCarloTab res={res} />}
      {tab === "details" && <><MetricsTab res={res} /><div className="mt" /><LogsTab res={res} /></>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
const PERIOD_LABEL: Record<Period, string> = { YTD: "YTD", "1Y": "1Y", "3Y": "3Y", "5Y": "5Y", ALL: "All" };

function Header({ res, period, setPeriod, chrome }: { res: BacktestResult; period: Period; setPeriod: (p: Period) => void; chrome?: ResultsChrome }) {
  const m = res.metrics;
  const syms = Object.keys(res.symbols);
  const st = res.request.stops || ({} as any);
  const rules = [...(res.rules_active || []),
    st.stop_loss_pct ? `Stop-loss ${st.stop_loss_pct}%` : "", st.take_profit_pct ? `Take-profit ${st.take_profit_pct}%` : "",
    st.trailing_pct ? `Trailing ${st.trailing_pct}%` : "", st.max_bars ? `Exit after ${st.max_bars} bars` : ""].filter(Boolean);
  const params = Object.entries(res.strategy.params).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ");
  return (
    <div className="result-head">
      <div className="rh-main">
        <div className="rh-title-row">
          <div className="result-title">{res.name && res.name !== res.strategy.name ? res.name : res.strategy.name}</div>
          <span className="tag accent">{res.market.code}</span>
          {syms.slice(0, 4).map((s) => <span key={s} className="tag">{s.replace(/\.(NS|BO)$/, "")}</span>)}
          {syms.length > 4 && <span className="tag">+{syms.length - 4}</span>}
        </div>
        <div className="result-meta">
          {date(m.start)} - {date(m.end)} · {res.request.interval}{params && ` · ${params}`}{rules.length > 0 && ` · ${rules.join(" · ")}`}
        </div>
      </div>
      <div className="result-actions">
        <div className="rh-filter" title="Period: recomputes KPIs, charts and tables for the selected window">
          <span className="rh-filter-label">Period</span>
          <Seg value={period} onChange={setPeriod} options={availablePeriods(res).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} />
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
        <ExportMenu res={res} />
      </div>
    </div>
  );
}

function ExportMenu({ res }: { res: BacktestResult }) {
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
  return (
    <div className="menu" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><Download size={17} />Export<ChevronDown size={15} /></button>
      {open && (
        <div className="menu-pop" role="menu">
          {item(<LayoutDashboard size={18} />, "Dashboard (HTML)", "Self-contained, shareable report", () => downloadDashboard(res))}
          {item(<Table2 size={18} />, "Equity curve (CSV)", "Daily equity, benchmark, drawdown", () => downloadCSV(`equity_${res.id}.csv`, res.series.t.map((t, i) => ({
            date: new Date(t * 1000).toISOString(), equity: res.series.equity[i], benchmark: res.series.benchmark?.[i] ?? "",
            drawdown_pct: res.series.drawdown[i], exposure_pct: res.series.exposure[i] }))))}
          {item(<FileJson size={18} />, "Full result (JSON)", "Every metric, trade and series", () => downloadJSON(`backtest_${res.id}.json`, res))}
        </div>
      )}
    </div>
  );
}

function KpiCards({ res, s, period }: { res: BacktestResult; s: WindowStats; period: Period }) {
  const cur = res.currency;
  const excess = isNum(s.totalReturn) && isNum(s.benchReturn) ? s.totalReturn - s.benchReturn : null;
  const scope = period === "ALL" ? "full period" : PERIOD_LABEL[period];
  const cards = [
    { label: "Total return", value: pct(s.totalReturn), cls: tone(s.totalReturn),
      delta: excess, deltaText: excess == null ? null : `${pct(excess, 1)} vs ${res.benchmark_name || "benchmark"}`,
      sub: `${money(s.netProfit, cur, true)} net profit · ${scope}` },
    { label: "CAGR", value: pct(s.cagr), cls: tone(s.cagr),
      delta: isNum(s.cagr) && isNum(s.benchCagr) ? s.cagr - s.benchCagr : null,
      deltaText: isNum(s.cagr) && isNum(s.benchCagr) ? `${pct(s.cagr - s.benchCagr, 1)} vs benchmark` : null,
      sub: `${num(s.years, 1)} years compounded` },
    { label: "Sharpe ratio", value: num(s.sharpe), cls: "", delta: null, deltaText: null,
      sub: `Sortino ${num(s.sortino)} · volatility ${pct(s.volatility, 1, false)}` },
    { label: "Max drawdown", value: pct(s.maxDrawdown), cls: "", delta: null, deltaText: null,
      sub: `Longest recovery ${num(s.ddDays, 0)} days` },
  ];
  return (
    <div className="kpis kpi-cards">
      {cards.map((k) => (
        <div key={k.label} className="kpi">
          <div className="kpi-label">{k.label}</div>
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

function StatStrip({ res, s }: { res: BacktestResult; s: WindowStats }) {
  const items: [string, string][] = [
    ["Win rate", s.trades ? pct(s.winRate, 1, false) : "-"], ["Profit factor", num(s.profitFactor)], ["Trades", num(s.trades, 0)],
    ["Avg trade", pct(s.avgTrade)], ["Payoff", num(s.payoff)], ["Exposure", pct(s.exposure, 0, false)], ["Fees", money(s.fees, res.currency, true)],
  ];
  return (
    <div className="stat-strip">
      {items.map(([k, v]) => <div key={k} className="stat"><span className="stat-k">{k}</span><span className="stat-v num">{v}</span></div>)}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Overview({ res, onAllTrades, onTrade }: { res: BacktestResult; onAllTrades: () => void; onTrade: (t: Trade) => void }) {
  const [log, setLog] = useState(false);
  const p = usePalette();
  const hasB = !!res.series.benchmark;
  const recent = useMemo(() => [...res.trades].sort((a, b) => b.exit_time - a.exit_time).slice(0, 8), [res.trades]);
  // Fit the primary chart to the screen: short laptop screens get a shorter chart instead of a scroll.
  const chartH = typeof window !== "undefined" && window.innerHeight < 960 ? 330 : 420;
  return (
    <>
      <div className="ov-grid">
        <Card title="Equity curve" sub="Ctrl + scroll to zoom"
          actions={<>
            <div className="legend">
              <span><i className="line" style={{ background: p.series[0] }} />Strategy</span>
              {hasB && <span><i className="dash" style={{ color: p.bench }} />{res.benchmark_name}</span>}
              <span><i style={{ background: p.neg + "55" }} />Drawdown</span>
            </div>
            <Seg value={log ? "log" : "lin"} onChange={(v) => setLog(v === "log")} options={[{ value: "lin", label: "Linear" }, { value: "log", label: "Log" }]} />
          </>}>
          <EquityChart res={res} log={log} height={chartH} />
        </Card>
        <Card title="Annual returns" sub={hasB ? `vs ${res.benchmark_name}` : undefined}>
          <YearlyBars res={res} height={chartH} />
        </Card>
      </div>
      <div className="ov-grid mt">
        <Card title="Monthly returns" sub="% per month · yearly total on the right">
          <MonthlyHeatmap res={res} />
        </Card>
        <Card title="How trades ended" sub={`${res.trades.length} closed trades`}>
          <ExitDonut res={res} />
          <div className="mini-stats">
            {res.per_symbol.length > 1 ? res.per_symbol.slice(0, 5).map((s) => (
              <div key={s.symbol} className="metric-row"><span className="k">{s.symbol}</span>
                <span className={`v ${tone(s.net_pnl)}`}>{money(s.net_pnl, res.currency, true)}</span></div>
            )) : (
              <>
                <div className="metric-row"><span className="k">Best trade</span><span className="v">{pct(res.metrics.best_trade_pct)}</span></div>
                <div className="metric-row"><span className="k">Worst trade</span><span className="v">{pct(res.metrics.worst_trade_pct)}</span></div>
                <div className="metric-row"><span className="k">Avg bars held</span><span className="v">{num(res.metrics.avg_bars_held, 1)}</span></div>
              </>
            )}
          </div>
        </Card>
      </div>
      <Card className="mt" title="Recent trades" sub="Most recent exits in the selected period · click a row to see it on the chart"
        actions={<button className="btn btn-sm" onClick={onAllTrades}>View all {res.trades.length} trades</button>} bodyClass="table-wrap">
        <TradeTable trades={recent} currency={res.currency} onRow={onTrade} />
      </Card>
    </>
  );
}

function ExitDonut({ res }: { res: BacktestResult }) {
  const p = usePalette();
  const option = useMemo<EChartsOption>(() => {
    const counts: Record<string, number> = {};
    res.trades.forEach((t) => (counts[t.exit_reason] = (counts[t.exit_reason] || 0) + 1));
    const data = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v], i) => ({ name: label(k), value: v, itemStyle: { color: [p.series[0], p.series[1], p.series[2], p.series[6], p.series[4], p.bench][i] } }));
    return {
      ...baseOption(p),
      tooltip: { ...(baseOption(p).tooltip as any), trigger: "item", formatter: (it: any) => `${it.name}<br/><b>${it.value}</b> trades (${it.percent}%)` },
      legend: { orient: "vertical", right: 0, top: "middle", textStyle: { color: p.text2, fontSize: 13.5, fontWeight: 600 }, itemWidth: 10, itemHeight: 10, icon: "circle" },
      series: [{ type: "pie", radius: ["58%", "82%"], center: ["32%", "50%"], avoidLabelOverlap: true, label: { show: false },
        itemStyle: { borderColor: p.surface, borderWidth: 3 }, data }],
    };
  }, [res, p]);
  if (!res.trades.length) return <div className="muted" style={{ padding: "40px 0", textAlign: "center" }}>No closed trades in this period</div>;
  return <EChart option={option} height={200} />;
}

/* ------------------------------------------------------------------ */
function PriceTab({ res, symbol, setSymbol, focusTrade, onTrade }: {
  res: BacktestResult; symbol: string; setSymbol: (s: string) => void; focusTrade: Trade | null; onTrade: (t: Trade) => void;
}) {
  const [showTrades, setShowTrades] = useState(true);
  const [showVol, setShowVol] = useState(true);
  const syms = Object.keys(res.symbols);
  const trades = res.trades.filter((t) => t.symbol === symbol);
  return (
    <>
      <Card title="Price, indicators & executions"
        sub="▲ entries · ● exits coloured by outcome · drag panes to resize"
        actions={<>
          <Toggle checked={showTrades} onChange={setShowTrades} label="Trades" />
          <Toggle checked={showVol} onChange={setShowVol} label="Volume" />
          {syms.length > 1 && (
            <select className="select" style={{ width: 170, height: 30 }} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {syms.map((s) => <option key={s}>{s}</option>)}
            </select>
          )}
        </>}>
        <PriceChart res={res} symbol={symbol} showTrades={showTrades} showVolume={showVol} focusTrade={focusTrade} />
      </Card>
      <Card className="mt" title={`Trades in ${symbol}`} sub="Click a row to zoom the chart to that trade" bodyClass="table-wrap">
        <TradeTable trades={trades} currency={res.currency} onRow={onTrade} selected={focusTrade?.id} compact />
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ */
function TradesTab({ res, onOpen }: { res: BacktestResult; onOpen: (t: Trade) => void }) {
  const [side, setSide] = useState<"all" | "Long" | "Short">("all");
  const [outcome, setOutcome] = useState<"all" | "win" | "loss">("all");
  const [symbol, setSymbol] = useState("all");
  const filtered = res.trades.filter((t) => (side === "all" || t.side === side) && (symbol === "all" || t.symbol === symbol)
    && (outcome === "all" || (outcome === "win" ? t.pnl > 0 : t.pnl <= 0)));
  const reasons = Object.entries(res.exit_reasons).sort((a, b) => b[1] - a[1]);
  const total = res.trades.length || 1;
  const p = usePalette();
  return (
    <>
      <div className="charts-2">
        <Card title="Trade P&L sequence" sub="Bars: per-trade P&L · line: cumulative">
          <PnlBars trades={res.trades} currency={res.currency} />
        </Card>
        <Card title="Exit reasons">
          <div className="stack" style={{ gap: 10, paddingTop: 4 }}>
            {reasons.length === 0 && <span className="muted">No closed trades</span>}
            {reasons.map(([r, n], i) => (
              <div key={r}>
                <div className="row" style={{ justifyContent: "space-between", fontSize: 14.5 }}>
                  <span className="dim">{label(r)}</span><span className="num">{n} <span className="muted">· {num((n / total) * 100, 0)}%</span></span>
                </div>
                <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${(n / total) * 100}%` }} /></div>
              </div>
            ))}
          </div>
          <RuleActivity res={res} />
        </Card>
      </div>
      <Card className="mt" title="Trade log" sub={`${filtered.length} of ${res.trades.length} trades`}
        actions={<>
          {Object.keys(res.symbols).length > 1 && (
            <select className="select" style={{ width: 150, height: 30 }} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              <option value="all">All symbols</option>{Object.keys(res.symbols).map((s) => <option key={s}>{s}</option>)}
            </select>
          )}
          <Seg value={side} onChange={setSide} options={[{ value: "all", label: "All" }, { value: "Long", label: "Long" }, { value: "Short", label: "Short" }]} />
          <Seg value={outcome} onChange={setOutcome} options={[{ value: "all", label: "All" }, { value: "win", label: "Winners" }, { value: "loss", label: "Losers" }]} />
          <button className="btn btn-sm" onClick={() => downloadCSV(`trades_${res.id}.csv`, filtered.map((t) => ({ ...t,
            entry_time: new Date(t.entry_time * 1000).toISOString(), exit_time: new Date(t.exit_time * 1000).toISOString() })))}>
            <Download size={14} />CSV</button>
        </>}
        bodyClass="table-wrap">
        <TradeTable trades={filtered} currency={res.currency} onRow={onOpen} />
      </Card>
    </>
  );
}

const RULE_EVENTS: Record<string, string> = {
  blocked_long_signal: "Buy signals ignored · short only",
  blocked_short_signal: "Sell signals ignored · shorting off",
  square_off: "Days ended with a square-off",
  daily_loss_limit: "Daily loss limit hit",
  daily_profit_target: "Daily profit target hit",
  max_drawdown_stop: "Drawdown kill switch triggered",
  blocked_entry_window: "Entries skipped · outside entry window",
  blocked_after_square_off: "Entries skipped · after square-off",
  blocked_max_trades_per_day: "Entries skipped · daily trade limit",
  blocked_max_open_positions: "Entries skipped · max open positions",
  blocked_cooldown: "Entries skipped · cooldown",
  blocked_daily_stop: "Entries skipped · paused for the day",
  blocked_drawdown_stop: "Entries skipped · kill switch",
  capped_daily_capital: "Orders reduced · daily capital limit",
  capped_max_position: "Orders reduced · position size cap",
};

function RuleActivity({ res }: { res: BacktestResult }) {
  const ev = Object.entries(res.rule_events || {}).sort((a, b) => b[1] - a[1]);
  if (!res.rules_active?.length) return null;
  return (
    <div style={{ marginTop: 22 }}>
      <div className="metric-group-title">Rule activity</div>
      {ev.length === 0 ? <div className="muted" style={{ fontSize: 15 }}>No rule had to step in.</div> : ev.map(([k, n]) => (
        <div key={k} className="metric-row"><span className="k">{RULE_EVENTS[k] || label(k)}</span><span className="v">{num(n, 0)}</span></div>
      ))}
    </div>
  );
}

type SortKey = keyof Trade;
function TradeTable({ trades, currency, onRow, selected, compact }: {
  trades: Trade[]; currency: string; onRow?: (t: Trade) => void; selected?: number; compact?: boolean;
}) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "id", dir: 1 });
  const rows = useMemo(() => [...trades].sort((a, b) => {
    const x = a[sort.k] as any, y = b[sort.k] as any;
    return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
  }), [trades, sort]);
  const th = (k: SortKey, text: string, r = true) => (
    <th className={r ? "r" : ""} onClick={() => setSort((s) => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : -1 }))}>
      {text}{sort.k === k ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );
  if (!trades.length) return <div className="empty" style={{ padding: 40 }}>No trades</div>;
  return (
    <table className="tbl">
      <thead><tr>
        {th("id", "#", false)}{!compact && th("symbol", "Symbol", false)}{th("side", "Side", false)}
        {th("entry_time", "Entry", false)}{th("exit_time", "Exit", false)}{th("entry_price", "Entry px")}{th("exit_price", "Exit px")}
        {th("qty", "Qty")}{th("pnl", "P&L")}{th("return_pct", "Return")}{th("bars_held", "Bars")}
        {!compact && th("mae_pct", "MAE")}{!compact && th("mfe_pct", "MFE")}{!compact && th("fees", "Fees")}{th("exit_reason", "Exit", false)}
      </tr></thead>
      <tbody>
        {rows.slice(0, 2000).map((t) => (
          <tr key={t.id} onClick={() => onRow?.(t)} className={selected === t.id ? "sel" : ""} style={{ cursor: onRow ? "pointer" : undefined }}>
            <td className="muted">{t.id}</td>
            {!compact && <td>{t.symbol}</td>}
            <td className="dim">{t.side}</td>
            <td>{date(t.entry_time)}</td><td>{date(t.exit_time)}</td>
            <td className="r">{num(t.entry_price)}</td><td className="r">{num(t.exit_price)}</td>
            <td className="r">{num(t.qty, t.qty % 1 ? 4 : 0)}</td>
            <td className={`r ${tone(t.pnl)}`}>{money(t.pnl, currency)}</td>
            <td className="r">{pct(t.return_pct)}</td>
            <td className="r">{t.bars_held}</td>
            {!compact && <td className="r dim">{pct(t.mae_pct, 1)}</td>}
            {!compact && <td className="r dim">{pct(t.mfe_pct, 1)}</td>}
            {!compact && <td className="r muted">{money(t.fees, currency)}</td>}
            <td className="muted">{label(t.exit_reason)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
function Analytics({ res }: { res: BacktestResult }) {
  const p = usePalette();
  const [scatterX, setScatterX] = useState<"bars_held" | "mae_pct" | "mfe_pct">("bars_held");
  return (
    <>
      <div className="charts-2">
        <Card title="Annual returns" sub={res.series.benchmark ? `Strategy vs ${res.benchmark_name}` : "Strategy"}>
          <YearlyBars res={res} height={260} />
        </Card>
        <Card title="Rolling Sharpe ratio" sub={`${res.series.rolling_window}-bar window`}>
          <LineChart t={res.series.t} values={res.series.rolling_sharpe} name="Rolling Sharpe" color={p.series[0]} height={260} refLine={0} />
        </Card>
      </div>
      <div className="charts-2 mt">
        <Card title="Distribution of period returns" sub="Daily (per-bar) returns with mean and 95% VaR">
          <ReturnsHistogram res={res} />
        </Card>
        <Card title={`Rolling Sharpe (${res.series.rolling_window} bars)`} sub="Is the edge stable through time?">
          <LineChart t={res.series.t} values={res.series.rolling_sharpe} name="Rolling Sharpe" color={p.series[6]} height={260} refLine={0} />
        </Card>
      </div>
      <div className="charts-2 mt">
        <Card title="Rolling volatility" sub="Annualised, %">
          <LineChart t={res.series.t} values={res.series.rolling_vol} name="Volatility" color={p.series[3]} unit="%" height={240} area />
        </Card>
        <Card title="Market exposure" sub="Gross exposure as % of equity">
          <LineChart t={res.series.t} values={res.series.exposure} name="Exposure" color={p.series[2]} unit="%" height={240} area />
        </Card>
      </div>
      <div className="charts-2 mt">
        <Card title="Trade return map" sub="Each dot is a trade"
          actions={<Seg value={scatterX} onChange={setScatterX} options={[{ value: "bars_held", label: "Duration" }, { value: "mae_pct", label: "MAE" }, { value: "mfe_pct", label: "MFE" }]} />}>
          <TradeScatter trades={res.trades} x={scatterX} />
        </Card>
        <Card title="Worst drawdowns" bodyClass="table-wrap">
          <table className="tbl">
            <thead><tr><th>Depth</th><th>Start</th><th>Trough</th><th>Recovered</th><th className="r">Days</th></tr></thead>
            <tbody>{res.drawdowns.map((d, i) => (
              <tr key={i}><td>{pct(d.depth_pct)}</td><td>{date(d.start)}</td><td>{date(d.trough)}</td>
                <td>{d.end ? date(d.end) : <span className="muted">Not yet</span>}</td><td className="r">{d.days}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
function MonteCarloTab({ res }: { res: BacktestResult }) {
  const [method, setMethod] = useState<"returns" | "trades">("returns");
  const mc = res.monte_carlo[method];
  if (!mc || !mc.bands) {
    return <div className="card empty"><Sparkles size={28} /><h2>Not enough data</h2><p>Monte Carlo needs at least 10 bars (returns) or 5 closed trades (trade resampling).</p></div>;
  }
  const init = res.metrics.initial_capital;
  const tiles = [
    { k: "Median outcome", v: pct(mc.final_return_pct.p50), c: tone(mc.final_return_pct.p50) },
    { k: "Bad case (5%)", v: pct(mc.final_return_pct.p5), c: "" },
    { k: "Good case (95%)", v: pct(mc.final_return_pct.p95), c: "" },
    { k: "Median drawdown", v: pct(mc.max_dd_pct.p50), c: "" },
    { k: "Deep drawdown", v: pct(mc.max_dd_pct.p95), c: "" },
    { k: "Chance of a loss", v: pct(mc.prob_loss_pct, 1, false), c: "" },
  ];

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <Seg value={method} onChange={setMethod} options={[{ value: "returns", label: "Block bootstrap of returns" }, { value: "trades", label: "Resample trades" }]} />
        <span className="muted" style={{ fontSize: 14 }}>
          {mc.n_sims} simulations · {method === "returns" ? "20-bar blocks keep volatility clustering" : "trade order and frequency randomised"}
        </span>
      </div>
      <div className="kpis">
        {tiles.map((t) => (
          <div key={t.k} className="kpi"><div className="kpi-label">{t.k}</div><div className={`kpi-value num ${t.c}`}>{t.v}</div></div>
        ))}
      </div>
      <Card title="Simulated equity paths" sub="Bands show the middle 50% and 90% of outcomes · dashed lines mark the 5th and 95th percentiles">
        <MonteCarloFan mc={mc} actual={method === "returns" ? { t: res.series.t, equity: res.series.equity } : undefined} currency={res.currency} />
      </Card>
      <div className="charts-2 mt">
        <Card title="Final return distribution">
          <Histogram counts={mc.return_hist.counts} edges={mc.return_hist.edges}
            markers={[{ value: (res.metrics.final_equity / init - 1) * 100, label: "actual" }]} />
        </Card>
        <Card title="Max drawdown distribution">
          <Histogram counts={mc.dd_hist.counts} edges={mc.dd_hist.edges} neutral markers={[{ value: res.metrics.max_drawdown_pct, label: "actual" }]} />
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
const GROUPS: Record<string, string[]> = {
  Returns: ["initial_capital", "final_equity", "net_profit", "total_return_pct", "cagr_pct", "best_period_pct", "worst_period_pct", "exposure_pct", "avg_leverage"],
  Risk: ["volatility_pct", "max_drawdown_pct", "avg_drawdown_pct", "max_dd_duration_days", "max_dd_duration_bars", "ulcer_index", "var_95_pct", "cvar_95_pct", "skew", "kurtosis"],
  "Risk-adjusted": ["sharpe", "sortino", "calmar", "omega", "recovery_factor", "tail_ratio", "sqn", "kelly_pct"],
  Benchmark: ["benchmark_return_pct", "benchmark_cagr_pct", "benchmark_max_dd_pct", "excess_return_pct", "alpha_pct", "beta", "correlation", "information_ratio", "tracking_error_pct"],
  Trades: ["trades", "long_trades", "short_trades", "win_rate_pct", "profit_factor", "payoff_ratio", "expectancy", "avg_trade_pct", "avg_win_pct", "avg_loss_pct", "best_trade_pct", "worst_trade_pct", "avg_bars_held", "max_consecutive_wins", "max_consecutive_losses", "gross_profit", "gross_loss"],
  "Trading days": ["trading_days", "profitable_days_pct", "avg_day_return_pct", "best_day_pct", "worst_day_pct"],
  Costs: ["total_fees", "fees_pct_of_capital"],
};
const MONEY = new Set(["initial_capital", "final_equity", "net_profit", "expectancy", "gross_profit", "gross_loss", "total_fees"]);
const NAMES: Record<string, string> = {
  cagr_pct: "CAGR", var_95_pct: "VaR 95% (per bar)", cvar_95_pct: "CVaR 95% (per bar)", sqn: "SQN", kelly_pct: "Kelly fraction",
  trading_days: "Active trading days", profitable_days_pct: "Profitable days", avg_day_return_pct: "Average day",
  best_day_pct: "Best day", worst_day_pct: "Worst day",
  max_dd_duration_days: "Longest drawdown (days)", fees_pct_of_capital: "Fees (% of capital)", alpha_pct: "Alpha (annual)", max_dd_duration_bars: "Longest drawdown (bars)", mae_pct: "MAE",
};

function fmtMetric(k: string, v: any, cur: string) {
  if (v == null) return "-";
  if (MONEY.has(k)) return money(v, cur);
  if (k.endsWith("_pct")) return pct(v, 2, ["total_return_pct", "cagr_pct", "excess_return_pct", "alpha_pct", "avg_trade_pct", "best_trade_pct", "worst_trade_pct", "best_period_pct", "worst_period_pct"].includes(k));
  if (typeof v === "number") return Number.isInteger(v) ? num(v, 0) : num(v, 3);
  return String(v);
}
function metricTone(k: string, v: any) {
  if (!isNum(v)) return "";
  if (["total_return_pct", "cagr_pct", "net_profit"].includes(k)) return tone(v);
  return "";
}

function MetricList({ res, keys }: { res: BacktestResult; keys: string[] }) {
  return (
    <div>
      {keys.filter((k) => k in res.metrics).map((k) => (
        <div key={k} className="metric-row"><span className="k">{NAMES[k] || label(k)}</span>
          <span className={`v ${metricTone(k, res.metrics[k])}`}>{fmtMetric(k, res.metrics[k], res.currency)}</span></div>
      ))}
    </div>
  );
}

function MetricsTab({ res }: { res: BacktestResult }) {
  return (
    <div className="metric-grid">
      {Object.entries(GROUPS).map(([g, keys]) => keys.some((k) => k in res.metrics) && (
        <Card key={g} title={g}><MetricList res={res} keys={keys} /></Card>
      ))}
      <Card title="Configuration">
        {[
          ["Strategy", res.strategy.name], ["Parameters", Object.entries(res.strategy.params).map(([k, v]) => `${k}=${v}`).join(", ") || "-"],
          ["Cost model", res.request.cost?.kind || `auto (${res.market.cost_model})`], ["Slippage", `${res.request.slippage_pct}%`],
          ["Fills", res.request.fill_on === "close" ? "Same bar close" : "Next bar open"], ["Sizing", `${res.request.sizing?.mode} ${res.request.sizing?.value}`],
          ["Leverage", `${res.request.leverage}×`],
          ["Stops", `SL ${res.request.stops?.stop_loss_pct || 0}% · TP ${res.request.stops?.take_profit_pct || 0}% · Trail ${res.request.stops?.trailing_pct || 0}%`],
          ["Trading rules", res.rules_active?.length ? res.rules_active.join(" · ") : "None"],
        ].map(([k, v]) => <div key={k} className="metric-row"><span className="k">{k}</span><span className="v" style={{ textAlign: "right", whiteSpace: "normal" }}>{v}</span></div>)}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
function LogsTab({ res }: { res: BacktestResult }) {
  return (
    <div className="charts-2">
      <Card title="Order fills" sub={`${res.fills.length} executions (latest 5000)`} bodyClass="table-wrap">
        <table className="tbl">
          <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Fee</th><th>Reason</th></tr></thead>
          <tbody>{res.fills.slice(-1000).reverse().map((f, i) => (
            <tr key={i}><td>{date(f.time, res.request.interval !== "1d")}</td><td>{f.symbol}</td>
              <td className="dim">{f.side === "BUY" ? "Buy" : "Sell"}</td>
              <td className="r">{num(f.qty, f.qty % 1 ? 4 : 0)}</td><td className="r">{num(f.price)}</td><td className="r muted">{num(f.fee)}</td><td className="dim">{label(f.reason)}</td></tr>
          ))}</tbody>
        </table>
      </Card>
      <Card title="Strategy log" sub="Messages from self.log() in your strategy" bodyClass="table-wrap">
        {res.logs.length === 0 ? <div className="empty" style={{ padding: 40 }}>No log messages. Call <code>self.log("…")</code> inside <code>next()</code>.</div> : (
          <table className="tbl"><tbody>{res.logs.map((l, i) => (
            <tr key={i}><td className="muted">{l.time.slice(0, 16).replace("T", " ")}</td><td>{l.symbol}</td><td className="mono" style={{ whiteSpace: "pre-wrap" }}>{l.msg}</td></tr>
          ))}</tbody></table>
        )}
        {res.open_positions.length > 0 && <div className="alert info" style={{ margin: 12 }}>Open positions at end: {res.open_positions.map((p) => `${p.symbol} ${p.qty}`).join(", ")}</div>}
      </Card>
    </div>
  );
}
