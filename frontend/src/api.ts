// Typed client for the QuantForge REST API.

export interface Market {
  code: string; name: string; country: string; currency: string; symbol: string; suffix: string;
  benchmark: string; cost_model: string; fractional: boolean; trading_days: number; popular: string[];
}
export interface ParamSpec { default: any; type: "int" | "float" | "bool" | "str"; min?: number; max?: number; step?: number }
export interface StrategyInfo {
  id: string; name: string; category: string; description: string; per_asset: boolean;
  params: Record<string, ParamSpec>; source?: string | null; broken?: boolean; long_only?: boolean;
}
export interface Meta {
  markets: Market[]; intervals: string[]; intraday_limits: Record<string, number>;
  cost_models: { id: string; label: string }[]; objectives: { id: string; label: string }[];
  indicators: string[]; template: string;
}

export interface TradingRules {
  direction: "both" | "long" | "short";
  sizing_base: "compound" | "fixed";
  square_off: boolean;
  square_off_time: string;
  entry_start: string;
  entry_end: string;
  daily_capital_limit: number;
  daily_capital_mode: "amount" | "pct";
  max_trades_per_day: number;
  max_open_positions: number;
  max_position_pct: number;
  daily_loss_limit_pct: number;
  daily_profit_target_pct: number;
  max_drawdown_stop_pct: number;
  cooldown_bars: number;
}

export interface BacktestRequest {
  source: "yahoo" | "csv" | "synthetic";
  market: string;
  symbols: string[];
  start: string; end: string; interval: string; adjusted: boolean;
  strategy: { id: string; params: Record<string, any>; code?: string };
  benchmark: string;
  capital: number;
  cost: { kind: string; rate_pct: number; fixed: number; per_share: number; minimum: number; maximum: number };
  slippage_pct: number;
  fill_on: "next_open" | "close";
  allow_short: boolean;
  leverage: number;
  fractional: boolean | null;
  lot_size: number;
  sizing: { mode: string; value: number };
  pyramiding: number;
  stops: { stop_loss_pct: number; take_profit_pct: number; trailing_pct: number; max_bars: number };
  risk_free_pct: number;
  max_volume_pct: number;
  rules: TradingRules;
  optimize?: any;
  walk_forward?: any;
}

export interface Trade {
  id: number; symbol: string; side: "Long" | "Short"; entry_time: number; exit_time: number;
  entry_price: number; exit_price: number; qty: number; pnl: number; gross_pnl: number; fees: number;
  return_pct: number; bars_held: number; mfe_pct: number; mae_pct: number; exit_reason: string; entry_tag: string;
  entry_bar: number; exit_bar: number;
}
export interface Indicator { name: string; overlay: boolean; color: string | null; values: (number | null)[] }
export interface SymbolData {
  open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[];
  volume: (number | null)[]; indicators: Indicator[];
}
export interface MonteCarlo {
  n_sims: number; x: number[]; time_axis: boolean; bands: Record<string, number[]>; sample_paths: number[][];
  final_return_pct: Record<string, number>; max_dd_pct: Record<string, number>; prob_loss_pct: number;
  prob_beat_actual_pct: number; return_hist: { counts: number[]; edges: number[] }; dd_hist: { counts: number[]; edges: number[] };
}
export interface BacktestResult {
  id: string; created: string; name?: string; starred?: boolean;
  strategy: { id: string; name: string; params: Record<string, any>; per_asset: boolean };
  request: BacktestRequest; market: Market; currency: string;
  metrics: Record<string, any>;
  series: {
    t: number[]; equity: number[]; benchmark: number[] | null; drawdown: number[]; exposure: number[]; cash: number[];
    rolling_sharpe: (number | null)[]; rolling_vol: (number | null)[]; rolling_window: number;
  };
  benchmark_name: string | null;
  returns_dist: number[];
  monthly: { year: number; month: number; ret: number }[];
  yearly: { year: number; ret: number; bench: number | null }[];
  drawdowns: { start: string; trough: string; end: string | null; depth_pct: number; bars: number; days: number; recovered: boolean }[];
  trades: Trade[];
  fills: any[];
  exit_reasons: Record<string, number>;
  rule_events: Record<string, number>;
  rules_active: string[];
  per_symbol: { symbol: string; trades: number; win_rate_pct: number | null; net_pnl: number; profit_factor: number | null; avg_trade_pct: number | null; buy_hold_pct: number | null }[];
  symbols: Record<string, SymbolData>;
  open_positions: any[];
  logs: { time: string; symbol: string; msg: string }[];
  monte_carlo: { returns?: MonteCarlo; trades?: MonteCarlo };
  warnings: string[];
  elapsed_ms: number;
}
export interface CompareSpec { id: string; params: Record<string, any>; label?: string; code?: string }
export interface CompareTrade {
  symbol: string; side: "Long" | "Short"; entry_time: number; exit_time: number; pnl: number; return_pct: number;
  fees: number; exit_reason: string; bars_held: number;
}
export interface CompareEntry {
  label: string; id: string | null; error?: string; name?: string; category?: string; params?: Record<string, any>;
  metrics: Record<string, any>; equity: number[]; exposure: number[] | null;
  monthly: { year: number; month: number; ret: number }[]; yearly: { year: number; ret: number }[];
  trades: CompareTrade[] | null; note?: string | null; is_blend?: boolean; elapsed_ms?: number;
}
export interface CompareResult {
  id: string; created: string; request: BacktestRequest & { strategies: CompareSpec[] }; market: Market; currency: string;
  t: number[]; benchmark: number[] | null; benchmark_name: string | null;
  strategies: CompareEntry[]; blend: CompareEntry | null; warnings: string[];
  config: { periods_per_year: number; cost_model: string; fill_on: string; initial_capital: number };
  elapsed_ms: number;
}
export interface RunSummary {
  id: string; created: string; name: string; kind: string; strategy: string; market: string; symbols: string[];
  summary: Record<string, any>; starred: boolean;
}
export interface Job<T = any> {
  id: string; kind: string; status: "running" | "done" | "error"; progress: number; total: number;
  elapsed: number; error: string | null; result?: T;
}

export class ApiError extends Error {
  line?: number | null;
  constructor(msg: string, line?: number | null) { super(msg); this.line = line; }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    let line: number | null = null;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
      line = j.line ?? null;
    } catch { /* not json */ }
    throw new ApiError(msg, line);
  }
  return r.json();
}

export const api = {
  meta: () => req<Meta>("/api/meta"),
  strategies: () => req<StrategyInfo[]>("/api/strategies"),
  validate: (code: string) => req<StrategyInfo>("/api/strategies/validate", { method: "POST", body: JSON.stringify({ code }) }),
  saveStrategy: (name: string, code: string) =>
    req<{ id: string }>("/api/strategies/custom", { method: "POST", body: JSON.stringify({ name, code }) }),
  deleteStrategy: (slug: string) => req("/api/strategies/custom/" + encodeURIComponent(slug), { method: "DELETE" }),
  search: (q: string) => req<{ symbol: string; name: string; exchange: string; type: string }[]>(
    "/api/symbols/search?q=" + encodeURIComponent(q)),
  preview: (p: Record<string, string>) => req<any>("/api/data/preview?" + new URLSearchParams(p).toString()),
  uploads: () => req<{ name: string; rows: number; start: string; end: string; last_close: number }[]>("/api/data/uploads"),
  upload: (file: File) => { const fd = new FormData(); fd.append("file", file); return req<any>("/api/data/upload", { method: "POST", body: fd }); },
  deleteUpload: (name: string) => req("/api/data/uploads/" + encodeURIComponent(name), { method: "DELETE" }),
  backtest: (body: BacktestRequest) => req<BacktestResult>("/api/backtest", { method: "POST", body: JSON.stringify(body) }),
  compare: (body: BacktestRequest, strategies: CompareSpec[]) =>
    req<CompareResult>("/api/compare", { method: "POST", body: JSON.stringify({ ...body, strategies }) }),
  runs: () => req<RunSummary[]>("/api/runs"),
  run: (id: string) => req<BacktestResult>("/api/runs/" + id),
  patchRun: (id: string, body: { name?: string; starred?: boolean }) =>
    req("/api/runs/" + id, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRun: (id: string) => req("/api/runs/" + id, { method: "DELETE" }),
  startOptimize: (body: BacktestRequest) => req<{ id: string }>("/api/optimize", { method: "POST", body: JSON.stringify(body) }),
  startWalkForward: (body: BacktestRequest) => req<{ id: string }>("/api/walkforward", { method: "POST", body: JSON.stringify(body) }),
  job: <T,>(id: string) => req<Job<T>>("/api/jobs/" + id),
};

export async function pollJob<T>(id: string, onProgress: (j: Job<T>) => void, signal?: { cancelled: boolean }): Promise<T> {
  for (;;) {
    if (signal?.cancelled) throw new Error("cancelled");
    const j = await api.job<T>(id);
    onProgress(j);
    if (j.status === "done") return j.result as T;
    if (j.status === "error") throw new ApiError(j.error || "Job failed");
    await new Promise((r) => setTimeout(r, 700));
  }
}
