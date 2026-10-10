import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { Palette } from "../store";

export function EChart({ option, height = 300, onClick, group }: {
  option: echarts.EChartsOption; height?: number | string; onClick?: (p: any) => void; group?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    if (group) { c.group = group; echarts.connect(group); }
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, [group]);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onClick) return;
    c.on("click", onClick);
    return () => { c.off("click", onClick); };
  }, [onClick]);

  return <div ref={el} className="chart" style={{ height }} />;
}

/** Shared base styling so every chart reads as one system. */
export function baseOption(p: Palette): echarts.EChartsOption {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: "IBM Plex Sans, system-ui, sans-serif", color: p.text2 },
    animationDuration: 450,
    animationThreshold: 1200,
    tooltip: {
      trigger: "axis",
      backgroundColor: p.surface,
      borderColor: p.border,
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: p.text, fontSize: 12 },
      extraCssText: "border-radius:10px;box-shadow:0 12px 28px -12px rgba(0,0,0,.35);",
      axisPointer: { type: "line", lineStyle: { color: p.axis, width: 1 }, crossStyle: { color: p.axis } },
    },
  };
}

export function axisStyle(p: Palette) {
  return {
    axisLine: { show: false, lineStyle: { color: p.axis } },
    axisTick: { show: false },
    axisLabel: { color: p.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: p.grid, type: "solid" as const, opacity: 0.9 } },
  };
}

export function tooltipRow(color: string, name: string, value: string) {
  return `<div style="display:flex;align-items:center;gap:8px;min-width:170px"><span style="width:10px;height:2px;background:${color};border-radius:2px"></span><span style="opacity:.75">${name}</span><b style="margin-left:auto;font-variant-numeric:tabular-nums">${value}</b></div>`;
}
