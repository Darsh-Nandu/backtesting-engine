import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, BacktestRequest, BacktestResult, Meta, StrategyInfo, TradingRules } from "./api";
import { isoDay } from "./format";

export type Page = "backtest" | "optimize" | "walkforward" | "lab" | "data" | "history";
export type Theme = "dark" | "light";
interface Toast { id: number; msg: string; kind: "ok" | "err" | "info" }

const today = isoDay(new Date());

export const DEFAULT_RULES: TradingRules = {
  direction: "long",
  sizing_base: "compound",
  square_off: false,
  square_off_time: "",
  entry_start: "",
  entry_end: "",
  daily_capital_limit: 0,
  daily_capital_mode: "amount",
  max_trades_per_day: 0,
  max_open_positions: 0,
  max_position_pct: 0,
  daily_loss_limit_pct: 0,
  daily_profit_target_pct: 0,
  max_drawdown_stop_pct: 0,
  cooldown_bars: 0,
};

/** Human summary of the rules that are switched on. */
export function activeRules(r: TradingRules): string[] {
  const out: string[] = [];
  if (r.direction === "short") out.push("Short only");
  if (r.direction === "both") out.push("Long & short");
  if (r.sizing_base === "fixed") out.push("Fixed capital");
  if (r.square_off) out.push("Daily square-off");
  if (r.entry_start || r.entry_end) out.push("Entry window");
  if (r.daily_capital_limit) out.push("Daily capital limit");
  if (r.max_trades_per_day) out.push("Trades/day limit");
  if (r.max_open_positions) out.push("Max positions");
  if (r.max_position_pct) out.push("Position cap");
  if (r.daily_loss_limit_pct) out.push("Daily loss stop");
  if (r.daily_profit_target_pct) out.push("Daily target");
  if (r.max_drawdown_stop_pct) out.push("Kill switch");
  if (r.cooldown_bars) out.push("Cooldown");
  return out;
}

export const DEFAULT_CONFIG: BacktestRequest = {
  source: "yahoo",
  market: "NSE",
  symbols: ["RELIANCE"],
  start: "2015-01-01",
  end: today,
  interval: "1d",
  adjusted: true,
  strategy: { id: "SmaCross", params: {} },
  benchmark: "auto",
  capital: 1_000_000,
  cost: { kind: "", rate_pct: 0.1, fixed: 0, per_share: 0, minimum: 0, maximum: 0 },
  slippage_pct: 0.05,
  fill_on: "next_open",
  allow_short: false,
  leverage: 1,
  fractional: null,
  lot_size: 1,
  sizing: { mode: "percent", value: 100 },
  pyramiding: 1,
  stops: { stop_loss_pct: 0, take_profit_pct: 0, trailing_pct: 0, max_bars: 0 },
  risk_free_pct: 0,
  max_volume_pct: 0,
  rules: DEFAULT_RULES,
};

interface Ctx {
  meta: Meta | null;
  strategies: StrategyInfo[];
  reloadStrategies: () => Promise<void>;
  config: BacktestRequest;
  setConfig: (fn: (c: BacktestRequest) => BacktestRequest) => void;
  result: BacktestResult | null;
  setResult: (r: BacktestResult | null) => void;
  page: Page;
  go: (p: Page) => void;
  theme: Theme;
  toggleTheme: () => void;
  toast: (msg: string, kind?: Toast["kind"]) => void;
  toasts: Toast[];
  bootError: string | null;
}

const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch { return fallback; }
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [config, setConfigState] = useState<BacktestRequest>(() => {
    const c = load("qf.config", DEFAULT_CONFIG);
    let raw: any = {};
    try { raw = JSON.parse(localStorage.getItem("qf.config") || "{}"); } catch { /* ignore */ }
    // Configs saved before trading rules existed: carry the old "allow short" switch over.
    const rules: TradingRules = raw.rules ? { ...DEFAULT_RULES, ...raw.rules }
      : { ...DEFAULT_RULES, direction: c.allow_short ? "both" : "long" };
    return { ...c, rules, end: c.end && c.end < today ? c.end : today };
  });
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [page, setPage] = useState<Page>(() => (location.hash.slice(1) as Page) || "backtest");
  const [theme, setTheme] = useState<Theme>(() => {
    let t: Theme = "dark";
    try { t = (localStorage.getItem("qf.theme") as Theme) || "dark"; } catch { /* ignore */ }
    document.documentElement.dataset.theme = t;
    return t;
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("qf.theme", theme); } catch { /* ignore */ }
  }, [theme]);

  const reloadStrategies = useCallback(async () => {
    setStrategies(await api.strategies());
  }, []);

  useEffect(() => {
    Promise.all([api.meta(), api.strategies()])
      .then(([m, s]) => { setMeta(m); setStrategies(s); })
      .catch((e) => setBootError(String(e.message || e)));
  }, []);

  useEffect(() => {
    const onHash = () => setPage((location.hash.slice(1) as Page) || "backtest");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setConfig = useCallback((fn: (c: BacktestRequest) => BacktestRequest) => {
    setConfigState((c) => {
      const n = fn(c);
      try { localStorage.setItem("qf.config", JSON.stringify({ ...n, strategy: { ...n.strategy, code: undefined } })); } catch { /* ignore */ }
      return n;
    });
  }, []);

  const toast = useCallback((msg: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const value = useMemo<Ctx>(() => ({
    meta, strategies, reloadStrategies, config, setConfig, result, setResult, page,
    go: (p) => { location.hash = p; setPage(p); },
    theme, toggleTheme: () => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next; // apply before charts re-read the palette
      setTheme(next);
    },
    toast, toasts, bootError,
  }), [meta, strategies, reloadStrategies, config, setConfig, result, page, theme, toast, toasts, bootError]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Read the current chart palette from CSS custom properties. */
export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    text: v("--text"), text2: v("--text-2"), muted: v("--muted"), grid: v("--grid"), axis: v("--axis"),
    surface: v("--surface"), surface2: v("--surface-2"), border: v("--border-strong"),
    accent: v("--accent"), pos: v("--pos"), neg: v("--neg"), posText: v("--pos-text"), negText: v("--neg-text"),
    divMid: v("--div-mid"), bench: v("--bench"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((k) => v(`--s${k}`)),
  };
}
export type Palette = ReturnType<typeof readPalette>;

export function usePalette(): Palette {
  const { theme } = useApp();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readPalette(), [theme]);
}
