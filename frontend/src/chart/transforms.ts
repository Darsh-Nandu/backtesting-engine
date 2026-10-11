// Price-driven chart types that ignore time: Renko, Line break, Kagi, Point & Figure, Range bars.
// Each turns ordinary bars into a new bar series (one entry per brick / line / column) whose
// timestamps are the source bar that completed it, nudged to stay strictly increasing.
import { atr } from "./indicators";
import type { Bars, ChartType } from "./types";

export const TRANSFORMED: ChartType[] = ["renko", "linebreak", "kagi", "pnf", "range"];
export const isTransformed = (t: ChartType) => TRANSFORMED.includes(t);

export interface BrickOpts { box: number; reversal: number; lines: number }

/** A round box size near ATR(14): 1, 2, 2.5 or 5 times a power of ten. */
export function autoBox(b: Bars): number {
  const a = atr(b, 14).filter((v): v is number => v != null && Number.isFinite(v));
  const x = a.length ? a[a.length - 1] : (b.c[b.c.length - 1] || 1) * 0.01;
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), p);
}

class Out {
  t: number[] = []; o: number[] = []; h: number[] = []; l: number[] = []; c: number[] = []; v: number[] = []; dir: number[] = [];
  push(t: number, o: number, h: number, l: number, c: number, v: number, dir = 0) {
    const prev = this.t[this.t.length - 1];
    this.t.push(prev != null && t <= prev ? prev + 1 : t);
    this.o.push(o); this.h.push(h); this.l.push(l); this.c.push(c); this.v.push(v); this.dir.push(dir);
  }
  bars(src: Bars): Bars { return { ...src, t: this.t, o: this.o, h: this.h, l: this.l, c: this.c, v: this.v, dir: this.dir }; }
}

function renko(b: Bars, box: number): Bars {
  const out = new Out();
  if (!b.c.length) return out.bars(b);
  let top = Math.round(b.c[0] / box) * box, bottom = top, vol = 0;
  for (let i = 0; i < b.c.length; i++) {
    const c = b.c[i];
    vol += b.v[i];
    // Continuation needs one box beyond the last brick; a reversal needs one box beyond its far end (two boxes).
    while (c >= top + box) { out.push(b.t[i], top, top + box, top, top + box, vol); vol = 0; bottom = top; top += box; }
    while (c <= bottom - box) { out.push(b.t[i], bottom, bottom, bottom - box, bottom - box, vol); vol = 0; top = bottom; bottom -= box; }
  }
  return out.bars(b);
}

function lineBreak(b: Bars, n: number): Bars {
  const out = new Out();
  if (!b.c.length) return out.bars(b);
  const lines: { o: number; c: number }[] = [{ o: b.o[0], c: b.c[0] }];
  out.push(b.t[0], b.o[0], Math.max(b.o[0], b.c[0]), Math.min(b.o[0], b.c[0]), b.c[0], b.v[0]);
  let vol = 0;
  for (let i = 1; i < b.c.length; i++) {
    const c = b.c[i], last = lines[lines.length - 1], up = last.c >= last.o;
    vol += b.v[i];
    const recent = lines.slice(-n);
    const hi = Math.max(...recent.map((x) => Math.max(x.o, x.c))), lo = Math.min(...recent.map((x) => Math.min(x.o, x.c)));
    let next: { o: number; c: number } | null = null;
    if ((up && c > last.c) || (!up && c < last.c)) next = { o: last.c, c };
    else if (up && c < lo) next = { o: last.o, c };
    else if (!up && c > hi) next = { o: last.o, c };
    if (next) { lines.push(next); out.push(b.t[i], next.o, Math.max(next.o, next.c), Math.min(next.o, next.c), next.c, vol); vol = 0; }
  }
  return out.bars(b);
}

function rangeBars(b: Bars, r: number): Bars {
  const out = new Out();
  if (!b.c.length) return out.bars(b);
  let cur = { o: b.o[0], h: b.o[0], l: b.o[0] }, vol = 0, prevP = b.o[0];
  const feed = (t: number, p: number) => {
    const rising = p >= prevP;
    prevP = p;
    cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p);
    while (cur.h - cur.l > r + 1e-12) {
      if (rising) { const top = cur.l + r; out.push(t, cur.o, top, cur.l, top, vol); vol = 0; cur = { o: top, h: Math.max(p, top), l: top }; }
      else { const bot = cur.h - r; out.push(t, cur.o, cur.h, bot, bot, vol); vol = 0; cur = { o: bot, h: bot, l: Math.min(p, bot) }; }
    }
  };
  for (let i = 0; i < b.c.length; i++) {
    vol += b.v[i];
    const path = b.c[i] >= b.o[i] ? [b.o[i], b.l[i], b.h[i], b.c[i]] : [b.o[i], b.h[i], b.l[i], b.c[i]];
    path.forEach((p) => feed(b.t[i], p));
  }
  out.push(b.t[b.t.length - 1], cur.o, cur.h, cur.l, b.c[b.c.length - 1], vol); // the bar still forming
  return out.bars(b);
}

/** Kagi: one point per reversal. Thick/yang (up colour) above the last shoulder, thin/yin below the last waist. */
function kagi(b: Bars, rev: number): Bars {
  const out = new Out();
  if (!b.c.length) return out.bars(b);
  let dir = 0, ext = b.c[0], start = b.c[0], vol = 0, yang = true, shoulder = -Infinity, waist = Infinity, startT = b.t[0];
  const emit = (t: number, from: number, to: number) => {
    if (to > shoulder && to > from) yang = true;
    if (to < waist && to < from) yang = false;
    out.push(t, from, Math.max(from, to), Math.min(from, to), to, vol, yang ? 1 : -1);
    vol = 0;
  };
  for (let i = 0; i < b.c.length; i++) {
    const c = b.c[i];
    vol += b.v[i];
    if (dir === 0) {
      if (Math.abs(c - start) >= rev) { dir = c > start ? 1 : -1; ext = c; out.push(startT, start, start, start, start, 0, 1); }
      continue;
    }
    if (dir === 1) {
      if (c > ext) ext = c;
      else if (ext - c >= rev) { emit(b.t[i], start, ext); shoulder = ext; start = ext; dir = -1; ext = c; }
    } else {
      if (c < ext) ext = c;
      else if (c - ext >= rev) { emit(b.t[i], start, ext); waist = ext; start = ext; dir = 1; ext = c; }
    }
  }
  if (dir !== 0) emit(b.t[b.t.length - 1], start, ext);
  return out.bars(b);
}

/** Point & Figure columns (close-based), drawn as one candle per column: X columns up, O columns down. */
function pnf(b: Bars, box: number, rev: number): Bars {
  const cols: { t: number; up: boolean; top: number; bottom: number; v: number }[] = [];
  if (!b.c.length) return new Out().bars(b);
  const ref = Math.floor(b.c[0] / box) * box;
  let vol = 0;
  for (let i = 0; i < b.c.length; i++) {
    const c = b.c[i];
    vol += b.v[i];
    const col = cols[cols.length - 1];
    if (!col) {
      if (c >= ref + box) cols.push({ t: b.t[i], up: true, bottom: ref + box, top: Math.floor(c / box) * box, v: vol });
      else if (c <= ref - box) cols.push({ t: b.t[i], up: false, top: ref - box, bottom: Math.ceil(c / box) * box, v: vol });
      else continue;
      vol = 0;
    } else if (col.up) {
      if (c >= col.top + box) { col.top = Math.floor(c / box) * box; col.v += vol; vol = 0; }
      else if (c <= col.top - rev * box) { cols.push({ t: b.t[i], up: false, top: col.top - box, bottom: Math.ceil(c / box) * box, v: vol }); vol = 0; }
    } else {
      if (c <= col.bottom - box) { col.bottom = Math.ceil(c / box) * box; col.v += vol; vol = 0; }
      else if (c >= col.bottom + rev * box) { cols.push({ t: b.t[i], up: true, bottom: col.bottom + box, top: Math.floor(c / box) * box, v: vol }); vol = 0; }
    }
  }
  const out = new Out();
  cols.forEach((k) => out.push(k.t, k.up ? k.bottom - box / 2 : k.top + box / 2, k.top + box / 2, k.bottom - box / 2, k.up ? k.top + box / 2 : k.bottom - box / 2, k.v));
  return out.bars(b);
}

export function transform(b: Bars, type: ChartType, opts: BrickOpts): Bars {
  const box = opts.box > 0 ? opts.box : autoBox(b);
  switch (type) {
    case "renko": return renko(b, box);
    case "linebreak": return lineBreak(b, Math.max(1, Math.round(opts.lines)));
    case "kagi": return kagi(b, box);
    case "pnf": return pnf(b, box, Math.max(1, Math.round(opts.reversal)));
    case "range": return rangeBars(b, box);
    default: return b;
  }
}
