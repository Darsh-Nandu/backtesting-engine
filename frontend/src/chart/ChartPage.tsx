// The Analyze workspace for your own CSV data: a charting terminal (intervals, chart types,
// indicators, drawing tools, bar replay, layouts, dataset details) and a quant Analysis view.
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AreaChart, BarChart3, BrickWall, ChartCandlestick, FileSpreadsheet, LineChart as LineIcon, Waypoints, Calendar, Camera, CandlestickChart, ChevronDown, CirclePlus, Copy, Eye, EyeOff, FastForward,
  LayoutGrid, LineChart, Lock, Maximize, Minimize, Pause, Play, Rewind, Redo2, Search, Settings, Settings2, StepForward,
  Trash2, Undo2, Unlock, X,
} from "lucide-react";
import { useApp } from "../store";
import { chartApi, Dataset, LayoutMeta } from "./api";
import { DrawingLayer, Magnet } from "./DrawingLayer";
import { ChartColors, ChartEngine, IndicatorRender, precisionFor, ScaleMode } from "./engine";
import { defaultInputs, heikinAshi, INDICATOR_MAP, IndicatorDef, indLabel, setDayKey, TEMPLATES } from "./indicators";
import { DataRow, fmtBig, PANEL_TABS, PanelTab, RightPanel, VisibleStats } from "./panels";
import { EMOJIS, GROUPS, ICONS, SWATCHES, TOOLS } from "./tools";
import type { Bars, ChartType, Drawing, IndicatorInst, Interval, Quote, Replay, ToolId } from "./types";
import { INTERVALS, isDaily } from "./types";
import { makeShift, offsetLabel, resolveTz, TIMEZONES } from "./tz";
import { DatasetDialog, DatasetList, IndicatorSettings, IndicatorsDialog, MenuItem, Popover } from "./ui";
import { AnalysisView } from "./AnalysisView";
import { volumeProfile } from "./analysis";
import { autoBox, isTransformed, transform } from "./transforms";
import "./chart.css";

// ---------------------------------------------------------------- persisted state
interface Settings {
  symbol: string; interval: Interval; type: ChartType; tz: string;
  scale: ScaleMode; autoScale: boolean; grid: boolean; crossMagnet: boolean; magnet: Magnet; stay: boolean;
  lockAll: boolean; hideDrawings: boolean; hideIndicators: boolean; icon: string; panel: PanelTab | null;
  compare: string[]; layoutId: string | null; layoutName: string; favIntervals: Interval[]; favInd: string[];
  box: number; reversal: number; lines: number;
}
interface Doc { drawings: Record<string, Drawing[]>; indicators: IndicatorInst[] }

const DEFAULTS: Settings = {
  symbol: "", interval: "1D", type: "candles", tz: "UTC", scale: "normal", autoScale: true,
  grid: true, crossMagnet: false, magnet: "off", stay: false, lockAll: false, hideDrawings: false, hideIndicators: false, icon: "🚀",
  panel: null, compare: [], layoutId: null, layoutName: "Unnamed", favIntervals: ["5m", "15m", "1h", "1D", "1W"], favInd: [],
  box: 0, reversal: 3, lines: 3,
};
const CMP_COLORS = ["#ff9800", "#9c27b0", "#00bcd4", "#e91e63", "#795548", "#4caf50"];

function load<T>(key: string, fb: T): T {
  try { const v = localStorage.getItem(key); return v ? (Array.isArray(fb) ? JSON.parse(v) : { ...fb, ...JSON.parse(v) }) : fb; } catch { return fb; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota / private mode */ } }
const uid = () => Math.random().toString(36).slice(2, 10);
const isCsvSym = (x: string) => /^CSV:/i.test(x || "");
/** Analyze works on uploaded CSV data only: drop market symbols left over from older settings or layouts. */
function sanitize(x: Settings): Settings {
  return { ...x, symbol: isCsvSym(x.symbol) ? x.symbol : "", compare: (x.compare || []).filter(isCsvSym), panel: PANEL_TABS.some((t) => t.id === x.panel) ? x.panel : null };
}

const CHART_TYPES: { id: ChartType; label: string; icon: ReactNode }[] = [
  { id: "bars", label: "Bars", icon: <BarChart3 size={18} /> },
  { id: "candles", label: "Candles", icon: <CandlestickChart size={18} /> },
  { id: "hollow", label: "Hollow candles", icon: <CandlestickChart size={18} strokeWidth={1.3} /> },
  { id: "heikin", label: "Heikin Ashi", icon: <CandlestickChart size={18} /> },
  { id: "line", label: "Line", icon: <LineChart size={18} /> },
  { id: "step", label: "Step line", icon: <LineChart size={18} /> },
  { id: "area", label: "Area", icon: <AreaChart size={18} /> },
  { id: "baseline", label: "Baseline", icon: <AreaChart size={18} /> },
  { id: "columns", label: "Columns", icon: <BarChart3 size={18} /> },
  { id: "renko", label: "Renko", icon: <BrickWall size={18} /> },
  { id: "linebreak", label: "Line break", icon: <ChartCandlestick size={18} /> },
  { id: "kagi", label: "Kagi", icon: <LineIcon size={18} /> },
  { id: "pnf", label: "Point & figure", icon: <Waypoints size={18} /> },
  { id: "range", label: "Range bars", icon: <BarChart3 size={18} /> },
];

const RANGES: { id: string; interval: Interval; kind: "sessions" | "days" | "ytd" | "all"; n?: number }[] = [
  { id: "1D", interval: "1m", kind: "sessions", n: 1 }, { id: "5D", interval: "5m", kind: "sessions", n: 5 },
  { id: "1M", interval: "30m", kind: "days", n: 31 }, { id: "3M", interval: "1h", kind: "days", n: 92 },
  { id: "6M", interval: "4h", kind: "days", n: 183 }, { id: "YTD", interval: "1D", kind: "ytd" },
  { id: "1Y", interval: "1D", kind: "days", n: 366 }, { id: "5Y", interval: "1W", kind: "days", n: 1827 },
  { id: "All", interval: "1M", kind: "all" },
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtBarTime(t: number, daily: boolean, shift: (t: number) => number) {
  const d = new Date(shift(t) * 1000);
  const s = `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  return daily ? s : `${s} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Chart colours follow the app palette (CSS custom properties); candle colours stay fixed. */
function chartColors(dark: boolean): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    bg: v("--surface"), text: v("--text-2"), grid: v("--grid"), border: v("--border"), up: "#089981", down: "#f23645",
    cross: v("--muted"), crossLabel: dark ? v("--surface-3") : v("--text"), line: v("--accent"), muted: v("--muted"),
  };
}

function sliceBars(b: Bars, n: number): Bars {
  return { ...b, t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) };
}

/** A toolbar button. Defined at module level so React keeps the same DOM node across renders. */
function ToolBtn({ id, title, active, onClick, children }: { id?: string; title: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return <button className={`ct-tool ${active ? "on" : ""}`} onClick={onClick} title={title} aria-label={title} aria-pressed={active} data-tool={id}>{children}</button>;
}

// ================================================================= component
export function ChartPage({ view }: { view: "chart" | "analysis" }) {
  const { theme, palette, toast } = useApp();
  const [s, setS] = useState<Settings>(() => sanitize(load("qf.chart.settings", DEFAULTS)));
  const upd = useCallback((patch: Partial<Settings>) => setS((x) => ({ ...x, ...patch })), []);
  useEffect(() => { save("qf.chart.settings", s); }, [s]);

  // ---- drawings + indicators with undo / redo
  const [doc, setDocState] = useState<Doc>(() => load("qf.chart.doc", { drawings: {}, indicators: [] as IndicatorInst[] }));
  const docRef = useRef(doc);
  const past = useRef<Doc[]>([]), future = useRef<Doc[]>([]), base = useRef<Doc | null>(null);
  const [, setHist] = useState(0);
  const change = useCallback((fn: (d: Doc) => Doc, commit = true) => {
    const cur = docRef.current, next = fn(cur);
    if (commit) {
      past.current.push(base.current ?? cur); base.current = null; future.current = [];
      if (past.current.length > 100) past.current.shift();
      setHist((h) => h + 1);
    } else if (!base.current) base.current = cur;
    docRef.current = next;
    setDocState(next);
  }, []);
  const undo = () => { const p = past.current.pop(); if (!p) return; future.current.push(docRef.current); docRef.current = p; setDocState(p); setHist((h) => h + 1); };
  const redo = () => { const f = future.current.pop(); if (!f) return; past.current.push(docRef.current); docRef.current = f; setDocState(f); setHist((h) => h + 1); };
  useEffect(() => { const id = setTimeout(() => save("qf.chart.doc", doc), 300); return () => clearTimeout(id); }, [doc]);

  const [myTemplates, setMyTemplates] = useState(() => load("qf.chart.templates", [] as { name: string; items: { type: string; inputs: any; colors: string[] }[] }[]));
  useEffect(() => save("qf.chart.templates", myTemplates), [myTemplates]);

  // ---- ui state
  const [tool, setToolRaw] = useState<ToolId>("cross");
  const [lastInGroup, setLastInGroup] = useState<Record<string, ToolId>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "symbol" | "compare" } | { kind: "indicators" } | { kind: "settings"; id: string }>(null);
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  // A failed request leaves the list unknown (not empty), so it never clears the dataset you have open.
  const refreshDatasets = useCallback(() => chartApi.uploads().then(setDatasets).catch(() => { /* keep what we had */ }), []);
  useEffect(() => { refreshDatasets(); }, [refreshDatasets]);
  const [ctx, setCtx] = useState<{ x: number; y: number; price: number | null } | null>(null);
  const [replay, setReplay] = useState<Replay>({ selecting: false, active: false, index: 0, playing: false, speed: 1000 });
  const [fullscreen, setFullscreen] = useState(false);
  const [layouts, setLayouts] = useState<LayoutMeta[]>([]);
  const [now, setNow] = useState(Date.now());
  const [plusHover, setPlusHover] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const uploadCsv = async (file: File) => {
    if (!/\.(csv|txt)$/i.test(file.name)) { toast("Please drop a .csv file", "err"); return; }
    try {
      const info = await chartApi.upload(file);
      refreshDatasets();
      toast(`Loaded ${info.name}: ${info.rows.toLocaleString()} rows`);
      setSymbol(`CSV:${info.name}`);
    } catch (e: any) { toast(e.message || String(e), "err"); }
  };
  const setTool = (t: ToolId) => {
    setToolRaw(t);
    const g = GROUPS.find((x) => x.tools.includes(t));
    if (g) setLastInGroup((m) => ({ ...m, [g.id]: t }));
  };

  // ---- data
  const [bars, setBars] = useState<Bars | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cmpBars, setCmpBars] = useState<Record<string, Bars>>({});
  const pendingRange = useRef<(typeof RANGES)[number] | null>(null);
  const daily = isDaily(s.interval);
  const isCsv = isCsvSym(s.symbol);
  const csvName = isCsv ? s.symbol.slice(4) : "";
  const secs = (i: Interval) => INTERVALS.find((x) => x.id === i)?.seconds ?? 0;
  const tooFine = (i: Interval) => isCsv && !!bars?.native && secs(i) < secs(bars.native);

  // Open the first dataset when none is selected (or the selected one was deleted).
  useEffect(() => {
    if (!datasets) return;
    const have = datasets.some((d) => `CSV:${d.name}`.toUpperCase() === s.symbol.toUpperCase());
    if (!have) upd({ symbol: datasets.length ? `CSV:${datasets[0].name}` : "", compare: s.compare.filter((c) => datasets.some((d) => `CSV:${d.name}`.toUpperCase() === c.toUpperCase())) });
  }, [datasets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let off = false;
    setError(null);
    if (!s.symbol) { setBars(null); setLoading(false); return; }
    setLoading(true);
    chartApi.bars(s.symbol, s.interval)
      .then((b) => {
        if (off) return;
        setBars(b);
        setReplay((r) => ({ ...r, active: false, selecting: false, playing: false }));
        // A CSV can't be shown finer than its own interval: follow what the server returned.
        if (b.interval !== s.interval) upd({ interval: b.interval });
      })
      .catch((e) => { if (!off) setError(e.message || String(e)); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [s.symbol, s.interval]);

  // Compare symbols
  useEffect(() => {
    let off = false;
    s.compare.forEach((sym) => {
      chartApi.bars(sym, s.interval).then((b) => { if (!off) setCmpBars((m) => ({ ...m, [sym]: b })); })
        .catch((e) => { if (!off) { toast(`Couldn't load ${sym}: ${e.message}`, "err"); upd({ compare: s.compare.filter((x) => x !== sym) }); } });
    });
    return () => { off = true; };
  }, [s.compare.join(","), s.interval]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derived data
  const rawDisplay = useMemo(() => (bars && replay.active ? sliceBars(bars, replay.index + 1) : bars), [bars, replay.active, replay.index]);
  const transformed = isTransformed(s.type);
  const boxUsed = useMemo(() => (rawDisplay && transformed ? (s.box > 0 ? s.box : autoBox(rawDisplay)) : 0), [rawDisplay, transformed, s.box]);
  const displayBars = useMemo(() => (rawDisplay && transformed ? transform(rawDisplay, s.type, { box: boxUsed, reversal: s.reversal, lines: s.lines }) : rawDisplay),
    [rawDisplay, transformed, s.type, boxUsed, s.reversal, s.lines]);
  const chartBars = useMemo(() => (displayBars && s.type === "heikin" ? heikinAshi(displayBars) : displayBars), [displayBars, s.type]);
  const exchangeTz = bars?.timezone || "UTC";
  const tzName = resolveTz(s.tz, exchangeTz);
  const shift = useMemo(() => (daily ? (t: number) => t : makeShift(tzName)), [daily, tzName]);
  const colors = useMemo(() => chartColors(theme === "dark"), [theme, palette]);
  const prec = precisionFor(bars?.c[bars.c.length - 1] ?? 1);

  const renders = useMemo<IndicatorRender[]>(() => {
    if (!displayBars || !displayBars.t.length) return [];
    setDayKey((t) => Math.floor(shift(t) / 86400));
    return doc.indicators.map((inst) => {
      const def = INDICATOR_MAP[inst.type];
      if (!def) return null;
      const inputs = { ...defaultInputs(def), ...inst.inputs };
      const values = def.calc(displayBars, inputs);
      return { inst: s.hideIndicators ? { ...inst, hidden: true } : inst, def, values, barColors: def.barColors?.(displayBars, values, colors.up, colors.down) };
    }).filter(Boolean) as IndicatorRender[];
  }, [displayBars, doc.indicators, shift, colors, s.hideIndicators]);

  // ---- chart engine
  const rootRef = useRef<HTMLDivElement>(null);
  const chartEl = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ChartEngine | null>(null);
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number; pane: number } | null>(null);
  useEffect(() => {
    const e = new ChartEngine(chartEl.current!, chartColors(document.documentElement.dataset.theme === "dark"));
    setEngine(e);
    const onMove = (p: any) => {
      if (!p.point || p.logical == null) setHover(null);
      else setHover({ idx: Math.round(p.logical), x: p.point.x, y: p.point.y, pane: p.paneIndex ?? 0 });
    };
    e.chart.subscribeCrosshairMove(onMove);
    e.chart.subscribeClick(() => { setSelected(null); setCtx(null); });
    let raf = 0, last = "";
    const loop = () => { const sig = e.signature(); if (sig !== last) { last = sig; setTick((t) => t + 1); } raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); e.destroy(); };
  }, []);

  useEffect(() => { engine?.applyColors(colors); }, [engine, colors]);
  useEffect(() => { engine?.setGrid(s.grid); }, [engine, s.grid, colors]);
  useEffect(() => { engine?.setCrosshairMagnet(s.crossMagnet); }, [engine, s.crossMagnet]);

  const appliedKey = useRef("");
  const applyRange = useCallback((r: (typeof RANGES)[number] | null) => {
    if (!engine || !displayBars) return;
    const t = displayBars.t, n = t.length;
    const ts = engine.chart.timeScale();
    if (!n) return;
    if (!r) { ts.setVisibleLogicalRange({ from: Math.max(0, n - 250), to: n + 8 }); return; }
    let from = t[0];
    const last = t[n - 1];
    if (r.kind === "all") { ts.fitContent(); return; }
    if (r.kind === "ytd") from = Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000;
    if (r.kind === "days") from = last - (r.n || 1) * 86400;
    if (r.kind === "sessions") {
      const ex = makeShift(exchangeTz), day = (x: number) => Math.floor(ex(x) / 86400);
      let seen = 1, i = n - 1;
      while (i > 0) { if (day(t[i - 1]) !== day(t[i])) { if (seen >= (r.n || 1)) break; seen++; } i--; }
      from = t[i];
    }
    const i0 = t.findIndex((x) => x >= from);
    ts.setVisibleLogicalRange({ from: Math.max(0, i0 < 0 ? 0 : i0) - 0.5, to: n + 2 });
  }, [engine, displayBars, exchangeTz]);

  useEffect(() => {
    if (!engine || !displayBars || !chartBars) return;
    engine.setBars(displayBars, chartBars, s.type, shift, daily);
    const key = `${displayBars.symbol}|${displayBars.interval}`;
    if (appliedKey.current !== key) {
      appliedKey.current = key;
      applyRange(pendingRange.current);
      pendingRange.current = null;
    }
  }, [engine, displayBars, chartBars, s.type, shift, daily]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (engine && displayBars) engine.setIndicators(renders); }, [engine, renders, displayBars]);
  useEffect(() => {
    if (!engine || !displayBars) return;
    engine.setCompare(s.compare.map((sym, i) => ({ symbol: sym, label: sym.replace(/^CSV:/i, ""), color: CMP_COLORS[i % CMP_COLORS.length], bars: cmpBars[sym] || null })));
  }, [engine, s.compare, cmpBars, displayBars, shift]);
  useEffect(() => { engine?.setScale(s.compare.length ? "percent" : s.scale, s.autoScale); }, [engine, s.scale, s.autoScale, s.compare.length]);
  // ---- replay playback
  useEffect(() => {
    if (!replay.active || !replay.playing || !bars) return;
    const id = setInterval(() => setReplay((r) => {
      if (r.index >= bars.t.length - 1) return { ...r, playing: false };
      return { ...r, index: r.index + 1 };
    }), replay.speed);
    return () => clearInterval(id);
  }, [replay.active, replay.playing, replay.speed, bars]);

  const startReplayAt = (pick: number) => {
    // On price-based charts (Renko etc.) the picked brick maps back to the bar that completed it.
    let index = pick;
    if (transformed && displayBars && bars) { const t = displayBars.t[pick]; index = Math.max(0, bars.t.findIndex((x) => x > t) - 1); if (index < 0) index = bars.t.length - 1; }
    setReplay((r) => ({ ...r, selecting: false, active: true, index, playing: false }));
    setTool("cross");
    requestAnimationFrame(() => engine?.chart.timeScale().setVisibleLogicalRange({ from: index - 120, to: index + 30 }));
  };
  const exitReplay = () => { setReplay((r) => ({ ...r, selecting: false, active: false, playing: false })); requestAnimationFrame(() => engine?.chart.timeScale().scrollToRealTime()); };

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const f = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  // ---- drawings
  const drawings = doc.drawings[s.symbol] || [];
  const setDrawings = (fn: (d: Drawing[]) => Drawing[], commit = true) =>
    change((d) => ({ ...d, drawings: { ...d.drawings, [s.symbol]: fn(d.drawings[s.symbol] || []) } }), commit);
  const createDrawing = (d: Drawing) => {
    setDrawings((ds) => [...ds, d]);
    setSelected(d.id);
    if (!s.stay) setTool("cross");
  };
  const updateDrawing = (id: string, patch: Partial<Drawing>, commit: boolean) => setDrawings((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)), commit);
  const removeDrawing = (id: string) => { setDrawings((ds) => ds.filter((d) => d.id !== id)); if (selected === id) setSelected(null); };
  const sel = drawings.find((d) => d.id === selected) || null;

  const crossPrice = () => (hover && hover.pane === 0 && engine ? engine.fromY(hover.y) : bars?.c[bars.c.length - 1] ?? 0);
  const crossTime = () => (hover && engine ? engine.fromX(hover.x) : bars?.t[bars.t.length - 1] ?? 0);
  const quick = (t: ToolId) => createDrawing({ id: uid(), tool: t, pts: [{ t: crossTime(), p: crossPrice() }], style: { color: "#2962ff", width: 2, dash: 0, fill: false } });

  // ---- indicators
  const addIndicator = (def: IndicatorDef, inputs?: Record<string, any>, cols?: string[]) =>
    change((d) => ({ ...d, indicators: [...d.indicators, { id: uid(), type: def.id, inputs: { ...defaultInputs(def), ...(inputs || {}) }, colors: cols || def.plots.map((p) => p.color) }] }));
  const indAction = (id: string, a: "hide" | "settings" | "remove") => {
    if (a === "settings") { setDialog({ kind: "settings", id }); return; }
    change((d) => ({ ...d, indicators: a === "remove" ? d.indicators.filter((i) => i.id !== id) : d.indicators.map((i) => (i.id === id ? { ...i, hidden: !i.hidden } : i)) }));
  };
  const applyTemplate = (items: { type: string; inputs?: any; colors?: string[] }[]) =>
    change((d) => ({ ...d, indicators: items.filter((x) => INDICATOR_MAP[x.type]).map((x) => ({ id: uid(), type: x.type, inputs: { ...defaultInputs(INDICATOR_MAP[x.type]), ...(x.inputs || {}) }, colors: x.colors || INDICATOR_MAP[x.type].plots.map((p) => p.color) })) }));

  // ---- symbol
  const setSymbol = (sym: string) => {
    const symbol = sym.trim().toUpperCase();
    if (!symbol) return;
    // A newly opened dataset starts at its own interval: asking for the finest one makes the server return the file's native bars.
    upd({ symbol, compare: s.compare.filter((c) => c !== symbol), ...(symbol !== s.symbol ? { interval: "1m" as Interval } : {}) });
    setSelected(null);
  };

  const pickRange = (r: (typeof RANGES)[number]) => {
    // A dataset can't go finer than its own bars: keep the window, use the file's interval.
    const iv = tooFine(r.interval) && bars?.native ? bars.native : r.interval;
    if (iv === s.interval) applyRange(r);
    else { pendingRange.current = r; upd({ interval: iv }); }
  };

  // ---- layouts
  const layoutState = () => ({ ...s, doc: docRef.current });
  const saveLayout = async (asName?: string) => {
    let name = asName ?? s.layoutName;
    if (!asName && (!s.layoutId || name === "Unnamed")) {
      const n = window.prompt("Layout name", name === "Unnamed" ? `${s.symbol} layout` : name);
      if (!n) return;
      name = n;
    }
    try {
      const m = await chartApi.saveLayout(name, layoutState());
      upd({ layoutId: m.id, layoutName: m.name });
      toast(`Layout "${m.name}" saved`);
    } catch (e: any) { toast(e.message, "err"); }
  };
  const openLayout = async (id: string) => {
    try {
      const l = await chartApi.layout(id);
      const { doc: d, ...rest } = l.state || {};
      const next = sanitize({ ...DEFAULTS, ...rest, layoutId: l.id, layoutName: l.name });
      if (!next.symbol && rest.symbol) toast(`That layout used ${rest.symbol}; Analyze only charts your CSV datasets`, "info");
      setS(next.symbol ? next : { ...next, symbol: s.symbol });
      if (d) change(() => ({ drawings: d.drawings || {}, indicators: d.indicators || [] }));
      setMenu(null);
      toast(`Opened "${l.name}"`);
    } catch (e: any) { toast(e.message, "err"); }
  };

  // ---- snapshot
  const snapshot = async () => {
    if (!engine) return;
    const base = engine.chart.takeScreenshot();
    const head = 44, out = document.createElement("canvas");
    out.width = base.width; out.height = base.height + head;
    const g = out.getContext("2d")!;
    g.fillStyle = colors.bg; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(base, 0, head);
    const svg = rootRef.current?.querySelector("svg.dl") as SVGSVGElement | null;
    if (svg) {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.querySelectorAll(".dl-hits, .dl-handle").forEach((n) => n.remove());
      const img = new Image();
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
      await new Promise((ok) => { img.onload = ok; img.onerror = ok; img.src = url; });
      const k = base.width / (chartEl.current?.clientWidth || base.width);
      g.drawImage(img, 0, head, svg.width.baseVal.value * k, svg.height.baseVal.value * k);
      URL.revokeObjectURL(url);
    }
    const last = displayBars ? displayBars.c.length - 1 : 0;
    g.fillStyle = colors.text; g.font = "600 16px Figtree, sans-serif";
    g.fillText(`${csvName} · ${INTERVALS.find((x) => x.id === s.interval)?.label} · CSV`, 14, 27);
    g.font = "500 13px Figtree, sans-serif"; g.fillStyle = colors.muted;
    const stamp = `QuantForge · ${new Date().toUTCString()} · close ${displayBars ? displayBars.c[last]?.toFixed(prec) : ""}`;
    g.fillText(stamp, out.width - g.measureText(stamp).width - 14, 27);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `${csvName.replace(/[^A-Z0-9.-]/gi, "_")}_${s.interval}_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    toast("Chart image saved");
  };

  // ---- keyboard
  const live = useRef<any>({});
  live.current = { tool, selected, replay, undo, redo, saveLayout, quick, removeDrawing, setTool, hover, bars, dialog, applyRange };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || L.dialog) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        if (L.replay.selecting) setReplay((r) => ({ ...r, selecting: false }));
        else if (L.tool !== "cross") L.setTool("cross");
        else setSelected(null);
        setCtx(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && L.selected) { L.removeDrawing(L.selected); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && k === "z") { e.shiftKey ? L.redo() : L.undo(); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && k === "y") { L.redo(); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && k === "s") { L.saveLayout(); e.preventDefault(); return; }
      if (e.altKey && !e.ctrlKey) {
        const map: Record<string, () => void> = {
          h: () => L.quick("hline"), j: () => L.quick("hray"), v: () => L.quick("vline"), c: () => L.quick("crossline"),
          t: () => L.setTool("trend"), f: () => L.setTool("fib"), r: () => (e.shiftKey ? L.setTool("rect") : L.applyRange(null)),
        };
        if (map[k]) { map[k](); e.preventDefault(); }
        return;
      }
      if (L.replay.active && e.shiftKey && e.key === "ArrowRight") { setReplay((r) => ({ ...r, index: Math.min(r.index + 1, (L.bars?.t.length || 1) - 1) })); e.preventDefault(); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === "/") { setDialog({ kind: "indicators" }); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  // ---- legend & data window values
  const n = displayBars?.t.length || 0;
  const idx = hover && hover.idx >= 0 && hover.idx < n ? hover.idx : n - 1;
  const lb = chartBars && n ? { o: chartBars.o[idx], h: chartBars.h[idx], l: chartBars.l[idx], c: chartBars.c[idx], v: chartBars.v[idx], pc: idx > 0 ? chartBars.c[idx - 1] : chartBars.o[idx] } : null;
  const chg = lb ? lb.c - lb.pc : 0, chgPct = lb && lb.pc ? (chg / lb.pc) * 100 : 0;
  const up = lb ? lb.c >= lb.o : true;
  const fmt = (v?: number | null) => (v == null || !Number.isFinite(v) ? "∅" : v.toFixed(prec));
  const layout = engine?.layout();
  const visibleRenders = renders.filter((r) => !r.inst.hidden);
  const vrvp = visibleRenders.find((r) => r.def.id === "vrvp");
  const paneOf = new Map<string, number>();
  { let pn = 0; visibleRenders.forEach((r) => paneOf.set(r.inst.id, r.def.overlay ? 0 : ++pn)); }

  const indValue = (r: IndicatorRender, k: number) => { const v = r.values[k]?.[idx]; return v == null || !Number.isFinite(v) ? "∅" : r.def.id === "vol" ? fmtBig(v) : Math.abs(v) >= 1e6 ? fmtBig(v) : v.toFixed(Math.abs(v) < 10 ? Math.max(prec, 2) : 2); };

  const visibleStats = useMemo<VisibleStats | null>(() => {
    if (!engine || !displayBars || s.panel !== "details") return null;
    const r = engine.chart.timeScale().getVisibleLogicalRange();
    if (!r) return null;
    const i0 = Math.max(0, Math.ceil(r.from)), i1 = Math.min(displayBars.t.length - 1, Math.floor(r.to));
    if (i1 - i0 < 1) return null;
    const c = displayBars.c.slice(i0, i1 + 1);
    let hi = -Infinity, lo = Infinity, peak = -Infinity, dd = 0, upc = 0, vol = 0;
    const rets: number[] = [];
    for (let i = i0; i <= i1; i++) {
      hi = Math.max(hi, displayBars.h[i]); lo = Math.min(lo, displayBars.l[i]); vol += displayBars.v[i];
      peak = Math.max(peak, displayBars.c[i]); dd = Math.min(dd, displayBars.c[i] / peak - 1);
      if (displayBars.c[i] >= displayBars.o[i]) upc++;
      if (i > i0) rets.push(Math.log(displayBars.c[i] / displayBars.c[i - 1]));
    }
    const m = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(rets.length - 1, 1));
    const sec = INTERVALS.find((x) => x.id === s.interval)!.seconds;
    const perYear = daily ? 31557600 / sec * (s.interval === "1D" ? 252 / 365.25 : 1) : 252 * Math.max(1, Math.round(23400 / sec));
    return {
      bars: i1 - i0 + 1, change: c[c.length - 1] - c[0], changePct: (c[c.length - 1] / c[0] - 1) * 100, high: hi, low: lo,
      rangePct: ((hi - lo) / lo) * 100, vol: rets.length > 2 ? sd * Math.sqrt(perYear) * 100 : null, maxDd: dd * 100,
      upPct: (upc / (i1 - i0 + 1)) * 100, avgVol: vol / (i1 - i0 + 1),
      from: fmtBarTime(displayBars.t[i0], daily, shift), to: fmtBarTime(displayBars.t[i1], daily, shift),
    };
  }, [engine, displayBars, tick, s.panel, s.interval, daily, shift]); // eslint-disable-line react-hooks/exhaustive-deps

  const dataRows: DataRow[] = lb ? [
    { name: s.symbol, values: [["Open", fmt(lb.o)], ["High", fmt(lb.h)], ["Low", fmt(lb.l)], ["Close", fmt(lb.c)], ["Change", `${chg >= 0 ? "+" : ""}${chg.toFixed(prec)} (${chgPct.toFixed(2)}%)`], ["Volume", fmtBig(lb.v)]] },
    ...visibleRenders.map((r) => ({ name: indLabel(r.def, r.inst.inputs), color: r.inst.colors[0], values: r.def.plots.map((p, k) => [p.name, indValue(r, k)] as [string, string]) })),
  ] : [];

  // CSV datasets have no live quote: describe them from the data itself.
  const q: Quote | null = isCsv && bars && bars.c.length > 1 ? (() => {
    const n2 = bars.c.length, last = bars.c[n2 - 1], prev = bars.c[n2 - 2], yr = bars.t[n2 - 1] - 31557600;
    let hi = -Infinity, lo = Infinity;
    bars.t.forEach((t, i) => { if (t >= yr) { hi = Math.max(hi, bars.h[i]); lo = Math.min(lo, bars.l[i]); } });
    return { symbol: s.symbol, name: `${csvName} (your CSV)`, exchange_name: `CSV upload · ${bars.native || bars.interval} data · ${n2.toLocaleString()} bars`, last, prev_close: prev,
      change: last - prev, change_pct: (last / prev - 1) * 100, open: bars.o[n2 - 1], day_high: bars.h[n2 - 1], day_low: bars.l[n2 - 1], volume: bars.v[n2 - 1], year_high: hi, year_low: lo };
  })() : null;

  // ---- render helpers
  const ivl = INTERVALS.find((x) => x.id === s.interval)!;
  const clock = (() => {
    const d = new Date(makeShift(tzName)(Math.floor(now / 1000)) * 1000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")} ${offsetLabel(tzName, now / 1000)}`;
  })();
  const W = layout?.plotW ?? 0;
  const placing = TOOLS[tool].points !== 0;

  return (
    <div className={`ct-root ${s.panel ? "with-panel" : ""} view-${view} ${dragOver ? "drag-over" : ""}`} ref={rootRef}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files?.[0]; if (file) uploadCsv(file); }}>
      {dragOver && <div className="ct-drop"><FileSpreadsheet size={34} /><b>Drop a CSV to chart and analyse it</b><span>Date, Open, High, Low, Close, Volume columns are detected automatically</span></div>}
      {/* ============================== top toolbar */}
      <div className="ct-top">
        <button className="ct-symbol" onClick={() => setDialog({ kind: "symbol" })} title="Open or upload a CSV dataset" aria-label="Datasets">
          <FileSpreadsheet size={16} className="ct-csv-ic" />{isCsv ? <b>{csvName}</b> : <b className="muted">Open a CSV</b>}<Search size={15} />
        </button>
        <button className="ct-tb icon" onClick={() => setDialog({ kind: "compare" })} disabled={!isCsv} title="Compare with another dataset" aria-label="Compare with another dataset"><CirclePlus size={19} /></button>
        <span className="ct-sep" />
        <div className="ct-rel">
          <button className="ct-tb" onClick={() => setMenu(menu === "interval" ? null : "interval")} aria-label="Interval" title="Interval">{s.interval}<ChevronDown size={14} /></button>
          <Popover open={menu === "interval"} onClose={() => setMenu(null)} className="ct-menu">
            {["Minutes", "Hours", "Days"].map((g) => (
              <div key={g}><div className="ct-menu-sec">{g}</div>
                {INTERVALS.filter((x) => x.group === g).map((x) => <MenuItem key={x.id} label={x.label} active={x.id === s.interval} disabled={tooFine(x.id)}
                  hint={tooFine(x.id) ? "finer than the CSV" : undefined} onClick={() => { upd({ interval: x.id }); setMenu(null); }} />)}
              </div>
            ))}
          </Popover>
        </div>
        <div className="ct-favs">
          {s.favIntervals.filter((f) => f !== s.interval && !tooFine(f)).slice(0, 4).map((f) => <button key={f} className="ct-tb sm" onClick={() => upd({ interval: f })} title={INTERVALS.find((x) => x.id === f)?.label}>{f}</button>)}
        </div>
        <span className="ct-sep" />
        <div className="ct-rel">
          <button className="ct-tb icon" onClick={() => setMenu(menu === "type" ? null : "type")} title="Chart type" aria-label="Chart type">{CHART_TYPES.find((c) => c.id === s.type)?.icon}</button>
          <Popover open={menu === "type"} onClose={() => setMenu(null)} className="ct-menu">
            {CHART_TYPES.slice(0, 9).map((c) => <MenuItem key={c.id} icon={c.icon} label={c.label} active={c.id === s.type} onClick={() => { upd({ type: c.id }); setMenu(null); }} />)}
            <div className="ct-menu-sec">Price-based (time ignored)</div>
            {CHART_TYPES.slice(9).map((c) => <MenuItem key={c.id} icon={c.icon} label={c.label} active={c.id === s.type} onClick={() => upd({ type: c.id })} />)}
            {transformed && (
              <div className="ct-brick">
                {s.type === "linebreak" ? (
                  <label>Lines to break<input type="number" min={1} max={10} value={s.lines} onChange={(e) => upd({ lines: Math.max(1, Math.min(10, +e.target.value || 3)) })} /></label>
                ) : (
                  <label>{s.type === "kagi" ? "Reversal amount" : s.type === "range" ? "Bar range" : "Box size"}
                    <input type="number" step="any" min={0} placeholder={`Auto (${boxUsed})`} value={s.box || ""} onChange={(e) => upd({ box: Math.max(0, +e.target.value || 0) })} /></label>
                )}
                {s.type === "pnf" && <label>Reversal boxes<input type="number" min={1} max={10} value={s.reversal} onChange={(e) => upd({ reversal: Math.max(1, Math.min(10, +e.target.value || 3)) })} /></label>}
                <small>{s.type === "linebreak" ? "A new line needs a close beyond the last N lines." : "Empty = automatic, from ATR(14)."}</small>
              </div>
            )}
          </Popover>
        </div>
        <span className="ct-sep" />
        <button className="ct-tb" onClick={() => setDialog({ kind: "indicators" })} aria-label="Indicators" title="Indicators, metrics and strategies (/)">
          <svg width="20" height="20" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 22h18M8 19v-5M13 19V9M18 19v-7M22 6l-3 3" /><path d="M19 6h3v3" /></svg>Indicators
        </button>
        <div className="ct-rel">
          <button className="ct-tb icon" onClick={() => setMenu(menu === "templates" ? null : "templates")} title="Indicator templates" aria-label="Indicator templates"><LayoutGrid size={18} /></button>
          <Popover open={menu === "templates"} onClose={() => setMenu(null)} className="ct-menu wide">
            <MenuItem label="Save indicator template…" disabled={!doc.indicators.length} onClick={() => {
              const name = window.prompt("Template name");
              if (name) { setMyTemplates([...myTemplates.filter((t) => t.name !== name), { name, items: doc.indicators.map((i) => ({ type: i.type, inputs: i.inputs, colors: i.colors })) }]); toast(`Template "${name}" saved`); }
              setMenu(null);
            }} />
            {myTemplates.length > 0 && <div className="ct-menu-sec">My templates</div>}
            {myTemplates.map((t) => <MenuItem key={t.name} label={t.name} hint={`${t.items.length} indicators`} onClick={() => { applyTemplate(t.items); setMenu(null); }} />)}
            <div className="ct-menu-sec">Built-in templates</div>
            {TEMPLATES.map((t) => <MenuItem key={t.name} label={t.name} hint={t.desc} onClick={() => { applyTemplate(t.items); setMenu(null); }} />)}
          </Popover>
        </div>
        <span className="ct-sep" />
        <button className={`ct-tb ${replay.selecting || replay.active ? "on" : ""}`} aria-label="Replay" title="Bar replay"
          onClick={() => (replay.active || replay.selecting ? exitReplay() : setReplay((r) => ({ ...r, selecting: true })))}><Rewind size={18} />Replay</button>
        <span className="ct-sep" />
        <button className="ct-tb icon" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl + Z)" aria-label="Undo"><Undo2 size={18} /></button>
        <button className="ct-tb icon" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl + Y)" aria-label="Redo"><Redo2 size={18} /></button>
        <span className="ct-grow" />
        <div className="ct-rel">
          <div className="ct-layout">
            <button className="ct-layout-name" onClick={() => { setMenu(menu === "layout" ? null : "layout"); chartApi.layouts().then(setLayouts).catch(() => setLayouts([])); }} title="Manage layouts">
              <b>{s.layoutName}</b><ChevronDown size={13} />
            </button>
            <button className="ct-layout-save" onClick={() => saveLayout()} title="Save layout (Ctrl + S)">Save</button>
          </div>
          <Popover open={menu === "layout"} onClose={() => setMenu(null)} className="ct-menu wide right">
            <MenuItem label="Save layout" hint="Ctrl + S" onClick={() => { setMenu(null); saveLayout(); }} />
            <MenuItem label="Rename…" onClick={() => { const nm = window.prompt("Rename layout", s.layoutName); if (nm) { setMenu(null); s.layoutId ? saveLayout(nm) : upd({ layoutName: nm }); } }} />
            <MenuItem label="Make a copy…" onClick={() => { const nm = window.prompt("Name of the copy", `${s.layoutName} copy`); if (nm) { setMenu(null); saveLayout(nm); } }} />
            <MenuItem label="New layout" onClick={() => { upd({ layoutId: null, layoutName: "Unnamed" }); change((d) => ({ ...d, indicators: [] })); setMenu(null); }} />
            {layouts.length > 0 && <div className="ct-menu-sec">Saved layouts</div>}
            {layouts.map((l) => (
              <div key={l.id} className="ct-mi-row">
                <MenuItem label={l.name} hint={l.symbol} active={l.id === s.layoutId} onClick={() => openLayout(l.id)} />
                <button className="ct-icon-btn" title="Delete layout" onClick={() => { if (window.confirm(`Delete layout "${l.name}"?`)) chartApi.deleteLayout(l.id).then(() => { setLayouts(layouts.filter((x) => x.id !== l.id)); if (l.id === s.layoutId) upd({ layoutId: null, layoutName: "Unnamed" }); }); }}><Trash2 size={14} /></button>
              </div>
            ))}
          </Popover>
        </div>
        <button className="ct-tb icon" onClick={snapshot} title="Take a snapshot (PNG)" aria-label="Take a snapshot"><Camera size={18} /></button>
        <button className="ct-tb icon" onClick={() => (fullscreen ? document.exitFullscreen() : rootRef.current?.requestFullscreen())} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} aria-label="Fullscreen">
          {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>
      </div>

      {/* ============================== left drawing toolbar */}
      <div className="ct-left" role="toolbar" aria-label="Drawing tools" hidden={view === "analysis"}>
        {GROUPS.map((g) => {
          const cur = lastInGroup[g.id] || g.tools[0];
          const active = g.tools.includes(tool);
          return (
            <div key={g.id} className="ct-tg">
              <ToolBtn id={g.id === "icons" ? "icon" : active ? tool : cur} title={g.id === "icons" ? "Icons" : TOOLS[active ? tool : cur].name} active={active}
                onClick={() => (g.id === "icons" ? setMenu(menu === "g:icons" ? null : "g:icons") : setTool(active ? tool : cur))}>
                {g.id === "icons" ? <span className="ct-emoji">{s.icon}</span> : ICONS[active ? tool : cur]}
              </ToolBtn>
              {g.tools.length > 1 || g.id === "icons" ? <button className="ct-tg-more" onClick={() => setMenu(menu === "g:" + g.id ? null : "g:" + g.id)} aria-label={`More ${g.title}`} title={g.title}><ChevronDown size={10} /></button> : null}
              <Popover open={menu === "g:" + g.id} onClose={() => setMenu(null)} className="ct-menu flyout">
                <div className="ct-menu-sec">{g.title}</div>
                {g.id === "icons" ? (
                  <div className="ct-emojis">{EMOJIS.map((em) => <button key={em} onClick={() => { upd({ icon: em }); setTool("icon"); setMenu(null); }}>{em}</button>)}</div>
                ) : g.tools.map((t) => <MenuItem key={t} icon={ICONS[t]} label={TOOLS[t].name} hint={TOOLS[t].key} active={tool === t} onClick={() => { setTool(t); setMenu(null); }} />)}
              </Popover>
            </div>
          );
        })}
        <span className="ct-hsep" />
        <ToolBtn id="measure" title="Measure" active={tool === "measure"} onClick={() => setTool(tool === "measure" ? "cross" : "measure")}>{ICONS.measure}</ToolBtn>
        <ToolBtn id="zoom" title="Zoom in (drag across bars)" active={tool === "zoom"} onClick={() => setTool(tool === "zoom" ? "cross" : "zoom")}>{ICONS.zoom}</ToolBtn>
        <span className="ct-hsep" />
        <div className="ct-tg">
          <ToolBtn id="magnet" title={`Magnet mode${s.magnet !== "off" ? ` (${s.magnet})` : ""}: snap drawings to open, high, low and close`} active={s.magnet !== "off"} onClick={() => upd({ magnet: s.magnet === "off" ? "weak" : "off" })}>{ICONS.magnet}</ToolBtn>
          <button className="ct-tg-more" onClick={() => setMenu(menu === "magnet" ? null : "magnet")} aria-label="Magnet options"><ChevronDown size={10} /></button>
          <Popover open={menu === "magnet"} onClose={() => setMenu(null)} className="ct-menu flyout">
            <MenuItem icon={ICONS.magnet} label="Weak magnet" active={s.magnet === "weak"} onClick={() => { upd({ magnet: "weak" }); setMenu(null); }} />
            <MenuItem icon={ICONS.magnet} label="Strong magnet" active={s.magnet === "strong"} onClick={() => { upd({ magnet: "strong" }); setMenu(null); }} />
            <MenuItem icon={ICONS.magnet} label="Off" active={s.magnet === "off"} onClick={() => { upd({ magnet: "off" }); setMenu(null); }} />
          </Popover>
        </div>
        <ToolBtn id="stay" title="Stay in drawing mode" active={s.stay} onClick={() => upd({ stay: !s.stay })}>{ICONS.stay}</ToolBtn>
        <ToolBtn id="lock" title={s.lockAll ? "Unlock all drawings" : "Lock all drawings"} active={s.lockAll} onClick={() => upd({ lockAll: !s.lockAll })}>{s.lockAll ? ICONS.lock : ICONS.unlock}</ToolBtn>
        <div className="ct-tg">
          <ToolBtn id="hide" title="Hide all drawings" active={s.hideDrawings} onClick={() => upd({ hideDrawings: !s.hideDrawings })}>{s.hideDrawings ? ICONS.eyeoff : ICONS.eye}</ToolBtn>
          <button className="ct-tg-more" onClick={() => setMenu(menu === "hide" ? null : "hide")} aria-label="Hide options"><ChevronDown size={10} /></button>
          <Popover open={menu === "hide"} onClose={() => setMenu(null)} className="ct-menu flyout">
            <MenuItem label="Hide drawings" active={s.hideDrawings} onClick={() => upd({ hideDrawings: !s.hideDrawings })} />
            <MenuItem label="Hide indicators" active={s.hideIndicators} onClick={() => upd({ hideIndicators: !s.hideIndicators })} />
            <MenuItem label="Hide all" active={s.hideDrawings && s.hideIndicators} onClick={() => { const v = !(s.hideDrawings && s.hideIndicators); upd({ hideDrawings: v, hideIndicators: v }); }} />
          </Popover>
        </div>
        <div className="ct-tg">
          <ToolBtn id="remove" title="Remove drawings" onClick={() => setMenu(menu === "remove" ? null : "remove")}>{ICONS.trash}</ToolBtn>
          <Popover open={menu === "remove"} onClose={() => setMenu(null)} className="ct-menu flyout">
            <MenuItem label={`Remove ${drawings.length} drawings`} disabled={!drawings.length} onClick={() => { setDrawings(() => []); setMenu(null); }} />
            <MenuItem label={`Remove ${doc.indicators.length} indicators`} disabled={!doc.indicators.length} onClick={() => { change((d) => ({ ...d, indicators: [] })); setMenu(null); }} />
            <MenuItem label="Remove drawings and indicators" danger onClick={() => { change((d) => ({ indicators: [], drawings: { ...d.drawings, [s.symbol]: [] } })); setMenu(null); }} />
          </Popover>
        </div>
      </div>

      {/* ============================== chart */}
      <div className={`ct-chart cur-${tool}`} data-panes={layout?.panes.length ?? 0} onContextMenu={(e) => {
        if (placing) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const y = e.clientY - r.top;
        setCtx({ x: e.clientX - r.left, y, price: engine && layout && y < layout.panes[0] ? engine.fromY(y) : null });
      }}>
        <div ref={chartEl} className="ct-canvas" style={{ opacity: loading && bars ? 0.5 : 1 }} />
        {engine && displayBars && displayBars.t.length > 0 && (
          <DrawingLayer engine={engine} tick={tick} bars={displayBars} drawings={drawings} selected={selected} tool={tool} magnet={s.magnet}
            lockAll={s.lockAll} hidden={s.hideDrawings} icon={s.icon} replaySelecting={replay.selecting}
            onCreate={createDrawing} onUpdate={updateDrawing} onSelect={setSelected} onErase={removeDrawing}
            onZoom={(a, b) => { engine.chart.timeScale().setVisibleLogicalRange({ from: a, to: b }); setTool("cross"); }}
            onReplayPick={startReplayAt} />
        )}
        {engine && layout && displayBars && vrvp && <VolumeProfileOverlay engine={engine} bars={displayBars} rows={+(vrvp.inst.inputs.rows ?? 24)} va={+(vrvp.inst.inputs.va ?? 70)} plotW={layout.plotW} h={layout.panes[0]} up={colors.up} down={colors.down} tick={tick} />}

        {/* legend */}
        <div className="ct-legend">
          <div className="ct-leg-main">
            <span className="ct-sym-logo sm">{csvName.slice(0, 1)}</span>
            <button className="ct-leg-title" onClick={() => setDialog({ kind: "symbol" })}>{csvName} · {ivl.legend} · CSV{transformed ? ` · ${CHART_TYPES.find((c) => c.id === s.type)?.label} ${s.type === "linebreak" ? s.lines : boxUsed}` : ""}</button>
            {lb && <span className={`ct-ohlc ${up ? "up" : "down"}`}>
              <span>O<b>{fmt(lb.o)}</b></span><span>H<b>{fmt(lb.h)}</b></span><span>L<b>{fmt(lb.l)}</b></span><span>C<b>{fmt(lb.c)}</b></span>
              <b className={chg >= 0 ? "up" : "down"}>{chg >= 0 ? "+" : ""}{chg.toFixed(prec)} ({chg >= 0 ? "+" : ""}{chgPct.toFixed(2)}%)</b>
              {lb.v != null && renders.every((r) => r.def.id !== "vol" || r.inst.hidden) && <span>Vol<b>{fmtBig(lb.v)}</b></span>}
            </span>}
          </div>
          {s.compare.map((sym, i) => {
            const cb = cmpBars[sym];
            return (
              <div key={sym} className="ct-leg-ind" style={{ color: CMP_COLORS[i % CMP_COLORS.length] }}>
                <b>{sym.replace(/^CSV:/i, "")}</b>{cb && <span>{cb.c[cb.c.length - 1]?.toFixed(precisionFor(cb.c[cb.c.length - 1]))}</span>}
                <span className="ct-leg-btns"><button onClick={() => upd({ compare: s.compare.filter((x) => x !== sym) })} title="Remove"><X size={14} /></button></span>
              </div>
            );
          })}
          {renders.filter((r) => r.def.overlay || r.inst.hidden).map((r) => <IndLegend key={r.inst.id} r={r} values={r.def.plots.map((_, k) => indValue(r, k))} onAction={(a) => indAction(r.inst.id, a)} />)}
        </div>
        {/* pane legends */}
        {layout && visibleRenders.filter((r) => !r.def.overlay).map((r) => (
          <div key={r.inst.id} className="ct-legend pane" style={{ top: (layout.tops[paneOf.get(r.inst.id) || 0] ?? 0) + 4 }}>
            <IndLegend r={r} values={r.def.plots.map((_, k) => indValue(r, k))} onAction={(a) => indAction(r.inst.id, a)} />
          </div>
        ))}

        {/* selected drawing toolbar */}
        {sel && (
          <div className="ct-float" style={{ right: (layout?.scaleW ?? 60) + 12 }} onMouseDown={(e) => e.stopPropagation()}>
            <span className="ct-float-name">{TOOLS[sel.tool].name}</span>
            <div className="ct-rel">
              <button className="ct-tb icon" onClick={() => setMenu(menu === "color" ? null : "color")} title="Colour"><span className="ct-swatch" style={{ background: sel.style.color }} /></button>
              <Popover open={menu === "color"} onClose={() => setMenu(null)} className="ct-menu swatches">
                {SWATCHES.map((c) => <button key={c} style={{ background: c }} onClick={() => { updateDrawing(sel.id, { style: { ...sel.style, color: c } }, true); setMenu(null); }} aria-label={c} />)}
              </Popover>
            </div>
            <div className="ct-rel">
              <button className="ct-tb sm" onClick={() => setMenu(menu === "width" ? null : "width")} title="Line width">{sel.style.width}px</button>
              <Popover open={menu === "width"} onClose={() => setMenu(null)} className="ct-menu">
                {[1, 2, 3, 4].map((w) => <MenuItem key={w} icon={<span className="ct-wline" style={{ height: w }} />} label={`${w}px`} active={sel.style.width === w} onClick={() => { updateDrawing(sel.id, { style: { ...sel.style, width: w } }, true); setMenu(null); }} />)}
              </Popover>
            </div>
            <div className="ct-rel">
              <button className="ct-tb sm" onClick={() => setMenu(menu === "dash" ? null : "dash")} title="Line style">{["Solid", "Dashed", "Dotted"][sel.style.dash]}</button>
              <Popover open={menu === "dash"} onClose={() => setMenu(null)} className="ct-menu">
                {["Solid", "Dashed", "Dotted"].map((nm, k) => <MenuItem key={nm} label={nm} active={sel.style.dash === k} onClick={() => { updateDrawing(sel.id, { style: { ...sel.style, dash: k as 0 | 1 | 2 } }, true); setMenu(null); }} />)}
              </Popover>
            </div>
            {["rect", "ellipse", "channel"].includes(sel.tool) && <button className={`ct-tb sm ${sel.style.fill ? "on" : ""}`} onClick={() => updateDrawing(sel.id, { style: { ...sel.style, fill: !sel.style.fill } }, true)} title="Background">Fill</button>}
            {sel.tool === "text" && <button className="ct-tb sm" onClick={() => { const t = window.prompt("Text", sel.text); if (t) updateDrawing(sel.id, { text: t }, true); }}>Edit text</button>}
            <button className="ct-tb icon" onClick={() => updateDrawing(sel.id, { locked: !sel.locked }, true)} title={sel.locked ? "Unlock" : "Lock"}>{sel.locked ? <Lock size={16} /> : <Unlock size={16} />}</button>
            <button className="ct-tb icon" onClick={() => { const d = { ...sel, id: uid(), pts: sel.pts.map((p) => ({ t: p.t + (engine?.step || 60) * 5, p: p.p })) }; setDrawings((ds) => [...ds, d]); setSelected(d.id); }} title="Clone"><Copy size={16} /></button>
            <button className="ct-tb icon" onClick={() => updateDrawing(sel.id, { hidden: true }, true)} title="Hide"><EyeOff size={16} /></button>
            <button className="ct-tb icon" onClick={() => removeDrawing(sel.id)} title="Remove (Delete)"><Trash2 size={16} /></button>
          </div>
        )}

        {/* + button on the price axis at the crosshair */}
        {layout && engine && (hover?.pane === 0 || plusHover) && hover && hover.y < layout.panes[0] && !placing && (
          <div className="ct-rel ct-plus" style={{ left: W - 24, top: hover.y - 10 }} onMouseEnter={() => setPlusHover(true)} onMouseLeave={() => setPlusHover(false)}>
            <button className="ct-plus-btn" onClick={() => setMenu(menu === "plus" ? null : "plus")} aria-label="Draw a line at this price"><CirclePlus size={17} /></button>
            <Popover open={menu === "plus"} onClose={() => { setMenu(null); setPlusHover(false); }} className="ct-menu right">
              <MenuItem icon={ICONS.hline} label={`Draw horizontal line at ${engine.fromY(hover.y).toFixed(prec)}`} onClick={() => { createDrawing({ id: uid(), tool: "hline", pts: [{ t: engine.fromX(hover.x), p: engine.fromY(hover.y) }], style: { color: "#2962ff", width: 2, dash: 0, fill: false } }); setMenu(null); }} />
            </Popover>
          </div>
        )}

        {/* chart settings gear at the axis corner */}
        {layout && (
          <div className="ct-rel ct-gear" style={{ width: layout.scaleW }}>
            <button onClick={() => setMenu(menu === "settings" ? null : "settings")} title="Chart settings" aria-label="Chart settings"><Settings size={16} /></button>
            <Popover open={menu === "settings"} onClose={() => setMenu(null)} className="ct-menu up right">
              <div className="ct-menu-sec">Price scale</div>
              <MenuItem label="Auto (fits data to screen)" active={s.autoScale} onClick={() => upd({ autoScale: !s.autoScale })} />
              <MenuItem label="Regular" active={s.scale === "normal" && !s.compare.length} onClick={() => upd({ scale: "normal" })} />
              <MenuItem label="Percent" active={s.scale === "percent" || s.compare.length > 0} onClick={() => upd({ scale: "percent" })} />
              <MenuItem label="Logarithmic" active={s.scale === "log" && !s.compare.length} onClick={() => upd({ scale: "log" })} />
              <div className="ct-menu-sec">Chart</div>
              <MenuItem label="Grid lines" active={s.grid} onClick={() => upd({ grid: !s.grid })} />
              <MenuItem label="Magnet crosshair (snap to OHLC)" active={s.crossMagnet} onClick={() => upd({ crossMagnet: !s.crossMagnet })} />
              <MenuItem label="Reset chart view" hint="Alt + R" onClick={() => { applyRange(null); setMenu(null); }} />
            </Popover>
          </div>
        )}

        {/* context menu */}
        {ctx && (
          <Popover open onClose={() => setCtx(null)} className="ct-menu ctx" style={{ left: ctx.x, top: ctx.y }}>
            <MenuItem label="Reset chart view" hint="Alt + R" onClick={() => { applyRange(null); setCtx(null); }} />
            {ctx.price != null && <>
              <MenuItem icon={ICONS.hline} label={`Draw horizontal line at ${ctx.price.toFixed(prec)}`} onClick={() => { createDrawing({ id: uid(), tool: "hline", pts: [{ t: engine!.fromX(ctx.x), p: ctx.price! }], style: { color: "#2962ff", width: 2, dash: 0, fill: false } }); setCtx(null); }} />
            </>}
            <div className="ct-menu-div" />
            <MenuItem label="Add indicator…" onClick={() => { setDialog({ kind: "indicators" }); setCtx(null); }} />
            <MenuItem label="Remove drawings" disabled={!drawings.length} onClick={() => { setDrawings(() => []); setCtx(null); }} />
            <MenuItem label="Remove indicators" disabled={!doc.indicators.length} onClick={() => { change((d) => ({ ...d, indicators: [] })); setCtx(null); }} />
          </Popover>
        )}

        {/* replay controls */}
        {(replay.selecting || replay.active) && (
          <div className="ct-replay" role="toolbar" aria-label="Replay controls">
            {replay.selecting ? <span className="ct-replay-msg">Select a bar on the chart to start the replay</span> : <>
              <button className="ct-tb sm" onClick={() => setReplay((r) => ({ ...r, selecting: true, playing: false }))} title="Select another start bar">Select bar</button>
              <button className="ct-tb icon" onClick={() => setReplay((r) => ({ ...r, playing: !r.playing }))} title={replay.playing ? "Pause" : "Play"} aria-label={replay.playing ? "Pause" : "Play"}>{replay.playing ? <Pause size={17} /> : <Play size={17} />}</button>
              <button className="ct-tb icon" onClick={() => setReplay((r) => ({ ...r, index: Math.min(r.index + 1, (bars?.t.length || 1) - 1) }))} title="Forward one bar (Shift + →)" aria-label="Forward"><StepForward size={17} /></button>
              <select className="ct-replay-speed" value={replay.speed} onChange={(e) => setReplay((r) => ({ ...r, speed: +e.target.value }))} aria-label="Replay speed">
                {[[3000, "0.3x"], [2000, "0.5x"], [1000, "1x"], [500, "2x"], [300, "3x"], [100, "10x"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <span className="ct-replay-msg">{displayBars ? fmtBarTime(displayBars.t[displayBars.t.length - 1], daily, shift) : ""} · {replay.index + 1}/{bars?.t.length}</span>
              <button className="ct-tb icon" onClick={exitReplay} title="Jump to real time" aria-label="Jump to real time"><FastForward size={17} /></button>
            </>}
            <button className="ct-tb icon" onClick={exitReplay} title="Exit replay" aria-label="Exit replay"><X size={17} /></button>
          </div>
        )}

        {view === "analysis" && (
          <div className="ct-analysis">
            {isCsv ? <AnalysisView key={s.symbol} symbol={s.symbol} label={csvName} chartBars={bars} datasets={datasets || []} compare={s.compare} shift={makeShift(exchangeTz)} /> : null}
          </div>
        )}
        {error && (
          <div className="ct-overlay">
            <div><b>Couldn't load {csvName || "this dataset"}</b><p>{error}</p>
              <button className="ct-btn primary" onClick={() => setDialog({ kind: "symbol" })}>Choose a dataset</button></div>
          </div>
        )}
        {datasets && !s.symbol && (
          <div className="ct-welcome">
            <div className="ct-welcome-card">
              <h2>Analyze your own data</h2>
              <p>Upload a CSV of prices to chart it with indicators and drawing tools, and to run the quant Analysis on it.</p>
              <DatasetList datasets={datasets} onPick={(n) => setSymbol(`CSV:${n}`)} onChanged={refreshDatasets} />
            </div>
          </div>
        )}
        {loading && !bars && !error && <div className="ct-overlay"><div className="ct-spinner" /></div>}
      </div>

      {/* ============================== right strip + panel */}
      {s.panel && (
        <RightPanel tab={s.panel} onClose={() => upd({ panel: null })} symbol={s.symbol} prec={prec}
          datasets={datasets} current={csvName} onOpen={(n) => setSymbol(`CSV:${n}`)} onDatasetsChanged={refreshDatasets}
          quote={q} stats={visibleStats}
          data={{ title: displayBars && n ? fmtBarTime(displayBars.t[idx], daily, shift) : "", rows: dataRows }}
          drawings={drawings} indicators={doc.indicators}
          onDrawing={(id, patch) => (patch ? updateDrawing(id, patch, true) : removeDrawing(id))} onSelectDrawing={(id) => { updateDrawing(id, { hidden: false }, true); setSelected(id); }}
          onIndicator={indAction} onRemoveAll={() => change((d) => ({ indicators: [], drawings: { ...d.drawings, [s.symbol]: [] } }))} />
      )}
      <div className="ct-strip" role="toolbar" aria-label="Panels">
        {PANEL_TABS.map((t) => (
          <button key={t.id} className={`ct-tool ${s.panel === t.id ? "on" : ""}`} onClick={() => upd({ panel: s.panel === t.id ? null : t.id })} title={t.label} aria-label={t.label}>
            {t.icon}
          </button>
        ))}
      </div>

      {/* ============================== bottom bar */}
      <div className="ct-bottom">
        {RANGES.map((r) => <button key={r.id} className="ct-tb sm" onClick={() => pickRange(r)} title={`${r.id} at ${r.interval}`}>{r.id}</button>)}
        <span className="ct-sep" />
        <div className="ct-rel">
          <button className="ct-tb icon" onClick={() => setMenu(menu === "goto" ? null : "goto")} title="Go to date" aria-label="Go to date"><Calendar size={17} /></button>
          <Popover open={menu === "goto"} onClose={() => setMenu(null)} className="ct-menu up goto">
            <div className="ct-menu-sec">Go to date</div>
            <form onSubmit={(e) => {
              e.preventDefault();
              const v = (new FormData(e.currentTarget).get("d") as string) || "";
              const t = Date.parse(v + (daily ? "T00:00:00Z" : ":00Z")) / 1000;
              if (!displayBars || !Number.isFinite(t)) return;
              if (t < displayBars.t[0]) toast(`That's before the loaded ${s.interval} history (starts ${fmtBarTime(displayBars.t[0], daily, shift)}). Try a larger interval.`, "err");
              const i = Math.max(0, displayBars.t.findIndex((x) => x >= t));
              engine?.chart.timeScale().setVisibleLogicalRange({ from: i - 60, to: i + 60 });
              setMenu(null);
            }}>
              <input name="d" type={daily ? "date" : "datetime-local"} required />
              <button className="ct-btn primary" type="submit">Go to</button>
            </form>
          </Popover>
        </div>
        <span className="ct-grow" />
        <div className="ct-rel">
          <button className="ct-tb sm" onClick={() => setMenu(menu === "tz" ? null : "tz")} title="Timezone">{clock}</button>
          <Popover open={menu === "tz"} onClose={() => setMenu(null)} className="ct-menu up right">
            <div className="ct-menu-sec">Timezone</div>
            {TIMEZONES.map((z) => <MenuItem key={z.id} label={z.id === "exchange" ? `Exchange (${exchangeTz})` : z.label} hint={offsetLabel(resolveTz(z.id, exchangeTz))} active={s.tz === z.id} onClick={() => { upd({ tz: z.id }); setMenu(null); }} />)}
          </Popover>
        </div>
      </div>

      {/* ============================== dialogs */}
      {dialog && (dialog.kind === "symbol" || dialog.kind === "compare") && (
        <DatasetDialog title={dialog.kind === "symbol" ? "Datasets" : "Compare with another dataset"} datasets={datasets} current={csvName}
          exclude={dialog.kind === "compare" ? [csvName, ...s.compare.map((c) => c.slice(4))] : []}
          onClose={() => setDialog(null)} onChanged={refreshDatasets}
          onPick={(name) => {
            const sym = `CSV:${name}`;
            if (dialog.kind === "symbol") setSymbol(sym);
            else if (sym !== s.symbol && !s.compare.includes(sym)) upd({ compare: [...s.compare, sym].slice(0, 6) });
          }} />
      )}
      {dialog?.kind === "indicators" && (
        <IndicatorsDialog active={doc.indicators} onClose={() => setDialog(null)} favorites={s.favInd}
          toggleFav={(id) => upd({ favInd: s.favInd.includes(id) ? s.favInd.filter((x) => x !== id) : [...s.favInd, id] })}
          onAdd={(def) => addIndicator(def)} />
      )}
      {dialog?.kind === "settings" && (() => {
        const inst = doc.indicators.find((i) => i.id === dialog.id);
        const def = inst && INDICATOR_MAP[inst.type];
        return inst && def ? <IndicatorSettings inst={inst} def={def} onClose={() => setDialog(null)}
          onSave={(ni) => change((d) => ({ ...d, indicators: d.indicators.map((i) => (i.id === ni.id ? ni : i)) }))} /> : null;
      })()}
    </div>
  );
}

function IndLegend({ r, values, onAction }: { r: IndicatorRender; values: string[]; onAction: (a: "hide" | "settings" | "remove") => void }) {
  return (
    <div className={`ct-leg-ind ${r.inst.hidden ? "off" : ""}`}>
      <span className="ct-leg-name">{indLabel(r.def, r.inst.inputs)}</span>
      {!r.inst.hidden && values.map((v, k) => <span key={k} style={{ color: r.inst.colors[k] || r.def.plots[k].color }}>{v}</span>)}
      <span className="ct-leg-btns">
        <button onClick={() => onAction("hide")} title={r.inst.hidden ? "Show" : "Hide"}>{r.inst.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        <button onClick={() => onAction("settings")} title="Settings"><Settings2 size={14} /></button>
        <button onClick={() => onAction("remove")} title="Remove"><X size={14} /></button>
      </span>
    </div>
  );
}


/** Volume profile of the visible bars, drawn against the right edge of the price pane. */
function VolumeProfileOverlay({ engine, bars, rows, va, plotW, h, up, down }: { engine: ChartEngine; bars: Bars; rows: number; va: number; plotW: number; h: number; up: string; down: string; tick: number }) {
  const r = engine.chart.timeScale().getVisibleLogicalRange();
  if (!r || !bars.t.length) return null;
  const i0 = Math.max(0, Math.ceil(r.from)), i1 = Math.min(bars.t.length - 1, Math.floor(r.to));
  if (i1 - i0 < 2 || !bars.v.slice(i0, i1 + 1).some((v) => v > 0)) return null;
  const vp = volumeProfile(bars, i0, i1, Math.max(6, Math.min(80, rows)), va);
  const maxW = plotW * 0.28;
  return (
    <svg className="ct-vp" width={plotW} height={h}>
      {vp.rows.map((row, k) => {
        const y1 = engine.toY(row.hi), y2 = engine.toY(row.lo);
        if (y1 == null || y2 == null) return null;
        const tot = row.up + row.down, w = (tot / (vp.max || 1)) * maxW, wu = tot ? (row.up / tot) * w : 0;
        const inVa = k >= vp.vaLo && k <= vp.vaHi, a = inVa ? "66" : "2e", hh = Math.max(1, y2 - y1 - 1);
        return <g key={k}><rect x={plotW - w} y={y1} width={wu} height={hh} fill={up + a} /><rect x={plotW - w + wu} y={y1} width={w - wu} height={hh} fill={down + a} /></g>;
      })}
      {(() => { const row = vp.rows[vp.poc], y = engine.toY((row.lo + row.hi) / 2); return y == null ? null : <line x1={0} x2={plotW} y1={y} y2={y} className="ct-vp-poc" />; })()}
    </svg>
  );
}
