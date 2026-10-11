// Imperative wrapper around lightweight-charts: one main series, indicator panes, compare
// overlays, alert lines, and the time/price <-> pixel conversions used by the drawing layer.
import {
  AreaSeries, BarSeries, BaselineSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries,
  IChartApi, IPriceLine, ISeriesApi, LineSeries, LineStyle, LineType, Logical, PriceScaleMode, Time, UTCTimestamp,
} from "lightweight-charts";
import type { IndicatorDef } from "./indicators";
import type { Bars, ChartType, IndicatorInst } from "./types";

export interface ChartColors {
  bg: string; text: string; grid: string; border: string; up: string; down: string;
  cross: string; crossLabel: string; line: string; muted: string;
}

export interface IndicatorRender { inst: IndicatorInst; def: IndicatorDef; values: (number | null)[][]; barColors?: (string | undefined)[] }
export type ScaleMode = "normal" | "log" | "percent";

type AnySeries = ISeriesApi<any>;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function precisionFor(price: number) {
  const a = Math.abs(price);
  return a >= 1 ? 2 : a >= 0.1 ? 4 : a >= 0.001 ? 6 : 8;
}

export class ChartEngine {
  chart: IChartApi;
  main: AnySeries | null = null;
  type: ChartType | null = null;
  times: number[] = [];
  step = 60;
  daily = false;
  private shift: (t: number) => number = (t) => t;
  private ind = new Map<string, { sig: string; series: AnySeries[]; pane: number; lines: IPriceLine[] }>();
  private indOrder = "";
  private cmp = new Map<string, AnySeries>();
  private colors: ChartColors;

  constructor(el: HTMLElement, colors: ChartColors) {
    this.colors = colors;
    this.chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 12,
        fontFamily: "Figtree Variable, Figtree, -apple-system, system-ui, sans-serif",
        panes: { separatorColor: colors.border, separatorHoverColor: colors.grid, enableResize: true },
        attributionLogo: true,
      },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.cross, style: LineStyle.Dashed, width: 1, labelBackgroundColor: colors.crossLabel },
        horzLine: { color: colors.cross, style: LineStyle.Dashed, width: 1, labelBackgroundColor: colors.crossLabel },
      },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.08, bottom: 0.08 }, minimumWidth: 64 },
      timeScale: { borderColor: colors.border, rightOffset: 8, barSpacing: 7, minBarSpacing: 0.3, timeVisible: true, secondsVisible: false },
      localization: { timeFormatter: (t: Time) => this.fmtTime(t as number) },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
      kineticScroll: { mouse: false, touch: true },
    });
  }

  destroy() { this.chart.remove(); }

  private fmtTime(t: number) {
    const d = new Date(t * 1000);
    const day = `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
    if (this.daily) return day;
    return `${day}  ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }

  applyColors(c: ChartColors) {
    this.colors = c;
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.bg }, textColor: c.text, panes: { separatorColor: c.border, separatorHoverColor: c.grid } },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: { vertLine: { color: c.cross, labelBackgroundColor: c.crossLabel }, horzLine: { color: c.cross, labelBackgroundColor: c.crossLabel } },
      rightPriceScale: { borderColor: c.border }, timeScale: { borderColor: c.border },
    });
    if (this.type) this.styleMain(this.type);
  }

  setGrid(show: boolean) {
    const c = show ? this.colors.grid : "transparent";
    this.chart.applyOptions({ grid: { vertLines: { color: c }, horzLines: { color: c } } });
  }

  setCrosshairMagnet(on: boolean) {
    this.chart.applyOptions({ crosshair: { mode: on ? CrosshairMode.MagnetOHLC : CrosshairMode.Normal } });
  }

  /** Disable chart panning/zooming while a drawing is dragged. */
  setInteractive(on: boolean) {
    this.chart.applyOptions({ handleScroll: on, handleScale: on });
  }

  private styleMain(type: ChartType) {
    const c = this.colors, s = this.main;
    if (!s) return;
    const common = { priceLineStyle: LineStyle.Dotted, priceLineWidth: 1 as const };
    if (type === "candles" || type === "heikin")
      s.applyOptions({ ...common, upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
    else if (type === "renko" || type === "linebreak" || type === "pnf" || type === "range")
      s.applyOptions({ ...common, upColor: c.up + "cc", downColor: c.down + "cc", borderVisible: true, borderUpColor: c.up, borderDownColor: c.down, wickVisible: type === "range", wickUpColor: c.up, wickDownColor: c.down });
    else if (type === "kagi") s.applyOptions({ ...common, color: c.up, lineWidth: 2, lineType: LineType.WithSteps, priceLineColor: c.muted });
    else if (type === "hollow")
      s.applyOptions({ ...common, upColor: "rgba(0,0,0,0)", downColor: c.down, borderVisible: true, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    else if (type === "bars") s.applyOptions({ ...common, upColor: c.up, downColor: c.down, thinBars: false });
    else if (type === "line" || type === "step") s.applyOptions({ ...common, color: c.line, lineWidth: 2, lineType: type === "step" ? LineType.WithSteps : LineType.Simple, priceLineColor: c.line });
    else if (type === "area") s.applyOptions({ ...common, lineColor: c.line, topColor: c.line + "55", bottomColor: c.line + "05", lineWidth: 2, priceLineColor: c.line });
    else if (type === "baseline") s.applyOptions({ ...common, topLineColor: c.up, bottomLineColor: c.down, topFillColor1: c.up + "40", topFillColor2: c.up + "08", bottomFillColor1: c.down + "08", bottomFillColor2: c.down + "40", lineWidth: 2 });
    else if (type === "columns") s.applyOptions({ ...common, priceLineColor: c.muted });
  }

  /** Replace the main series data. `display` may differ from `real` (Heikin Ashi). */
  setBars(real: Bars, display: Bars, type: ChartType, shift: (t: number) => number, daily: boolean) {
    this.times = real.t;
    this.daily = daily;
    this.shift = shift;
    const n = real.t.length;
    const diffs: number[] = [];
    for (let i = Math.max(1, n - 60); i < n; i++) diffs.push(real.t[i] - real.t[i - 1]);
    diffs.sort((a, b) => a - b);
    this.step = diffs.length ? diffs[Math.floor(diffs.length / 2)] || 60 : 60;
    this.chart.applyOptions({ timeScale: { timeVisible: !daily } });

    if (this.type !== type || !this.main) {
      const candleLike = ["candles", "hollow", "heikin", "renko", "linebreak", "pnf", "range"].includes(type);
      const def = candleLike ? CandlestickSeries : type === "bars" ? BarSeries
        : type === "area" ? AreaSeries : type === "baseline" ? BaselineSeries : type === "columns" ? HistogramSeries : LineSeries;
      // Add the new series before removing the old one: an empty pane 0 would be dropped by the
      // library and the first indicator pane would slide into its place.
      const old = this.main;
      this.main = this.chart.addSeries(def as any, {}, 0);
      if (old) this.chart.removeSeries(old);
      this.type = type;
      this.styleMain(type);
    }
    const last = display.c[n - 1] ?? 1;
    const prec = precisionFor(last);
    this.main.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    const T = (i: number) => shift(display.t[i]) as UTCTimestamp;
    let data: any[];
    if (["candles", "hollow", "heikin", "bars", "renko", "linebreak", "pnf", "range"].includes(type))
      data = display.t.map((_, i) => ({ time: T(i), open: display.o[i], high: display.h[i], low: display.l[i], close: display.c[i] }));
    else if (type === "kagi")
      data = display.t.map((_, i) => ({ time: T(i), value: display.c[i], color: display.dir?.[i] === -1 ? this.colors.down : this.colors.up }));
    else if (type === "columns")
      data = display.t.map((_, i) => ({ time: T(i), value: display.c[i], color: (display.c[i] >= (display.c[i - 1] ?? display.o[i]) ? this.colors.up : this.colors.down) + "cc" }));
    else data = display.t.map((_, i) => ({ time: T(i), value: display.c[i] }));
    if (type === "baseline" && n) {
      const vals = display.c.slice(-300);
      this.main.applyOptions({ baseValue: { type: "price", price: vals.reduce((a, b) => a + b, 0) / vals.length } });
    }
    this.main.setData(data);
  }

  setScale(mode: ScaleMode, auto: boolean) {
    this.chart.priceScale("right").applyOptions({
      mode: mode === "log" ? PriceScaleMode.Logarithmic : mode === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
      autoScale: auto,
    });
  }

  // ------------------------------------------------------------- indicators
  setIndicators(list: IndicatorRender[]) {
    const visible = list.filter((r) => !r.inst.hidden);
    const order = visible.map((r) => `${r.inst.id}|${JSON.stringify(r.inst.inputs)}|${r.inst.colors.join(",")}`).join(";");
    const T = (i: number) => this.shift(this.times[i]) as UTCTimestamp;
    if (order !== this.indOrder) {
      for (const v of this.ind.values()) v.series.forEach((s) => this.chart.removeSeries(s));
      this.ind.clear();
      for (let i = this.chart.panes().length - 1; i >= 1; i--) {
        try { this.chart.removePane(i); } catch { /* already gone */ }
      }
      let pane = 0;
      for (const r of visible) {
        const p = r.def.overlay ? 0 : ++pane;
        const series: AnySeries[] = [];
        r.def.plots.forEach((pl, k) => {
          const color = r.inst.colors[k] || pl.color;
          const base = { priceLineVisible: false, lastValueVisible: !r.def.overlay || r.def.id !== "vol", crosshairMarkerVisible: false, title: "" };
          const volScale = r.def.id === "vol" ? { priceScaleId: "vol" } : {};
          let s: AnySeries;
          if (pl.kind === "histogram") s = this.chart.addSeries(HistogramSeries, { ...base, ...volScale, color, priceFormat: r.def.id === "vol" ? { type: "volume" } : undefined }, p);
          else if (pl.kind === "area") s = this.chart.addSeries(AreaSeries, { ...base, lineColor: color, topColor: color + "40", bottomColor: color + "05", lineWidth: 1 }, p);
          else s = this.chart.addSeries(LineSeries, {
            ...base, ...volScale, color, lineWidth: (pl.width ?? 1) as any, lineType: pl.kind === "step" ? LineType.WithSteps : LineType.Simple,
            lineVisible: pl.kind !== "dots", pointMarkersVisible: pl.kind === "dots", pointMarkersRadius: 1.6,
          }, p);
          if (r.def.id === "vol") s.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
          series.push(s);
        });
        const lines = (r.def.levels || []).map((lv) => series[series.length - 1].createPriceLine({
          price: lv, color: this.colors.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "",
        }));
        this.ind.set(r.inst.id, { sig: order, series, pane: p, lines });
      }
      const panes = this.chart.panes();
      panes.forEach((pn, i) => pn.setStretchFactor(i === 0 ? 2 + (panes.length - 1) : 1));
      this.indOrder = order;
    }
    for (const r of visible) {
      const entry = this.ind.get(r.inst.id);
      if (!entry) continue;
      r.values.forEach((vals, k) => {
        const s = entry.series[k];
        if (!s) return;
        const isHist = r.def.plots[k].kind === "histogram";
        const data = vals.map((v, i) => (v == null || !Number.isFinite(v) ? { time: T(i) }
          : isHist && r.barColors?.[i] ? { time: T(i), value: v, color: r.barColors[i] } : { time: T(i), value: v }));
        s.setData(data);
      });
    }
  }

  // ------------------------------------------------------------- compare symbols
  setCompare(list: { symbol: string; label?: string; color: string; bars: Bars | null }[]) {
    const keep = new Set(list.map((c) => c.symbol));
    for (const [sym, s] of this.cmp) if (!keep.has(sym)) { this.chart.removeSeries(s); this.cmp.delete(sym); }
    for (const c of list) {
      let s = this.cmp.get(c.symbol);
      if (!s) {
        s = this.chart.addSeries(LineSeries, { color: c.color, lineWidth: 2, priceLineVisible: false, title: c.label ?? c.symbol, crosshairMarkerVisible: false }, 0);
        this.cmp.set(c.symbol, s);
      }
      if (!c.bars) continue;
      const first = this.times[0] ?? 0, last = this.times[this.times.length - 1] ?? Infinity;
      const data: any[] = [];
      let prevT = -Infinity;
      c.bars.t.forEach((t, i) => {
        if (t < first || t > last) return;
        const st = this.shift(t);
        if (st <= prevT) return;
        prevT = st;
        data.push({ time: st as UTCTimestamp, value: c.bars!.c[i] });
      });
      s.setData(data);
    }
  }

  // ------------------------------------------------------------- coordinates
  tToLogical(t: number): number {
    const ts = this.times, n = ts.length;
    if (!n) return 0;
    if (t <= ts[0]) return (t - ts[0]) / this.step;
    if (t >= ts[n - 1]) return n - 1 + (t - ts[n - 1]) / this.step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    return lo + (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
  }

  logicalToT(l: number): number {
    const ts = this.times, n = ts.length;
    if (!n) return 0;
    if (l <= 0) return ts[0] + l * this.step;
    if (l >= n - 1) return ts[n - 1] + (l - (n - 1)) * this.step;
    const i = Math.floor(l);
    return ts[i] + (l - i) * (ts[i + 1] - ts[i]);
  }

  toX(t: number): number | null {
    return this.chart.timeScale().logicalToCoordinate(this.tToLogical(t) as Logical);
  }
  toY(p: number): number | null {
    return this.main ? this.main.priceToCoordinate(p) : null;
  }
  fromX(x: number): number {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return this.logicalToT(l == null ? 0 : (l as number));
  }
  fromY(y: number): number {
    const p = this.main?.coordinateToPrice(y);
    return p == null ? 0 : (p as number);
  }
  indexAt(x: number): number {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return l == null ? -1 : Math.round(l as number);
  }

  layout() {
    const panes = this.chart.panes().map((p) => p.getHeight());
    const tops: number[] = [];
    let y = 0;
    panes.forEach((h) => { tops.push(y); y += h + 1; });
    return { panes, tops, plotW: this.chart.timeScale().width(), scaleW: this.chart.priceScale("right").width() };
  }

  /** Cheap fingerprint of everything that moves drawings on screen. */
  signature(): string {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const l = this.layout();
    const p0 = this.times.length && this.main ? this.toY(1) : 0, p1 = this.main ? this.toY(100) : 0;
    return `${r?.from?.toFixed(3)}|${r?.to?.toFixed(3)}|${p0?.toFixed(2)}|${p1?.toFixed(2)}|${l.panes.join(",")}|${l.plotW}`;
  }
}
