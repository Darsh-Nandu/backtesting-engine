// Quant analytics for the Analysis view: risk/return statistics, distributions, seasonality,
// drawdowns, autocorrelation, mean-reversion measures, volume profile and cross-asset alignment.
import type { Bars } from "./types";

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const std = (a: number[], ddof = 1) => { if (a.length <= ddof) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof)); };
export const quantile = (a: number[], q: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };

/** Bars per year for annualising, from the bar spacing (crypto trades weekends, so 365 days). */
export function periodsPerYear(b: Bars): number {
  if (b.interval === "1W") return 52;
  if (b.interval === "1M") return 12;
  const weekend = b.t.filter((t) => { const d = new Date(t * 1000).getUTCDay(); return d === 0 || d === 6; }).length / Math.max(b.t.length, 1);
  const days = weekend > 0.05 ? 365 : 252;
  if (b.interval === "1D") return days;
  const perDay = new Map<number, number>();
  b.t.forEach((t) => { const k = Math.floor(t / 86400); perDay.set(k, (perDay.get(k) || 0) + 1); });
  const counts = [...perDay.values()].sort((x, y) => x - y);
  return days * (counts[Math.floor(counts.length / 2)] || 1);
}

export function returns(c: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(c[i] / c[i - 1] - 1);
  return r;
}

export function drawdowns(c: number[]): number[] {
  let peak = -Infinity;
  return c.map((x) => { peak = Math.max(peak, x); return (x / peak - 1) * 100; });
}

export interface DrawdownEpisode { start: number; trough: number; end: number | null; depth: number; bars: number; recovery: number | null }
export function drawdownTable(t: number[], c: number[], top = 10): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  let peak = c[0], peakI = 0, trough = c[0], troughI = 0, inDd = false;
  for (let i = 1; i < c.length; i++) {
    if (c[i] >= peak) {
      if (inDd) out.push({ start: t[peakI], trough: t[troughI], end: t[i], depth: (trough / peak - 1) * 100, bars: i - peakI, recovery: i - troughI });
      peak = c[i]; peakI = i; trough = c[i]; troughI = i; inDd = false;
    } else {
      inDd = true;
      if (c[i] < trough) { trough = c[i]; troughI = i; }
    }
  }
  if (inDd) out.push({ start: t[peakI], trough: t[troughI], end: null, depth: (trough / peak - 1) * 100, bars: c.length - 1 - peakI, recovery: null });
  return out.sort((a, b) => a.depth - b.depth).slice(0, top);
}

export function acf(r: number[], maxLag = 30): number[] {
  const m = mean(r), d = r.map((x) => x - m), v = d.reduce((s, x) => s + x * x, 0);
  const out: number[] = [];
  for (let k = 1; k <= maxLag; k++) {
    let s = 0;
    for (let i = k; i < d.length; i++) s += d[i] * d[i - k];
    out.push(v ? s / v : 0);
  }
  return out;
}

/** Hurst exponent from the scaling of log-price differences: ~0.5 random walk, >0.5 trending, <0.5 mean-reverting. */
export function hurst(c: number[]): number | null {
  const lp = c.map(Math.log), maxLag = Math.min(100, Math.floor(lp.length / 4));
  if (maxLag < 4) return null;
  const xs: number[] = [], ys: number[] = [];
  for (let lag = 2; lag <= maxLag; lag++) {
    const d: number[] = [];
    for (let i = lag; i < lp.length; i++) d.push(lp[i] - lp[i - lag]);
    const s = std(d);
    if (s > 0) { xs.push(Math.log(lag)); ys.push(Math.log(s)); }
  }
  return slope(xs, ys);
}

function slope(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  return sxx ? sxy / sxx : null;
}

/** Mean-reversion half-life (bars) from an AR(1) fit of log price changes on the lagged level. */
export function halfLife(c: number[]): number | null {
  const y = c.map(Math.log), lag = y.slice(0, -1), dy = y.slice(1).map((v, i) => v - y[i]);
  const b = slope(lag, dy);
  return b != null && b < 0 ? -Math.log(2) / b : null;
}

export interface Stats {
  bars: number; years: number; first: number; last: number; total: number; cagr: number; vol: number; sharpe: number | null; sortino: number | null;
  maxDd: number; calmar: number | null; ulcer: number; best: number; worst: number; pctPos: number; avgUp: number; avgDown: number; payoff: number | null;
  skew: number; kurt: number; var95: number; cvar95: number; acf1: number; hurst: number | null; halfLife: number | null;
  high: number; low: number; fromHigh: number; avgVol: number; maxUpStreak: number; maxDownStreak: number;
}

export function computeStats(b: Bars, ppy: number): Stats {
  const c = b.c, r = returns(c), n = r.length;
  const years = Math.max((b.t[b.t.length - 1] - b.t[0]) / 31557600, 1 / 365);
  const total = (c[c.length - 1] / c[0] - 1) * 100;
  const m = mean(r), sd = std(r);
  const down = Math.sqrt(r.reduce((s, x) => s + Math.min(x, 0) ** 2, 0) / Math.max(n, 1));
  const dd = drawdowns(c), maxDd = Math.min(...dd);
  const cagr = ((c[c.length - 1] / c[0]) ** (1 / years) - 1) * 100;
  const z = r.map((x) => (x - m) / (sd || 1));
  const ups = r.filter((x) => x > 0), dns = r.filter((x) => x < 0);
  const v5 = quantile(r, 0.05), tail = r.filter((x) => x <= v5);
  let up = 0, dn = 0, mu = 0, md = 0;
  r.forEach((x) => { if (x > 0) { up++; dn = 0; } else if (x < 0) { dn++; up = 0; } mu = Math.max(mu, up); md = Math.max(md, dn); });
  const high = Math.max(...b.h), low = Math.min(...b.l);
  return {
    bars: c.length, years, first: c[0], last: c[c.length - 1], total, cagr, vol: sd * Math.sqrt(ppy) * 100,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(ppy) : null, sortino: down > 0 ? (m / down) * Math.sqrt(ppy) : null,
    maxDd, calmar: maxDd < 0 ? cagr / Math.abs(maxDd) : null, ulcer: Math.sqrt(mean(dd.map((x) => x * x))),
    best: Math.max(...r) * 100, worst: Math.min(...r) * 100, pctPos: (ups.length / Math.max(n, 1)) * 100,
    avgUp: mean(ups) * 100, avgDown: mean(dns) * 100, payoff: dns.length && ups.length ? mean(ups) / Math.abs(mean(dns)) : null,
    skew: mean(z.map((x) => x ** 3)), kurt: mean(z.map((x) => x ** 4)) - 3, var95: v5 * 100, cvar95: mean(tail) * 100,
    acf1: acf(r, 1)[0] ?? 0, hurst: hurst(c), halfLife: halfLife(c), high, low, fromHigh: (c[c.length - 1] / high - 1) * 100,
    avgVol: mean(b.v), maxUpStreak: mu, maxDownStreak: md,
  };
}

export function histogram(x: number[], bins = 50) {
  const lo = quantile(x, 0.005), hi = quantile(x, 0.995), w = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  x.forEach((v) => { const k = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w))); counts[k]++; });
  return { lo, w, counts, centers: counts.map((_, i) => lo + (i + 0.5) * w) };
}

export const normalPdf = (x: number, m: number, s: number) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));

/** Inverse standard normal CDF (Acklam's approximation). */
export function invNorm(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function qqPoints(r: number[], maxPts = 400): [number, number][] {
  const m = mean(r), s = std(r) || 1, z = r.map((x) => (x - m) / s).sort((a, b) => a - b), n = z.length;
  const step = Math.max(1, Math.floor(n / maxPts)), out: [number, number][] = [];
  for (let i = 0; i < n; i += step) out.push([invNorm((i + 0.5) / n), z[i]]);
  return out;
}

/** Period returns keyed by a label (e.g. "2024-3"), measured close-to-close between period ends. */
export function periodReturns(t: number[], c: number[], key: (t: number) => string): Map<string, number> {
  const out = new Map<string, number>();
  let prevClose = c[0], curKey = key(t[0]), last = c[0];
  for (let i = 1; i < c.length; i++) {
    const k = key(t[i]);
    if (k !== curKey) { out.set(curKey, (last / prevClose - 1) * 100); prevClose = last; curKey = k; }
    last = c[i];
  }
  out.set(curKey, (last / prevClose - 1) * 100);
  return out;
}

/** Mean bar return and share of positive bars grouped by a bucket (weekday, hour, month ...). */
export function averageBy(t: number[], c: number[], bucket: (t: number) => number, size: number) {
  const sum = new Array(size).fill(0), pos = new Array(size).fill(0), n = new Array(size).fill(0);
  for (let i = 1; i < c.length; i++) {
    const k = bucket(t[i]), r = c[i] / c[i - 1] - 1;
    if (k < 0 || k >= size) continue;
    sum[k] += r; n[k]++; if (r > 0) pos[k]++;
  }
  return sum.map((s, k) => ({ mean: n[k] ? (s / n[k]) * 100 : null, pctPos: n[k] ? (pos[k] / n[k]) * 100 : null, n: n[k] }));
}

export function rolling(x: number[], w: number, fn: (a: number[]) => number): (number | null)[] {
  return x.map((_, i) => (i + 1 >= w ? fn(x.slice(i + 1 - w, i + 1)) : null));
}
export const rollStd = (a: number[]) => std(a);
export const rollMean = (a: number[]) => mean(a);

export function corr(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
export function beta(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let s = 0, v = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); v += (b[i] - mb) ** 2; }
  return v ? s / v : null;
}

/** Inner-join several series on time (calendar date for daily data), returning aligned closes. */
export function alignCloses(series: Bars[], daily: boolean): { t: number[]; closes: number[][] } {
  const key = (t: number) => (daily ? Math.floor(t / 86400) : t);
  const maps = series.map((b) => { const m = new Map<number, number>(); b.t.forEach((t, i) => m.set(key(t), b.c[i])); return m; });
  const keys = [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k))).sort((a, b) => a - b);
  return { t: keys.map((k) => (daily ? k * 86400 : k)), closes: maps.map((m) => keys.map((k) => m.get(k)!)) };
}

export interface ProfileRow { lo: number; hi: number; up: number; down: number }
/** Volume at price: each bar's volume spread evenly over its high-low range. */
export function volumeProfile(b: Bars, i0: number, i1: number, rows = 24, vaPct = 70) {
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i <= i1; i++) { lo = Math.min(lo, b.l[i]); hi = Math.max(hi, b.h[i]); }
  const h = (hi - lo) / rows || 1;
  const out: ProfileRow[] = Array.from({ length: rows }, (_, k) => ({ lo: lo + k * h, hi: lo + (k + 1) * h, up: 0, down: 0 }));
  for (let i = i0; i <= i1; i++) {
    const a = Math.max(0, Math.floor((b.l[i] - lo) / h)), z = Math.min(rows - 1, Math.floor((b.h[i] - lo) / h));
    const share = b.v[i] / (z - a + 1), isUp = b.c[i] >= b.o[i];
    for (let k = a; k <= z; k++) { if (isUp) out[k].up += share; else out[k].down += share; }
  }
  const tot = out.map((r) => r.up + r.down), total = tot.reduce((s, x) => s + x, 0);
  let poc = 0;
  tot.forEach((v, k) => { if (v > tot[poc]) poc = k; });
  let a = poc, z = poc, acc = tot[poc];
  while (acc < (total * vaPct) / 100 && (a > 0 || z < rows - 1)) {
    const below = a > 0 ? tot[a - 1] : -1, above = z < rows - 1 ? tot[z + 1] : -1;
    if (above >= below) acc += tot[++z]; else acc += tot[--a];
  }
  return { rows: out, poc, vaLo: a, vaHi: z, max: Math.max(...tot) };
}
