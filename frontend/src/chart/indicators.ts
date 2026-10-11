// Technical indicators computed in the browser so they update instantly (and causally during bar replay).
import type { Bars } from "./types";

type S = (number | null)[];
export type PlotKind = "line" | "histogram" | "area" | "dots" | "step";

export interface InputDef { key: string; label: string; type: "int" | "float" | "select" | "bool"; def: number | string | boolean; min?: number; max?: number; step?: number; options?: string[] }
export interface PlotDef { key: string; name: string; kind: PlotKind; color: string; width?: number }
export interface IndicatorDef {
  id: string; name: string; short: string; category: "Moving averages" | "Bands & channels" | "Momentum" | "Volatility" | "Volume" | "Trend" | "Statistics";
  overlay: boolean; inputs: InputDef[]; plots: PlotDef[]; levels?: number[]; desc: string;
  /** Histogram bar colours (e.g. volume, MACD) */
  barColors?: (b: Bars, out: S[], up: string, down: string) => (string | undefined)[];
  calc: (b: Bars, i: Record<string, any>) => S[];
}

// ---------------------------------------------------------------- primitives
const nz = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

export function sma(x: S, n: number): S {
  const out: S = new Array(x.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (nz(v)) { sum += v; cnt++; }
    if (i >= n) { const o = x[i - n]; if (nz(o)) { sum -= o; cnt--; } }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}

export function ema(x: S, n: number): S {
  const out: S = new Array(x.length).fill(null);
  const k = 2 / (n + 1);
  let prev: number | null = null, seed = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!nz(v)) { out[i] = prev; continue; }
    if (prev == null) { seed += v; cnt++; if (cnt === n) { prev = seed / n; out[i] = prev; } continue; }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
export function rma(x: S, n: number): S {
  const out: S = new Array(x.length).fill(null);
  let prev: number | null = null, seed = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!nz(v)) { out[i] = prev; continue; }
    if (prev == null) { seed += v; cnt++; if (cnt === n) { prev = seed / n; out[i] = prev; } continue; }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

export function wma(x: S, n: number): S {
  const out: S = new Array(x.length).fill(null);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < x.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) { const v = x[i - j]; if (!nz(v)) { ok = false; break; } s += v * (n - j); }
    if (ok) out[i] = s / denom;
  }
  return out;
}

function hma(x: S, n: number): S {
  const a = wma(x, Math.max(1, Math.floor(n / 2))), b = wma(x, n);
  return wma(a.map((v, i) => (nz(v) && nz(b[i]) ? 2 * v - (b[i] as number) : null)), Math.max(1, Math.round(Math.sqrt(n))));
}

export function stdev(x: S, n: number): S {
  const out: S = new Array(x.length).fill(null);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0, s2 = 0, ok = true;
    for (let j = 0; j < n; j++) { const v = x[i - j]; if (!nz(v)) { ok = false; break; } s += v; s2 += v * v; }
    if (ok) { const m = s / n; out[i] = Math.sqrt(Math.max(s2 / n - m * m, 0)); }
  }
  return out;
}

const highest = (x: S, n: number): S => x.map((_, i) => { if (i < n - 1) return null; let m = -Infinity; for (let j = i - n + 1; j <= i; j++) if (nz(x[j]) && (x[j] as number) > m) m = x[j] as number; return m === -Infinity ? null : m; });
const lowest = (x: S, n: number): S => x.map((_, i) => { if (i < n - 1) return null; let m = Infinity; for (let j = i - n + 1; j <= i; j++) if (nz(x[j]) && (x[j] as number) < m) m = x[j] as number; return m === Infinity ? null : m; });
const op = (a: S, b: S | number, f: (x: number, y: number) => number): S =>
  a.map((v, i) => { const w = typeof b === "number" ? b : b[i]; return nz(v) && nz(w) ? f(v, w) : null; });

export function trueRange(b: Bars): S {
  return b.c.map((_, i) => i === 0 ? b.h[i] - b.l[i] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])));
}
export const atr = (b: Bars, n: number) => rma(trueRange(b), n);

function src(b: Bars, s: string): S {
  switch (s) {
    case "open": return b.o; case "high": return b.h; case "low": return b.l;
    case "hl2": return b.h.map((h, i) => (h + b.l[i]) / 2);
    case "hlc3": return b.h.map((h, i) => (h + b.l[i] + b.c[i]) / 3);
    case "ohlc4": return b.h.map((h, i) => (b.o[i] + h + b.l[i] + b.c[i]) / 4);
    default: return b.c;
  }
}

export function rsi(x: S, n: number): S {
  const up: S = x.map((v, i) => (i && nz(v) && nz(x[i - 1]) ? Math.max(v - (x[i - 1] as number), 0) : i ? 0 : null));
  const dn: S = x.map((v, i) => (i && nz(v) && nz(x[i - 1]) ? Math.max((x[i - 1] as number) - v, 0) : i ? 0 : null));
  const au = rma(up, n), ad = rma(dn, n);
  return au.map((u, i) => (nz(u) && nz(ad[i]) ? ((ad[i] as number) === 0 ? 100 : 100 - 100 / (1 + u / (ad[i] as number))) : null));
}

function dmi(b: Bars, n: number, sm: number) {
  const pdm: S = [null], mdm: S = [null];
  for (let i = 1; i < b.c.length; i++) {
    const u = b.h[i] - b.h[i - 1], d = b.l[i - 1] - b.l[i];
    pdm.push(u > d && u > 0 ? u : 0); mdm.push(d > u && d > 0 ? d : 0);
  }
  const tr = rma(trueRange(b), n);
  const pdi = op(rma(pdm, n), tr, (a, t) => (t ? (100 * a) / t : 0));
  const mdi = op(rma(mdm, n), tr, (a, t) => (t ? (100 * a) / t : 0));
  const dx = pdi.map((p, i) => (nz(p) && nz(mdi[i]) ? ((p + (mdi[i] as number)) ? (100 * Math.abs(p - (mdi[i] as number))) / (p + (mdi[i] as number)) : 0) : null));
  return { pdi, mdi, adx: rma(dx, sm) };
}

/** Session id for VWAP / pivots: the calendar day in the chart's display timezone. */
let dayKey: (t: number) => number = (t) => Math.floor(t / 86400);
export function setDayKey(fn: (t: number) => number) { dayKey = fn; }

// ---------------------------------------------------------------- registry
const C = { blue: "#2962ff", orange: "#ff9800", purple: "#7e57c2", teal: "#00897b", red: "#f23645", green: "#089981", pink: "#e91e63", grey: "#787b86", cyan: "#00bcd4", amber: "#ffb300" };
const srcInput = (def = "close"): InputDef => ({ key: "source", label: "Source", type: "select", def, options: ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"] });
const len = (def: number, label = "Length"): InputDef => ({ key: "length", label, type: "int", def, min: 1, max: 1000 });

export const INDICATORS: IndicatorDef[] = [
  // ---- volume
  { id: "vol", name: "Volume", short: "Vol", category: "Volume", overlay: true, desc: "Traded volume per bar, coloured by bar direction, with a moving average.",
    inputs: [{ key: "ma", label: "MA length", type: "int", def: 20, min: 1, max: 500 }],
    plots: [{ key: "v", name: "Volume", kind: "histogram", color: C.teal }, { key: "ma", name: "Volume MA", kind: "line", color: C.blue, width: 1 }],
    barColors: (b, _o, up, down) => b.c.map((c, i) => ((c >= b.o[i] ? up : down) + "80")),
    calc: (b, i) => [b.v, sma(b.v, i.ma)] },
  { id: "vrvp", name: "Volume Profile (visible range)", short: "VRVP", category: "Volume", overlay: true, desc: "Volume traded at each price for the bars on screen, with the point of control and value area.",
    inputs: [{ key: "rows", label: "Rows", type: "int", def: 24, min: 6, max: 80 }, { key: "va", label: "Value area %", type: "int", def: 70, min: 10, max: 100 }],
    plots: [], calc: () => [] },
  { id: "obv", name: "On Balance Volume", short: "OBV", category: "Volume", overlay: false, desc: "Running total of volume, added on up bars and subtracted on down bars.",
    inputs: [], plots: [{ key: "obv", name: "OBV", kind: "line", color: C.blue }],
    calc: (b) => { let s = 0; return [b.c.map((c, i) => (i === 0 ? 0 : (s += c > b.c[i - 1] ? b.v[i] : c < b.c[i - 1] ? -b.v[i] : 0)))]; } },
  { id: "vwap", name: "VWAP", short: "VWAP", category: "Volume", overlay: true, desc: "Volume-weighted average price, reset each session (intraday).",
    inputs: [srcInput("hlc3")], plots: [{ key: "vwap", name: "VWAP", kind: "line", color: C.purple, width: 2 }],
    calc: (b, i) => { const x = src(b, i.source); let pv = 0, vv = 0, d = -1; return [x.map((p, k) => { const dk = dayKey(b.t[k]); if (dk !== d) { pv = 0; vv = 0; d = dk; } pv += (p as number) * b.v[k]; vv += b.v[k]; return vv ? pv / vv : p; })]; } },
  { id: "mfi", name: "Money Flow Index", short: "MFI", category: "Volume", overlay: false, levels: [20, 80], desc: "Volume-weighted RSI.",
    inputs: [len(14)], plots: [{ key: "mfi", name: "MFI", kind: "line", color: C.purple }],
    calc: (b, i) => { const tp = src(b, "hlc3") as number[]; const pos: S = [null], neg: S = [null];
      for (let k = 1; k < tp.length; k++) { const f = tp[k] * b.v[k]; pos.push(tp[k] > tp[k - 1] ? f : 0); neg.push(tp[k] < tp[k - 1] ? f : 0); }
      const ps = sma(pos, i.length), ns = sma(neg, i.length);
      return [ps.map((p, k) => (nz(p) && nz(ns[k]) ? ((ns[k] as number) === 0 ? 100 : 100 - 100 / (1 + p / (ns[k] as number))) : null))]; } },

  // ---- moving averages
  { id: "sma", name: "Moving Average", short: "MA", category: "Moving averages", overlay: true, desc: "Simple moving average.",
    inputs: [len(20), srcInput()], plots: [{ key: "ma", name: "MA", kind: "line", color: C.blue, width: 2 }], calc: (b, i) => [sma(src(b, i.source), i.length)] },
  { id: "ema", name: "Moving Average Exponential", short: "EMA", category: "Moving averages", overlay: true, desc: "Exponential moving average.",
    inputs: [len(20), srcInput()], plots: [{ key: "ema", name: "EMA", kind: "line", color: C.orange, width: 2 }], calc: (b, i) => [ema(src(b, i.source), i.length)] },
  { id: "wma", name: "Moving Average Weighted", short: "WMA", category: "Moving averages", overlay: true, desc: "Linearly weighted moving average.",
    inputs: [len(20), srcInput()], plots: [{ key: "wma", name: "WMA", kind: "line", color: C.pink, width: 2 }], calc: (b, i) => [wma(src(b, i.source), i.length)] },
  { id: "hma", name: "Hull Moving Average", short: "HMA", category: "Moving averages", overlay: true, desc: "Fast, low-lag moving average.",
    inputs: [len(21), srcInput()], plots: [{ key: "hma", name: "HMA", kind: "line", color: C.teal, width: 2 }], calc: (b, i) => [hma(src(b, i.source), i.length)] },
  { id: "macross", name: "MA Cross", short: "MA Cross", category: "Moving averages", overlay: true, desc: "Fast and slow moving averages for crossover analysis.",
    inputs: [{ key: "fast", label: "Fast length", type: "int", def: 9, min: 1, max: 500 }, { key: "slow", label: "Slow length", type: "int", def: 21, min: 1, max: 1000 }, { key: "type", label: "Type", type: "select", def: "EMA", options: ["SMA", "EMA"] }],
    plots: [{ key: "fast", name: "Fast", kind: "line", color: C.green, width: 2 }, { key: "slow", name: "Slow", kind: "line", color: C.red, width: 2 }],
    calc: (b, i) => { const f = i.type === "SMA" ? sma : ema; return [f(b.c, i.fast), f(b.c, i.slow)]; } },

  // ---- bands & channels
  { id: "bb", name: "Bollinger Bands", short: "BB", category: "Bands & channels", overlay: true, desc: "Moving average with bands N standard deviations away.",
    inputs: [len(20), { key: "mult", label: "StdDev", type: "float", def: 2, min: 0.1, max: 10, step: 0.1 }, srcInput()],
    plots: [{ key: "basis", name: "Basis", kind: "line", color: C.orange, width: 1 }, { key: "upper", name: "Upper", kind: "line", color: C.blue, width: 1 }, { key: "lower", name: "Lower", kind: "line", color: C.blue, width: 1 }],
    calc: (b, i) => { const x = src(b, i.source), m = sma(x, i.length), sd = stdev(x, i.length); return [m, op(m, sd.map((v) => (nz(v) ? v * i.mult : null)), (a, d) => a + d), op(m, sd.map((v) => (nz(v) ? v * i.mult : null)), (a, d) => a - d)]; } },
  { id: "kc", name: "Keltner Channels", short: "KC", category: "Bands & channels", overlay: true, desc: "EMA with bands set by average true range.",
    inputs: [len(20), { key: "mult", label: "Multiplier", type: "float", def: 2, min: 0.1, max: 10, step: 0.1 }, { key: "atr", label: "ATR length", type: "int", def: 10, min: 1, max: 500 }],
    plots: [{ key: "basis", name: "Basis", kind: "line", color: C.blue, width: 1 }, { key: "upper", name: "Upper", kind: "line", color: C.blue, width: 1 }, { key: "lower", name: "Lower", kind: "line", color: C.blue, width: 1 }],
    calc: (b, i) => { const m = ema(b.c, i.length), a = atr(b, i.atr); return [m, op(m, a, (x, y) => x + i.mult * y), op(m, a, (x, y) => x - i.mult * y)]; } },
  { id: "dc", name: "Donchian Channels", short: "DC", category: "Bands & channels", overlay: true, desc: "Highest high and lowest low over N bars.",
    inputs: [len(20)], plots: [{ key: "upper", name: "Upper", kind: "line", color: C.blue, width: 1 }, { key: "basis", name: "Basis", kind: "line", color: C.orange, width: 1 }, { key: "lower", name: "Lower", kind: "line", color: C.blue, width: 1 }],
    calc: (b, i) => { const u = highest(b.h, i.length), l = lowest(b.l, i.length); return [u, op(u, l, (x, y) => (x + y) / 2), l]; } },
  { id: "pivots", name: "Pivot Points Standard", short: "Pivots", category: "Bands & channels", overlay: true, desc: "Floor-trader pivots from the previous session's high, low and close (intraday charts).",
    inputs: [], plots: [{ key: "r2", name: "R2", kind: "step", color: C.red, width: 1 }, { key: "r1", name: "R1", kind: "step", color: C.red, width: 1 }, { key: "p", name: "P", kind: "step", color: C.orange, width: 1 }, { key: "s1", name: "S1", kind: "step", color: C.green, width: 1 }, { key: "s2", name: "S2", kind: "step", color: C.green, width: 1 }],
    calc: (b) => {
      const out: S[] = [[], [], [], [], []]; let d = -1, ph = 0, pl = 0, pc = 0, h = -Infinity, l = Infinity, c = 0, have = false;
      for (let k = 0; k < b.t.length; k++) {
        const dk = dayKey(b.t[k]);
        if (dk !== d) { if (d !== -1) { ph = h; pl = l; pc = c; have = true; } d = dk; h = -Infinity; l = Infinity; }
        h = Math.max(h, b.h[k]); l = Math.min(l, b.l[k]); c = b.c[k];
        if (!have) { out.forEach((o) => o.push(null)); continue; }
        const p = (ph + pl + pc) / 3;
        out[0].push(p + (ph - pl)); out[1].push(2 * p - pl); out[2].push(p); out[3].push(2 * p - ph); out[4].push(p - (ph - pl));
      }
      return out;
    } },

  // ---- trend
  { id: "supertrend", name: "Supertrend", short: "Supertrend", category: "Trend", overlay: true, desc: "ATR trailing stop that flips with the trend.",
    inputs: [{ key: "atr", label: "ATR length", type: "int", def: 10, min: 1, max: 500 }, { key: "mult", label: "Factor", type: "float", def: 3, min: 0.1, max: 20, step: 0.1 }],
    plots: [{ key: "up", name: "Up trend", kind: "line", color: C.green, width: 2 }, { key: "down", name: "Down trend", kind: "line", color: C.red, width: 2 }],
    calc: (b, i) => {
      const a = atr(b, i.atr), n = b.c.length, up: S = new Array(n).fill(null), dn: S = new Array(n).fill(null);
      let fu = 0, fl = 0, dir = 1;
      for (let k = 0; k < n; k++) {
        if (!nz(a[k])) continue;
        const m = (b.h[k] + b.l[k]) / 2, bu = m + i.mult * (a[k] as number), bl = m - i.mult * (a[k] as number);
        const pc = b.c[k - 1] ?? b.c[k];
        fu = !fu || bu < fu || pc > fu ? bu : fu;
        fl = !fl || bl > fl || pc < fl ? bl : fl;
        if (dir === 1 && b.c[k] < fl) dir = -1; else if (dir === -1 && b.c[k] > fu) dir = 1;
        if (dir === 1) up[k] = fl; else dn[k] = fu;
      }
      return [up, dn];
    } },
  { id: "psar", name: "Parabolic SAR", short: "SAR", category: "Trend", overlay: true, desc: "Stop-and-reverse points that trail the trend.",
    inputs: [{ key: "start", label: "Start", type: "float", def: 0.02, step: 0.01, min: 0.001, max: 1 }, { key: "inc", label: "Increment", type: "float", def: 0.02, step: 0.01, min: 0.001, max: 1 }, { key: "max", label: "Max", type: "float", def: 0.2, step: 0.01, min: 0.01, max: 1 }],
    plots: [{ key: "sar", name: "SAR", kind: "dots", color: C.blue }],
    calc: (b, i) => {
      const n = b.c.length, out: S = new Array(n).fill(null);
      if (n < 3) return [out];
      let long = b.c[1] >= b.c[0], af = i.start, ep = long ? b.h[0] : b.l[0], sar = long ? b.l[0] : b.h[0];
      for (let k = 1; k < n; k++) {
        sar = sar + af * (ep - sar);
        if (long) {
          sar = Math.min(sar, b.l[k - 1], b.l[Math.max(k - 2, 0)]);
          if (b.l[k] < sar) { long = false; sar = ep; ep = b.l[k]; af = i.start; }
          else if (b.h[k] > ep) { ep = b.h[k]; af = Math.min(af + i.inc, i.max); }
        } else {
          sar = Math.max(sar, b.h[k - 1], b.h[Math.max(k - 2, 0)]);
          if (b.h[k] > sar) { long = true; sar = ep; ep = b.h[k]; af = i.start; }
          else if (b.l[k] < ep) { ep = b.l[k]; af = Math.min(af + i.inc, i.max); }
        }
        out[k] = sar;
      }
      return [out];
    } },
  { id: "adx", name: "Directional Movement Index", short: "DMI", category: "Trend", overlay: false, levels: [25], desc: "+DI, -DI and ADX trend strength.",
    inputs: [len(14, "DI length"), { key: "smooth", label: "ADX smoothing", type: "int", def: 14, min: 1, max: 200 }],
    plots: [{ key: "adx", name: "ADX", kind: "line", color: C.red }, { key: "pdi", name: "+DI", kind: "line", color: C.blue }, { key: "mdi", name: "-DI", kind: "line", color: C.orange }],
    calc: (b, i) => { const d = dmi(b, i.length, i.smooth); return [d.adx, d.pdi, d.mdi]; } },

  // ---- momentum
  { id: "rsi", name: "Relative Strength Index", short: "RSI", category: "Momentum", overlay: false, levels: [30, 70], desc: "Momentum oscillator between 0 and 100.",
    inputs: [len(14), srcInput()], plots: [{ key: "rsi", name: "RSI", kind: "line", color: C.purple }], calc: (b, i) => [rsi(src(b, i.source), i.length)] },
  { id: "macd", name: "MACD", short: "MACD", category: "Momentum", overlay: false, levels: [0], desc: "Difference of two EMAs with a signal line and histogram.",
    inputs: [{ key: "fast", label: "Fast length", type: "int", def: 12, min: 1, max: 500 }, { key: "slow", label: "Slow length", type: "int", def: 26, min: 1, max: 500 }, { key: "signal", label: "Signal", type: "int", def: 9, min: 1, max: 200 }],
    plots: [{ key: "hist", name: "Histogram", kind: "histogram", color: C.teal }, { key: "macd", name: "MACD", kind: "line", color: C.blue }, { key: "signal", name: "Signal", kind: "line", color: C.orange }],
    barColors: (_b, out, up, down) => out[0].map((v, k) => { if (!nz(v)) return undefined; const p = out[0][k - 1]; const rising = nz(p) ? v >= p : true; return v >= 0 ? (rising ? up : up + "80") : (rising ? down + "80" : down); }),
    calc: (b, i) => { const m = op(ema(b.c, i.fast), ema(b.c, i.slow), (x, y) => x - y); const s = ema(m, i.signal); return [op(m, s, (x, y) => x - y), m, s]; } },
  { id: "stoch", name: "Stochastic", short: "Stoch", category: "Momentum", overlay: false, levels: [20, 80], desc: "Where the close sits within the recent high-low range.",
    inputs: [{ key: "k", label: "%K length", type: "int", def: 14, min: 1, max: 500 }, { key: "ks", label: "%K smoothing", type: "int", def: 1, min: 1, max: 50 }, { key: "d", label: "%D smoothing", type: "int", def: 3, min: 1, max: 50 }],
    plots: [{ key: "k", name: "%K", kind: "line", color: C.blue }, { key: "d", name: "%D", kind: "line", color: C.orange }],
    calc: (b, i) => { const hh = highest(b.h, i.k), ll = lowest(b.l, i.k); const raw = b.c.map((c, k) => (nz(hh[k]) && nz(ll[k]) && (hh[k] as number) !== ll[k] ? (100 * (c - (ll[k] as number))) / ((hh[k] as number) - (ll[k] as number)) : null)); const k = sma(raw, i.ks); return [k, sma(k, i.d)]; } },
  { id: "cci", name: "Commodity Channel Index", short: "CCI", category: "Momentum", overlay: false, levels: [-100, 100], desc: "Deviation of price from its average, scaled.",
    inputs: [len(20)], plots: [{ key: "cci", name: "CCI", kind: "line", color: C.blue }],
    calc: (b, i) => { const tp = src(b, "hlc3"), m = sma(tp, i.length); return [tp.map((v, k) => { if (!nz(m[k])) return null; let md = 0; for (let j = k - i.length + 1; j <= k; j++) md += Math.abs((tp[j] as number) - (m[k] as number)); md /= i.length; return md ? ((v as number) - (m[k] as number)) / (0.015 * md) : 0; })]; } },
  { id: "willr", name: "Williams %R", short: "%R", category: "Momentum", overlay: false, levels: [-80, -20], desc: "Close relative to the N-bar high (0) and low (-100).",
    inputs: [len(14)], plots: [{ key: "r", name: "%R", kind: "line", color: C.purple }],
    calc: (b, i) => { const hh = highest(b.h, i.length), ll = lowest(b.l, i.length); return [b.c.map((c, k) => (nz(hh[k]) && nz(ll[k]) && hh[k] !== ll[k] ? (-100 * ((hh[k] as number) - c)) / ((hh[k] as number) - (ll[k] as number)) : null))]; } },
  { id: "roc", name: "Rate Of Change", short: "ROC", category: "Momentum", overlay: false, levels: [0], desc: "Percent change over N bars.",
    inputs: [len(9), srcInput()], plots: [{ key: "roc", name: "ROC", kind: "line", color: C.blue }],
    calc: (b, i) => { const x = src(b, i.source); return [x.map((v, k) => (k >= i.length && nz(v) && nz(x[k - i.length]) ? (100 * (v - (x[k - i.length] as number))) / (x[k - i.length] as number) : null))]; } },

  // ---- volatility
  { id: "atr", name: "Average True Range", short: "ATR", category: "Volatility", overlay: false, desc: "Average bar range including gaps.",
    inputs: [len(14)], plots: [{ key: "atr", name: "ATR", kind: "line", color: C.red }], calc: (b, i) => [atr(b, i.length)] },
  { id: "hv", name: "Historical Volatility", short: "HV", category: "Volatility", overlay: false, desc: "Annualised standard deviation of log returns, in %.",
    inputs: [len(20), { key: "ppy", label: "Bars per year", type: "int", def: 252, min: 1, max: 200000 }],
    plots: [{ key: "hv", name: "HV", kind: "line", color: C.blue }],
    calc: (b, i) => { const r: S = b.c.map((c, k) => (k ? Math.log(c / b.c[k - 1]) : null)); return [stdev(r, i.length).map((v) => (nz(v) ? v * Math.sqrt(i.ppy) * 100 : null))]; } },
  { id: "bbw", name: "Bollinger BandWidth", short: "BBW", category: "Volatility", overlay: false, desc: "Width of the Bollinger Bands relative to the basis; low values flag squeezes.",
    inputs: [len(20), { key: "mult", label: "StdDev", type: "float", def: 2, step: 0.1, min: 0.1, max: 10 }],
    plots: [{ key: "w", name: "BBW", kind: "line", color: C.teal }],
    calc: (b, i) => { const m = sma(b.c, i.length), sd = stdev(b.c, i.length); return [op(m, sd, (a, d) => (a ? (2 * i.mult * d) / a : null) as number)]; } },

  // ---- statistics
  { id: "zscore", name: "Z-Score", short: "Z", category: "Statistics", overlay: false, levels: [-2, 0, 2], desc: "How many standard deviations price is from its rolling mean.",
    inputs: [len(20), srcInput()], plots: [{ key: "z", name: "Z", kind: "line", color: C.blue }],
    calc: (b, i) => { const x = src(b, i.source), m = sma(x, i.length), sd = stdev(x, i.length); return [x.map((v, k) => (nz(m[k]) && nz(sd[k]) && (sd[k] as number) > 0 ? ((v as number) - (m[k] as number)) / (sd[k] as number) : null))]; } },
  { id: "retn", name: "Rolling Return", short: "Return", category: "Statistics", overlay: false, levels: [0], desc: "Percent return over the last N bars.",
    inputs: [len(20)], plots: [{ key: "r", name: "Return %", kind: "area", color: C.blue }],
    calc: (b, i) => [b.c.map((c, k) => (k >= i.length ? (c / b.c[k - i.length] - 1) * 100 : null))] },
  { id: "linreg", name: "Linear Regression Curve", short: "LinReg", category: "Statistics", overlay: true, desc: "End point of a rolling least-squares line.",
    inputs: [len(50)], plots: [{ key: "lr", name: "LinReg", kind: "line", color: C.cyan, width: 2 }],
    calc: (b, i) => { const n = i.length; return [b.c.map((_, k) => { if (k < n - 1) return null; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let j = 0; j < n; j++) { const y = b.c[k - n + 1 + j]; sx += j; sy += y; sxy += j * y; sxx += j * j; } const sl = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1); return (sy - sl * sx) / n + sl * (n - 1); })]; } },
];

export const INDICATOR_MAP = Object.fromEntries(INDICATORS.map((d) => [d.id, d]));

export function defaultInputs(def: IndicatorDef) {
  return Object.fromEntries(def.inputs.map((x) => [x.key, x.def]));
}

/** "RSI 14 close" style label used in legends. */
export function indLabel(def: IndicatorDef, inputs: Record<string, any>) {
  const vals = def.inputs.filter((x) => x.type !== "bool").map((x) => inputs[x.key] ?? x.def);
  return `${def.short}${vals.length ? " " + vals.join(" ") : ""}`;
}

/** Heikin Ashi candles. */
export function heikinAshi(b: Bars): Bars {
  const n = b.c.length, o: number[] = new Array(n), c: number[] = new Array(n), h: number[] = new Array(n), l: number[] = new Array(n);
  for (let k = 0; k < n; k++) {
    c[k] = (b.o[k] + b.h[k] + b.l[k] + b.c[k]) / 4;
    o[k] = k ? (o[k - 1] + c[k - 1]) / 2 : (b.o[k] + b.c[k]) / 2;
    h[k] = Math.max(b.h[k], o[k], c[k]); l[k] = Math.min(b.l[k], o[k], c[k]);
  }
  return { ...b, o, h, l, c };
}

export const TEMPLATES: { name: string; desc: string; items: { type: string; inputs?: Record<string, any> }[] }[] = [
  { name: "Volume + moving averages", desc: "Volume, EMA 20, EMA 50, SMA 200", items: [{ type: "vol" }, { type: "ema", inputs: { length: 20 } }, { type: "ema", inputs: { length: 50 } }, { type: "sma", inputs: { length: 200 } }] },
  { name: "Momentum", desc: "RSI 14 and MACD 12 26 9", items: [{ type: "rsi" }, { type: "macd" }] },
  { name: "Volatility", desc: "Bollinger Bands, ATR and Historical Volatility", items: [{ type: "bb" }, { type: "atr" }, { type: "hv" }] },
  { name: "Intraday", desc: "VWAP, Pivot Points and Volume", items: [{ type: "vwap" }, { type: "pivots" }, { type: "vol" }] },
  { name: "Trend following", desc: "Supertrend, DMI and EMA 50", items: [{ type: "supertrend" }, { type: "ema", inputs: { length: 50 } }, { type: "adx" }] },
  { name: "Mean reversion", desc: "Bollinger Bands, Z-Score and RSI", items: [{ type: "bb" }, { type: "zscore" }, { type: "rsi" }] },
];
