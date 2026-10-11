// Shared types for the charting workspace.

export type Interval = "1m" | "2m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W" | "1M";
export const INTERVALS: { id: Interval; label: string; legend: string; group: string; seconds: number }[] = [
  { id: "1m", label: "1 minute", legend: "1", group: "Minutes", seconds: 60 },
  { id: "2m", label: "2 minutes", legend: "2", group: "Minutes", seconds: 120 },
  { id: "5m", label: "5 minutes", legend: "5", group: "Minutes", seconds: 300 },
  { id: "15m", label: "15 minutes", legend: "15", group: "Minutes", seconds: 900 },
  { id: "30m", label: "30 minutes", legend: "30", group: "Minutes", seconds: 1800 },
  { id: "1h", label: "1 hour", legend: "1h", group: "Hours", seconds: 3600 },
  { id: "4h", label: "4 hours", legend: "4h", group: "Hours", seconds: 14400 },
  { id: "1D", label: "1 day", legend: "1D", group: "Days", seconds: 86400 },
  { id: "1W", label: "1 week", legend: "1W", group: "Days", seconds: 604800 },
  { id: "1M", label: "1 month", legend: "1M", group: "Days", seconds: 2592000 },
];
export const isDaily = (i: Interval) => i === "1D" || i === "1W" || i === "1M";

export type ChartType = "candles" | "hollow" | "bars" | "heikin" | "line" | "step" | "area" | "baseline" | "columns"
  | "renko" | "linebreak" | "kagi" | "pnf" | "range";

export interface Bars {
  symbol: string; interval: Interval; timezone: string; prepost?: boolean; adjusted?: boolean;
  t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[];
  /** CSV uploads: source and the file's own interval. */
  source?: string; native?: Interval;
  /** Kagi only: 1 = yang (thick), -1 = yin (thin). */
  dir?: number[];
}

export interface Quote {
  symbol: string; name?: string; short_name?: string; exchange_name?: string; exchange?: string; currency?: string;
  last?: number; prev_close?: number; change?: number; change_pct?: number; open?: number; day_high?: number; day_low?: number;
  volume?: number; avg_volume?: number; year_high?: number; year_low?: number; market_cap?: number; shares?: number;
  bid?: number; ask?: number; bid_size?: number; ask_size?: number; pe?: number; forward_pe?: number; eps?: number;
  beta?: number; dividend_yield?: number; pb?: number; profit_margin?: number; revenue?: number; target_price?: number;
  recommendation?: number; fifty_day_avg?: number; two_hundred_day_avg?: number; sector?: string; industry?: string;
  quote_type?: string; country?: string; website?: string; market_state?: string; exchange_tz?: string; summary?: string;
}

/** A drawing anchor: real UTC time (seconds) and price. Survives interval and timezone changes. */
export interface Pt { t: number; p: number }

export type ToolId =
  | "cross" | "dot" | "arrow" | "eraser"
  | "trend" | "ray" | "extended" | "hline" | "hray" | "vline" | "crossline" | "channel"
  | "fib" | "fibext"
  | "xabcd" | "elliott" | "triangle"
  | "long" | "short" | "range"
  | "brush" | "rect" | "ellipse" | "arrowline"
  | "text" | "pricelabel"
  | "icon"
  | "measure" | "zoom";

export interface DrawStyle { color: string; width: number; dash: 0 | 1 | 2; fill: boolean }

export interface Drawing {
  id: string; tool: ToolId; pts: Pt[]; style: DrawStyle;
  text?: string; icon?: string; locked?: boolean; hidden?: boolean;
}

export interface IndicatorInst {
  id: string; type: string; inputs: Record<string, number | string | boolean>; colors: string[]; hidden?: boolean;
}

export interface Replay { selecting: boolean; active: boolean; index: number; playing: boolean; speed: number }
