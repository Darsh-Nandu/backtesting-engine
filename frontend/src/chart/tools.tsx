// Drawing tools: registry, toolbar groups and icons.
import type { ReactNode } from "react";
import type { DrawStyle, ToolId } from "./types";

export interface ToolDef { id: ToolId; name: string; points: number; hint?: string; key?: string }

export const TOOLS: Record<ToolId, ToolDef> = {
  cross: { id: "cross", name: "Cross", points: 0 },
  dot: { id: "dot", name: "Dot", points: 0 },
  arrow: { id: "arrow", name: "Arrow", points: 0 },
  eraser: { id: "eraser", name: "Eraser", points: 0, hint: "Click a drawing to remove it" },
  trend: { id: "trend", name: "Trend line", points: 2, key: "Alt + T" },
  ray: { id: "ray", name: "Ray", points: 2 },
  extended: { id: "extended", name: "Extended line", points: 2 },
  hline: { id: "hline", name: "Horizontal line", points: 1, key: "Alt + H" },
  hray: { id: "hray", name: "Horizontal ray", points: 1, key: "Alt + J" },
  vline: { id: "vline", name: "Vertical line", points: 1, key: "Alt + V" },
  crossline: { id: "crossline", name: "Cross line", points: 1, key: "Alt + C" },
  channel: { id: "channel", name: "Parallel channel", points: 3 },
  fib: { id: "fib", name: "Fib retracement", points: 2, key: "Alt + F" },
  fibext: { id: "fibext", name: "Trend-based fib extension", points: 3 },
  xabcd: { id: "xabcd", name: "XABCD pattern", points: 5 },
  elliott: { id: "elliott", name: "Elliott impulse wave (12345)", points: 6 },
  triangle: { id: "triangle", name: "Triangle pattern", points: 3 },
  long: { id: "long", name: "Long position", points: 2, hint: "Click the entry, then the target" },
  short: { id: "short", name: "Short position", points: 2, hint: "Click the entry, then the target" },
  range: { id: "range", name: "Date and price range", points: 2 },
  brush: { id: "brush", name: "Brush", points: -1, hint: "Press and drag to draw" },
  rect: { id: "rect", name: "Rectangle", points: 2, key: "Alt + Shift + R" },
  ellipse: { id: "ellipse", name: "Ellipse", points: 2 },
  arrowline: { id: "arrowline", name: "Arrow", points: 2 },
  text: { id: "text", name: "Text", points: 1 },
  pricelabel: { id: "pricelabel", name: "Price label", points: 1 },
  icon: { id: "icon", name: "Icon", points: 1 },
  measure: { id: "measure", name: "Measure", points: 2, hint: "Click two points to measure (Shift + click also works)" },
  zoom: { id: "zoom", name: "Zoom in", points: 2, hint: "Drag across the bars to zoom into" },
};

export const GROUPS: { id: string; title: string; tools: ToolId[] }[] = [
  { id: "cursor", title: "Cursors", tools: ["cross", "dot", "arrow", "eraser"] },
  { id: "lines", title: "Trend line tools", tools: ["trend", "ray", "extended", "hline", "hray", "vline", "crossline", "channel"] },
  { id: "fib", title: "Fibonacci tools", tools: ["fib", "fibext"] },
  { id: "patterns", title: "Patterns", tools: ["xabcd", "elliott", "triangle"] },
  { id: "forecast", title: "Forecasting and measurement tools", tools: ["long", "short", "range"] },
  { id: "shapes", title: "Brushes and shapes", tools: ["brush", "rect", "ellipse", "arrowline"] },
  { id: "text", title: "Text and notes", tools: ["text", "pricelabel"] },
  { id: "icons", title: "Icons", tools: ["icon"] },
];

export const EMOJIS = ["🚀", "🔥", "⭐", "💰", "📈", "📉", "⚠️", "✅", "❌", "🎯", "💡", "🐂", "🐻", "👀", "⏰", "📌", "❤️", "👍", "👎", "🤔"];

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
export const FIB_COLORS = ["#787b86", "#f23645", "#ff9800", "#4caf50", "#089981", "#00bcd4", "#787b86", "#2962ff", "#9c27b0"];

export const SWATCHES = ["#2962ff", "#f23645", "#089981", "#ff9800", "#9c27b0", "#00bcd4", "#e91e63", "#131722", "#787b86", "#ffeb3b"];

export function defaultStyle(tool: ToolId): DrawStyle {
  const color = tool === "fib" || tool === "fibext" ? "#787b86" : tool === "brush" ? "#f23645" : tool === "rect" || tool === "ellipse" ? "#9c27b0"
    : tool === "text" || tool === "pricelabel" ? "#131722" : "#2962ff";
  return { color, width: tool === "brush" ? 2 : tool === "rect" || tool === "ellipse" ? 1 : 2, dash: 0, fill: tool === "rect" || tool === "ellipse" || tool === "channel" };
}

// ---------------------------------------------------------------- icons (28 x 28, stroke = currentColor)
const P = (d: ReactNode) => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const dot = (x: number, y: number) => <circle cx={x} cy={y} r="2" fill="var(--ct-bg, #fff)" />;

export const ICONS: Record<string, ReactNode> = {
  cross: P(<><path d="M14 5v18M5 14h18" /></>),
  dot: P(<circle cx="14" cy="14" r="2.4" fill="currentColor" />),
  arrow: P(<path d="M9 6l11 8.5-5 .8 3 5.7-2 1-3-5.7-4 3.2z" />),
  eraser: P(<><path d="M11 22h11M6.5 16.5l8-8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L13 22H9.5l-3-3a1.8 1.8 0 0 1 0-2.5z" /><path d="M10.5 12.5l5 5" /></>),
  trend: P(<><path d="M7.5 20.5l13-13" />{dot(7, 21)}{dot(21, 7)}</>),
  ray: P(<><path d="M7.5 20.5L24 4" />{dot(7, 21)}{dot(14, 14)}</>),
  extended: P(<><path d="M4 24L24 4" />{dot(10, 18)}{dot(18, 10)}</>),
  hline: P(<><path d="M3 14h22" />{dot(14, 14)}</>),
  hray: P(<><path d="M9 14h16" />{dot(8, 14)}</>),
  vline: P(<><path d="M14 3v22" />{dot(14, 14)}</>),
  crossline: P(<><path d="M14 3v22M3 14h22" />{dot(14, 14)}</>),
  channel: P(<><path d="M4 19L20 7M8 23L24 11" />{dot(6, 17.5)}{dot(18, 8.5)}{dot(14, 18.5)}</>),
  fib: P(<><path d="M4 7h20M4 12h20M4 17h20M4 22h20" />{dot(8, 22)}{dot(20, 7)}</>),
  fibext: P(<><path d="M5 22l6-12 5 7M14 8h11M14 13h11M14 18h11" />{dot(5, 22)}{dot(11, 10)}{dot(16, 17)}</>),
  xabcd: P(<><path d="M3 20l5-12 5 8 6-10 6 13" />{dot(3, 20)}{dot(8, 8)}{dot(13, 16)}{dot(19, 6)}{dot(25, 19)}</>),
  elliott: P(<><path d="M3 22l4-8 3 4 5-12 3 6 6-8" /></>),
  triangle: P(<><path d="M5 21L14 6l9 15z" />{dot(5, 21)}{dot(14, 6)}{dot(23, 21)}</>),
  long: P(<><rect x="5" y="5" width="18" height="9" rx="1" fill="#08998133" stroke="#089981" /><rect x="5" y="14" width="18" height="7" rx="1" fill="#f2364533" stroke="#f23645" /></>),
  short: P(<><rect x="5" y="5" width="18" height="7" rx="1" fill="#f2364533" stroke="#f23645" /><rect x="5" y="12" width="18" height="9" rx="1" fill="#08998133" stroke="#089981" /></>),
  range: P(<><rect x="6" y="7" width="16" height="14" rx="1" /><path d="M14 10v8M11 13l3-3 3 3" /></>),
  brush: P(<><path d="M5 22c3 0 4-1.5 4.5-3.5.4-1.6 1.6-2.6 3.1-2.3 1.5.3 2.2 1.8 1.7 3.2C13.5 22 10 23 5 22z" /><path d="M13.5 16.5L23 7" /></>),
  rect: P(<><rect x="6" y="8" width="16" height="12" rx="1" />{dot(6, 8)}{dot(22, 20)}</>),
  ellipse: P(<ellipse cx="14" cy="14" rx="9" ry="6" />),
  arrowline: P(<><path d="M6 22L21 7M14 7h7v7" /></>),
  text: P(<><path d="M8 7h12M14 7v15M11 22h6" /></>),
  pricelabel: P(<><path d="M5 9h14l4 5-4 5H5z" /><path d="M9 14h6" /></>),
  icon: P(<><circle cx="14" cy="14" r="9" /><path d="M10.5 16.5c1.8 2.2 5.2 2.2 7 0" /><circle cx="11" cy="12" r=".9" fill="currentColor" /><circle cx="17" cy="12" r=".9" fill="currentColor" /></>),
  measure: P(<><path d="M4.5 18.5L18.5 4.5l5 5-14 14z" /><path d="M8 15l2 2M11 12l2 2M14 9l2 2M17 6l2 2" /></>),
  zoom: P(<><circle cx="12.5" cy="12.5" r="7" /><path d="M17.5 17.5L24 24M12.5 9.5v6M9.5 12.5h6" /></>),
  magnet: P(<><path d="M7 6v8a7 7 0 0 0 14 0V6h-4.5v8a2.5 2.5 0 0 1-5 0V6z" /><path d="M7 10h4.5M16.5 10H21" /></>),
  stay: P(<><path d="M6 22l1-4L18 7l3 3-11 11z" /><path d="M16 9l3 3" /><rect x="17" y="18" width="7" height="5" rx="1" /><path d="M18.5 18v-1.5a2 2 0 0 1 4 0V18" /></>),
  lock: P(<><rect x="7" y="13" width="14" height="10" rx="2" /><path d="M10 13V9.5a4 4 0 0 1 8 0V13" /></>),
  unlock: P(<><rect x="7" y="13" width="14" height="10" rx="2" /><path d="M10 13V9.5a4 4 0 0 1 7.6-1.7" /></>),
  eye: P(<><path d="M3.5 14S7.5 7 14 7s10.5 7 10.5 7-4 7-10.5 7S3.5 14 3.5 14z" /><circle cx="14" cy="14" r="3" /></>),
  eyeoff: P(<><path d="M3.5 14S7.5 7 14 7s10.5 7 10.5 7-4 7-10.5 7S3.5 14 3.5 14z" /><circle cx="14" cy="14" r="3" /><path d="M5 23L23 5" /></>),
  trash: P(<><path d="M6 8h16M11 8V6h6v2M8 8l1 15h10l1-15M12 12v7M16 12v7" /></>),
};
