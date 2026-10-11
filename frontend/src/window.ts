// Period filtering for a backtest result: slice every series to a window and
// recompute the headline statistics in the browser, so a single filter can
// update the KPI cards, charts and tables together.
import { BacktestResult } from "./api";

export type Period = "1Y" | "3Y" | "5Y" | "YTD" | "ALL";

export interface WindowStats {
  totalReturn: number | null; cagr: number | null; benchReturn: number | null; benchCagr: number | null;
  sharpe: number | null; sortino: number | null; maxDrawdown: number | null; ddDays: number | null;
  volatility: number | null; netProfit: number | null; trades: number; winRate: number | null;
  profitFactor: number | null; payoff: number | null; avgTrade: number | null; exposure: number | null;
  fees: number; years: number;
}

const DAY = 86400;

export function periodStartT(t: number[], p: Period): number | null {
  if (p === "ALL" || !t.length) return null;
  const last = t[t.length - 1];
  if (p === "YTD") return Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000;
  const years = p === "1Y" ? 1 : p === "3Y" ? 3 : 5;
  // Whole days, matching the exported dashboard's date-based filter.
  return Math.floor((last - years * 365.25 * DAY) / DAY) * DAY;
}

export const periodStart = (res: BacktestResult, p: Period) => periodStartT(res.series.t, p);

/** Periods that are strictly shorter than the data (so each one actually filters something). */
export function availablePeriodsT(t: number[]): Period[] {
  if (t.length < 2) return ["ALL"];
  const span = (t[t.length - 1] - t[0]) / (365.25 * DAY);
  const out: Period[] = [];
  if (span > 0.6) out.push("YTD");
  if (span > 1.2) out.push("1Y");
  if (span > 3.2) out.push("3Y");
  if (span > 5.2) out.push("5Y");
  return [...out, "ALL"];
}

export const availablePeriods = (res: BacktestResult) => availablePeriodsT(res.series.t);

function std(a: number[]) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** A copy of the result restricted to [from, end], with drawdown re-based on the window. */
export function sliceResult(res: BacktestResult, from: number | null): BacktestResult {
  if (from == null) return res;
  const t = res.series.t;
  let i0 = t.findIndex((x) => x >= from);
  if (i0 < 0) i0 = 0;
  const cut = <T,>(a: T[] | null | undefined) => (a ? a.slice(i0) : (a as any));
  const eq = res.series.equity.slice(i0);
  let peak = -Infinity;
  const dd = eq.map((v) => { peak = Math.max(peak, v); return (v / peak - 1) * 100; });
  // Rebase the benchmark to the strategy's equity at the window start so both lines start together.
  const b = res.series.benchmark ? res.series.benchmark.slice(i0) : null;
  const b0 = b && b.find((v) => v != null);
  const bench = b && b0 ? b.map((v) => (v == null ? v : (v / b0) * eq[0])) : b;
  const d0 = new Date(from * 1000);
  const ym0 = d0.getUTCFullYear() * 100 + d0.getUTCMonth() + 1;
  return {
    ...res,
    series: {
      ...res.series, t: cut(t), equity: eq, benchmark: bench as any, drawdown: dd,
      exposure: cut(res.series.exposure), cash: cut(res.series.cash),
      rolling_sharpe: cut(res.series.rolling_sharpe), rolling_vol: cut(res.series.rolling_vol),
    },
    returns_dist: res.returns_dist.slice(Math.max(i0 - 1, 0)),
    monthly: res.monthly.filter((m) => m.year * 100 + m.month >= ym0),
    yearly: res.yearly.filter((y) => y.year >= d0.getUTCFullYear()),
    trades: res.trades.filter((tr) => tr.exit_time >= from),
  };
}

export function windowStats(view: Pick<BacktestResult, "series" | "trades">): WindowStats {
  const { t, equity, benchmark, exposure } = view.series;
  const n = equity.length;
  const ppy = (view as any).config?.periods_per_year || 252;
  const years = n > 1 ? Math.max((t[n - 1] - t[0]) / (365.25 * DAY), 1 / 365) : 0;
  const ret = n > 1 ? equity[n - 1] / equity[0] - 1 : null;
  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = std(rets);
  const down = Math.sqrt(rets.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / Math.max(rets.length, 1));
  // Max drawdown and the longest stretch below a previous peak (calendar days).
  let peak = -Infinity, maxDd = 0, peakT = t[0] || 0, longest = 0;
  for (let i = 0; i < n; i++) {
    if (equity[i] >= peak) { peak = equity[i]; peakT = t[i]; }
    maxDd = Math.min(maxDd, equity[i] / peak - 1);
    longest = Math.max(longest, (t[i] - peakT) / DAY);
  }
  const b = benchmark && benchmark.length > 1 && benchmark[0] ? benchmark : null;
  const bRet = b ? (b[b.length - 1] as number) / (b[0] as number) - 1 : null;
  const tr = view.trades;
  const wins = tr.filter((x) => x.pnl > 0), losses = tr.filter((x) => x.pnl <= 0);
  const gp = wins.reduce((s, x) => s + x.pnl, 0), gl = -losses.reduce((s, x) => s + x.pnl, 0);
  const avgW = wins.length ? wins.reduce((s, x) => s + x.return_pct, 0) / wins.length : 0;
  const avgL = losses.length ? losses.reduce((s, x) => s + x.return_pct, 0) / losses.length : 0;
  const cagr = (r: number | null) => (r == null || years <= 0 ? null : ((1 + r) ** (1 / years) - 1) * 100);
  return {
    totalReturn: ret == null ? null : ret * 100, cagr: cagr(ret), benchReturn: bRet == null ? null : bRet * 100, benchCagr: cagr(bRet),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(ppy) : null, sortino: down > 0 ? (mean / down) * Math.sqrt(ppy) : null,
    maxDrawdown: maxDd * 100, ddDays: Math.round(longest), volatility: sd * Math.sqrt(ppy) * 100,
    netProfit: n > 1 ? equity[n - 1] - equity[0] : null, trades: tr.length,
    winRate: tr.length ? (wins.length / tr.length) * 100 : null, profitFactor: gl > 0 ? gp / gl : null,
    payoff: avgL ? avgW / Math.abs(avgL) : null, avgTrade: tr.length ? tr.reduce((s, x) => s + x.return_pct, 0) / tr.length : null,
    exposure: exposure.length ? (exposure.filter((x) => (x ?? 0) > 0.01).length / exposure.length) * 100 : null,
    fees: tr.reduce((s, x) => s + x.fees, 0), years,
  };
}

/** Full-period statistics straight from the engine (exact, incl. the risk-free rate). */
export function engineStats(res: Pick<BacktestResult, "metrics">): WindowStats {
  const m = res.metrics;
  return {
    totalReturn: m.total_return_pct, cagr: m.cagr_pct, benchReturn: m.benchmark_return_pct ?? null, benchCagr: m.benchmark_cagr_pct ?? null,
    sharpe: m.sharpe, sortino: m.sortino, maxDrawdown: m.max_drawdown_pct, ddDays: m.max_dd_duration_days, volatility: m.volatility_pct,
    netProfit: m.net_profit, trades: m.trades, winRate: m.win_rate_pct, profitFactor: m.profit_factor, payoff: m.payoff_ratio,
    avgTrade: m.avg_trade_pct, exposure: m.exposure_pct, fees: m.total_fees, years: m.years,
  };
}
