import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, IChartApi,
  LineSeries, LineStyle, SeriesMarker, Time, UTCTimestamp,
} from "lightweight-charts";
import { BacktestResult, Trade } from "../api";
import { num, pct } from "../format";
import { usePalette } from "../store";

interface Props {
  res: BacktestResult;
  symbol: string;
  height?: number;
  showTrades?: boolean;
  showVolume?: boolean;
  focusTrade?: Trade | null;
}

export function PriceChart({ res, symbol, height = 520, showTrades = true, showVolume = true, focusTrade }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const p = usePalette();
  const [legend, setLegend] = useState<{ o: number; h: number; l: number; c: number; chg: number } | null>(null);
  const data = res.symbols[symbol];

  const oscillators = useMemo(() => (data?.indicators || []).filter((i) => !i.overlay), [data]);

  useEffect(() => {
    if (!el.current || !data) return;
    const t = res.series.t;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" }, textColor: p.muted, fontSize: 13,
        fontFamily: "Figtree Variable, Figtree, system-ui, sans-serif",
        panes: { separatorColor: p.grid, separatorHoverColor: p.axis, enableResize: true },
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: p.grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: p.axis, labelBackgroundColor: p.surface2 }, horzLine: { color: p.axis, labelBackgroundColor: p.surface2 } },
      rightPriceScale: { borderColor: p.grid },
      timeScale: { borderColor: p.grid, timeVisible: res.request.interval !== "1d" && !res.request.interval.endsWith("wk") && !res.request.interval.endsWith("mo"), rightOffset: 4, minBarSpacing: 0.05 },
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: p.pos, downColor: p.neg, borderVisible: false, wickUpColor: p.pos, wickDownColor: p.neg,
      priceLineColor: p.axis,
    });
    const cdata: any[] = [];
    for (let i = 0; i < t.length; i++) {
      const o = data.open[i], h = data.high[i], l = data.low[i], c = data.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      cdata.push({ time: t[i] as UTCTimestamp, open: o, high: h, low: l, close: c });
    }
    candles.setData(cdata);

    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      const vdata: any[] = [];
      for (let i = 0; i < t.length; i++) {
        const v = data.volume[i], o = data.open[i], c = data.close[i];
        if (v == null || o == null || c == null) continue;
        vdata.push({ time: t[i] as UTCTimestamp, value: v, color: (c >= o ? p.pos : p.neg) + "33" });
      }
      vol.setData(vdata);
    }

    // Indicators: overlays on the price pane, oscillators each in their own pane (grouped by family).
    const palette = [p.series[0], p.series[1], p.series[6], p.series[2], p.series[3], p.series[4]];
    let k = 0;
    const paneFor = new Map<string, number>();
    data.indicators.forEach((ind) => {
      let pane = 0;
      if (!ind.overlay) {
        const fam = ind.name.split(/[\s[]/)[0];
        if (!paneFor.has(fam)) paneFor.set(fam, paneFor.size + 1);
        pane = paneFor.get(fam)!;
      }
      const color = palette[k++ % palette.length];
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: ind.overlay ? 2 : 1, priceLineVisible: false, lastValueVisible: !ind.overlay, title: ind.overlay ? "" : ind.name,
        crosshairMarkerVisible: false,
        lineStyle: /lower|upper/i.test(ind.name) ? LineStyle.Dashed : LineStyle.Solid,
      }, pane);
      const d: any[] = [];
      for (let i = 0; i < t.length; i++) {
        const v = ind.values[i];
        d.push(v == null ? { time: t[i] as UTCTimestamp } : { time: t[i] as UTCTimestamp, value: v });
      }
      s.setData(d);
    });
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);

    if (showTrades) {
      const trades = res.trades.filter((tr) => tr.symbol === symbol);
      const markers: SeriesMarker<Time>[] = [];
      for (const tr of trades) {
        const long = tr.side === "Long";
        markers.push({ time: tr.entry_time as UTCTimestamp, position: long ? "belowBar" : "aboveBar", color: long ? p.series[0] : p.series[1],
          shape: long ? "arrowUp" : "arrowDown", text: trades.length <= 15 ? (long ? "Long" : "Short") : "" });
        markers.push({ time: tr.exit_time as UTCTimestamp, position: long ? "aboveBar" : "belowBar", color: tr.pnl >= 0 ? p.pos : p.neg,
          shape: "circle", text: trades.length <= 15 ? pct(tr.return_pct, 1) : "" });
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      createSeriesMarkers(candles, markers);
    }

    chart.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(candles) as any;
      if (d && d.open != null) setLegend({ o: d.open, h: d.high, l: d.low, c: d.close, chg: (d.close / d.open - 1) * 100 });
      else setLegend(null);
    });
    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [res, symbol, data, p, showTrades, showVolume]);

  useEffect(() => {
    if (!focusTrade || !chartRef.current) return;
    const pad = Math.max((focusTrade.exit_time - focusTrade.entry_time) * 0.6, 86400 * 20);
    chartRef.current.timeScale().setVisibleRange({
      from: (focusTrade.entry_time - pad) as UTCTimestamp, to: (focusTrade.exit_time + pad) as UTCTimestamp,
    });
  }, [focusTrade]);

  if (!data) return <div className="empty">No price data for {symbol}</div>;
  const last = data.close.filter((v) => v != null).slice(-1)[0];
  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", top: 6, left: 10, zIndex: 3, fontSize: 14, display: "flex", gap: 12, pointerEvents: "none" }} className="num">
        <b>{symbol}</b>
        {legend ? (
          <>
            <span className="muted">O <span className="dim">{num(legend.o)}</span></span>
            <span className="muted">H <span className="dim">{num(legend.h)}</span></span>
            <span className="muted">L <span className="dim">{num(legend.l)}</span></span>
            <span className="muted">C <span className="dim">{num(legend.c)}</span></span>
            <span className={legend.chg >= 0 ? "pos" : "neg"}>{pct(legend.chg)}</span>
          </>
        ) : <span className="dim">{num(last)}</span>}
      </div>
      <div ref={el} style={{ height: height + oscillators.length * 40 }} />
    </div>
  );
}
