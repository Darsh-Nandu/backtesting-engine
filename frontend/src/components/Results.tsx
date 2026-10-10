import { useMemo, useState } from "react";
import { AlertTriangle, Download, Sparkles } from "lucide-react";
import { BacktestResult, Trade } from "../api";
import { date, downloadCSV, downloadJSON, isNum, label, money, num, pct, tone } from "../format";
import { usePalette } from "../store";
import {
  EquityChart, Histogram, LineChart, MonteCarloFan, MonthlyHeatmap, PnlBars, ReturnsHistogram, TradeScatter,
  YearlyBars,
} from "./charts";
import { PriceChart } from "./PriceChart";
import { Card, Seg, Tabs, Toggle } from "./ui";

type Tab = "overview" | "price" | "trades" | "analytics" | "montecarlo" | "details";

export function Results({ res }: { res: BacktestResult }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [focusTrade, setFocusTrade] = useState<Trade | null>(null);
  const [symbol, setSymbol] = useState(Object.keys(res.symbols)[0]);
  const sym = res.symbols[symbol] ? symbol : Object.keys(res.symbols)[0];

  const openTrade = (t: Trade) => { setSymbol(t.symbol); setFocusTrade(t); setTab("price"); };

  return (
    <div>
      <Header res={res} />
      {res.warnings.length > 0 && (
        <div className="alert warn" style={{ marginBottom: 16 }}><AlertTriangle size={16} style={{ flex: "none", marginTop: 2 }} />
          <div>{res.warnings.map((w, i) => <div key={i}>{w}</div>)}</div></div>
      )}
      <Kpis res={res} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Overview" },
        { id: "price", label: "Chart" },
        { id: "trades", label: "Trades", count: res.trades.length },
        { id: "analytics", label: "Analysis" },
        { id: "montecarlo", label: "Monte Carlo" },
        { id: "details", label: "Details" },
      ]} />
      {tab === "overview" && <Overview res={res} />}
      {tab === "price" && (
        <PriceTab res={res} symbol={sym} setSymbol={(s) => { setSymbol(s); setFocusTrade(null); }} focusTrade={focusTrade} onTrade={setFocusTrade} />
      )}
      {tab === "trades" && <TradesTab res={res} onOpen={openTrade} />}
      {tab === "analytics" && <Analytics res={res} />}
      {tab === "montecarlo" && <MonteCarloTab res={res} />}
      {tab === "details" && <><MetricsTab res={res} /><div className="mt" /><LogsTab res={res} /></>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Header({ res }: { res: BacktestResult }) {
  const m = res.metrics;
  const syms = Object.keys(res.symbols);
  const params = Object.entries(res.strategy.params).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ");
  const symText = syms.length > 4 ? `${syms.slice(0, 3).join(", ")} +${syms.length - 3} more` : syms.join(", ");
  return (
    <div className="result-head">
      <div style={{ minWidth: 0 }}>
        <div className="result-title">{res.name && res.name !== res.strategy.name ? res.name : res.strategy.name}</div>
        <div className="result-meta">
          {res.market.code} · {symText} · {date(m.start)} - {date(m.end)} · {res.request.interval}{params && ` · ${params}`}
        </div>
        {res.rules_active?.length > 0 && (
          <div className="result-meta" style={{ marginTop: 2 }}>Rules: {res.rules_active.join(" · ")}</div>
        )}
      </div>
      <div className="result-actions">
        <button className="btn btn-sm btn-ghost" title="Download the full result as JSON" onClick={() => downloadJSON(`backtest_${res.id}.json`, res)}><Download size={14} />JSON</button>
        <button className="btn btn-sm btn-ghost" title="Download the equity curve as CSV" onClick={() => downloadCSV(`equity_${res.id}.csv`, res.series.t.map((t, i) => ({
          date: new Date(t * 1000).toISOString(), equity: res.series.equity[i], benchmark: res.series.benchmark?.[i] ?? "",
          drawdown_pct: res.series.drawdown[i], exposure_pct: res.series.exposure[i] })))}><Download size={14} />CSV</button>
      </div>
    </div>
  );
}

function Kpis({ res }: { res: BacktestResult }) {
  const m = res.metrics;
  const cur = res.currency;
  // Colour is reserved for the two headline return figures; everything else stays neutral.
  const items = [
    { label: "Total return", value: pct(m.total_return_pct), cls: tone(m.total_return_pct),
      sub: isNum(m.benchmark_return_pct) ? `Benchmark ${pct(m.benchmark_return_pct, 1)}` : money(m.net_profit, cur, true) },
    { label: "CAGR", value: pct(m.cagr_pct), cls: tone(m.cagr_pct),
      sub: isNum(m.benchmark_cagr_pct) ? `Benchmark ${pct(m.benchmark_cagr_pct, 1)}` : `${num(m.years, 1)} years` },
    { label: "Sharpe ratio", value: num(m.sharpe), sub: `Sortino ${num(m.sortino)}` },
    { label: "Max drawdown", value: pct(m.max_drawdown_pct), sub: `${num(m.max_dd_duration_days, 0)} days to recover` },
    { label: "Win rate", value: m.trades ? pct(m.win_rate_pct, 1, false) : "-", sub: `${m.trades} trades` },
    { label: "Profit factor", value: num(m.profit_factor), sub: `Payoff ${num(m.payoff_ratio)}` },
  ];
  return (
    <div className="kpis">
      {items.map((k) => (
        <div key={k.label} className="kpi">
          <div className="kpi-label">{k.label}</div>
          <div className={`kpi-value num ${k.cls || ""}`}>{k.value}</div>
          <div className="kpi-sub">{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Overview({ res }: { res: BacktestResult }) {
  const [log, setLog] = useState(false);
  const p = usePalette();
  const hasB = !!res.series.benchmark;
  return (
    <>
      <Card title="Equity curve" sub="Ctrl + scroll to zoom · drag to pan"
        actions={<>
          <div className="legend">
            <span><i className="line" style={{ background: p.series[0] }} />Strategy</span>
            {hasB && <span><i className="dash" style={{ color: p.bench }} />{res.benchmark_name}</span>}
            <span><i style={{ background: p.neg + "55" }} />Drawdown</span>
          </div>
          <Seg value={log ? "log" : "lin"} onChange={(v) => setLog(v === "log")} options={[{ value: "lin", label: "Linear" }, { value: "log", label: "Log" }]} />
        </>}>
        <EquityChart res={res} log={log} />
      </Card>
      <Card className="mt" title="Monthly returns" sub="Percent per month · yearly total on the right">
        <MonthlyHeatmap res={res} />
      </Card>
      <Card className="mt" title="Key statistics">
        <div className="metric-cols">
          {res.request.rules?.square_off ? (
            <div>
              <div className="metric-group-title">Trading days</div>
              <MetricList res={res} keys={["final_equity", "net_profit", "trading_days", "profitable_days_pct", "best_day_pct", "worst_day_pct"]} />
            </div>
          ) : (
            <div>
              <div className="metric-group-title">Returns & risk</div>
              <MetricList res={res} keys={["final_equity", "net_profit", "volatility_pct", "calmar", "var_95_pct", "exposure_pct"]} />
            </div>
          )}
          <div>
            <div className="metric-group-title">Trades</div>
            <MetricList res={res} keys={["avg_trade_pct", "avg_win_pct", "avg_loss_pct", "best_trade_pct", "worst_trade_pct", "avg_bars_held"]} />
          </div>
          <div>
            <div className="metric-group-title">{hasB ? `Versus ${res.benchmark_name}` : "Costs & shape"}</div>
            <MetricList res={res} keys={hasB
              ? ["alpha_pct", "beta", "correlation", "excess_return_pct", "total_fees", "fees_pct_of_capital"]
              : ["total_fees", "fees_pct_of_capital", "omega", "skew", "kurtosis", "sqn"]} />
          </div>
        </div>
      </Card>
      {res.per_symbol.length > 1 && (
        <Card className="mt" title="By symbol" bodyClass="table-wrap">
          <table className="tbl">
            <thead><tr><th>Symbol</th><th className="r">Trades</th><th className="r">Win rate</th><th className="r">Net P&L</th><th className="r">Profit factor</th><th className="r">Avg trade</th><th className="r">Buy & hold</th></tr></thead>
            <tbody>{res.per_symbol.map((s) => (
              <tr key={s.symbol}><td>{s.symbol}</td><td className="r">{s.trades}</td><td className="r">{pct(s.win_rate_pct, 1, false)}</td>
                <td className={`r ${tone(s.net_pnl)}`}>{money(s.net_pnl, res.currency)}</td><td className="r">{num(s.profit_factor)}</td>
                <td className="r">{pct(s.avg_trade_pct)}</td><td className="r">{pct(s.buy_hold_pct)}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      )}
    </>
  );
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
                <div className="row" style={{ justifyContent: "space-between", fontSize: 12.5 }}>
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
      {ev.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No rule had to step in.</div> : ev.map(([k, n]) => (
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
        <span className="muted" style={{ fontSize: 12 }}>
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
