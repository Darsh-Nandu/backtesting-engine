// SVG overlay for drawings. Anchors are stored as (UTC time, price) and re-projected on every
// viewport change, so drawings stick to bars when you scroll, zoom, or change interval.
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ChartEngine } from "./engine";
import { precisionFor } from "./engine";
import { defaultStyle, FIB_COLORS, FIB_EXT_LEVELS, FIB_LEVELS, TOOLS } from "./tools";
import type { Bars, Drawing, Pt, ToolId } from "./types";

export type Magnet = "off" | "weak" | "strong";

interface Props {
  engine: ChartEngine; tick: number; bars: Bars;
  drawings: Drawing[]; selected: string | null; tool: ToolId; magnet: Magnet;
  lockAll: boolean; hidden: boolean; icon: string; replaySelecting: boolean;
  onCreate: (d: Drawing) => void;
  onUpdate: (id: string, patch: Partial<Drawing>, commit: boolean) => void;
  onSelect: (id: string | null) => void;
  onErase: (id: string) => void;
  onZoom: (l1: number, l2: number) => void;
  onReplayPick: (index: number) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const dashOf = (d: number) => (d === 1 ? "6 4" : d === 2 ? "1.5 3.5" : undefined);
const fmtVol = (v: number) => (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));
export function fmtSpan(sec: number) {
  const a = Math.abs(sec);
  const d = Math.floor(a / 86400), h = Math.floor((a % 86400) / 3600), m = Math.round((a % 3600) / 60);
  return d ? `${d}d${h ? ` ${h}h` : ""}` : h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

const isArea = (n: ReactNode) => !!n && typeof n === "object" && "props" in (n as any) && String((n as any).props?.className || "").includes("dl-hit-area");

const PLACE_TOOLS = new Set<ToolId>(Object.values(TOOLS).filter((t) => t.points !== 0).map((t) => t.id));

export function DrawingLayer(props: Props) {
  const { engine, bars, drawings, selected, tool, magnet, lockAll, hidden, replaySelecting } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [pending, setPending] = useState<{ tool: ToolId; pts: Pt[]; down?: { x: number; y: number } } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; pt: Pt } | null>(null);
  const [temp, setTemp] = useState<{ tool: ToolId; pts: Pt[] } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "pt"; idx: number; x0: number; y0: number; orig: Pt[]; moved: boolean } | null>(null);
  const live = useRef(props);
  live.current = props;

  const L = engine.layout();
  const W = L.plotW, H = L.panes[0] || 0, S = L.scaleW;
  const prec = precisionFor(bars.c[bars.c.length - 1] ?? 1);
  const fp = (p: number) => p.toFixed(prec);
  const X = (t: number) => engine.toX(t) ?? -1e4;
  const Y = (p: number) => engine.toY(p) ?? -1e4;
  const placing = PLACE_TOOLS.has(tool) || replaySelecting;

  // Cancel an in-progress placement when the tool changes.
  useEffect(() => { setPending(null); if (tool !== "measure") setTemp(null); }, [tool]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const toPt = useCallback((x: number, y: number, snap = true): Pt => {
    const { engine: en, bars: b, magnet: mg } = live.current;
    let t = en.fromX(x), p = en.fromY(y);
    if (snap && mg !== "off") {
      const i = en.indexAt(x);
      if (i >= 0 && i < b.t.length) {
        let best = p, bd = Infinity;
        for (const c of [b.o[i], b.h[i], b.l[i], b.c[i]]) { const d = Math.abs((en.toY(c) ?? 1e9) - y); if (d < bd) { bd = d; best = c; } }
        if (mg === "strong" || bd < 22) { p = best; t = b.t[i]; }
      }
    }
    return { t, p };
  }, []);

  const finish = (tl: ToolId, pts: Pt[]) => {
    setPending(null);
    if (tl === "measure") { setTemp({ tool: tl, pts }); return; }
    if (tl === "zoom") {
      const a = engine.tToLogical(pts[0].t), b = engine.tToLogical(pts[1].t);
      if (Math.abs(a - b) > 1) props.onZoom(Math.min(a, b), Math.max(a, b));
      return;
    }
    let final = pts;
    if (tl === "long" || tl === "short") {
      const [e, tg] = pts;
      let target = tg.p;
      if (tl === "long" && target <= e.p) target = e.p + (e.p - target || e.p * 0.02);
      if (tl === "short" && target >= e.p) target = e.p - (target - e.p || e.p * 0.02);
      const t1 = tg.t > e.t ? tg.t : e.t + engine.step * 20;
      final = [{ t: e.t, p: e.p }, { t: t1, p: target }, { t: t1, p: e.p - (target - e.p) / 2 }];
    }
    const d: Drawing = { id: uid(), tool: tl, pts: final, style: defaultStyle(tl) };
    if (tl === "text") d.text = "Text";
    if (tl === "icon") d.icon = props.icon;
    props.onCreate(d);
    if (tl === "text") setEditing({ id: d.id, value: "" });
  };

  // ---------------------------------------------------------------- placement
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    if (x > W || y > H) return;
    e.preventDefault();
    if (replaySelecting) { props.onReplayPick(Math.max(0, Math.min(bars.t.length - 1, engine.indexAt(x)))); return; }
    const def = TOOLS[tool];
    const pt = toPt(x, y, tool !== "measure" && tool !== "zoom");
    setTemp(null);
    if (def.points === 1) { finish(tool, [pt]); return; }
    if (def.points === -1) { setPending({ tool, pts: [pt], down: { x, y } }); svgRef.current?.setPointerCapture(e.pointerId); return; }
    if (!pending) { setPending({ tool, pts: [pt], down: { x, y } }); svgRef.current?.setPointerCapture(e.pointerId); return; }
    const pts = [...pending.pts, pt];
    if (pts.length >= def.points) finish(tool, pts);
    else setPending({ ...pending, pts, down: { x, y } });
  };

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const pt = toPt(x, y, tool !== "measure" && tool !== "zoom");
    setCursor({ x, y, pt });
    if (pending && TOOLS[pending.tool].points === -1 && e.buttons & 1) {
      const last = pending.pts[pending.pts.length - 1];
      if (Math.hypot(X(last.t) - x, Y(last.p) - y) > 2) setPending({ ...pending, pts: [...pending.pts, toPt(x, y, false)] });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!pending) return;
    const { x, y } = local(e);
    const def = TOOLS[pending.tool];
    if (def.points === -1) { if (pending.pts.length > 1) finish(pending.tool, pending.pts); else setPending(null); return; }
    // Press-drag-release places the second point too (in addition to click, click).
    if (pending.pts.length === 1 && pending.down && Math.hypot(pending.down.x - x, pending.down.y - y) > 8) {
      const pts = [...pending.pts, toPt(x, y, pending.tool !== "measure" && pending.tool !== "zoom")];
      if (pts.length >= def.points) finish(pending.tool, pts);
      else setPending({ ...pending, pts, down: undefined });
    }
  };

  // ---------------------------------------------------------------- selection & dragging
  const startDrag = (e: React.PointerEvent, d: Drawing, mode: "move" | "pt", idx = 0) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (tool === "eraser") { props.onErase(d.id); return; }
    props.onSelect(d.id);
    if (d.locked || lockAll) return;
    const { x, y } = local(e);
    drag.current = { id: d.id, mode, idx, x0: x, y0: y, orig: d.pts.map((p) => ({ ...p })), moved: false };
    engine.setInteractive(false);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const dr = drag.current;
      if (!dr || !svgRef.current) return;
      const { engine: en } = live.current;
      const { x, y } = local(e);
      const dx = x - dr.x0, dy = y - dr.y0;
      if (!dr.moved && Math.hypot(dx, dy) < 3) return;
      dr.moved = true;
      const d = live.current.drawings.find((q) => q.id === dr.id);
      if (!d) return;
      let pts: Pt[];
      if (dr.mode === "move") {
        pts = dr.orig.map((p) => ({ t: en.fromX((en.toX(p.t) ?? 0) + dx), p: en.fromY((en.toY(p.p) ?? 0) + dy) }));
      } else {
        const np = toPt(x, y);
        pts = dr.orig.map((p) => ({ ...p }));
        if (d.tool === "long" || d.tool === "short") {
          if (dr.idx === 0) { pts[0] = np; }
          else if (dr.idx === 1) pts[1].p = np.p;
          else if (dr.idx === 2) pts[2].p = np.p;
          else { pts[1].t = np.t; pts[2].t = np.t; }
        } else if (d.tool === "hline" || d.tool === "hray" || d.tool === "pricelabel") pts[dr.idx] = { t: d.tool === "hline" ? pts[dr.idx].t : np.t, p: np.p };
        else if (d.tool === "vline") pts[0] = { t: np.t, p: pts[0].p };
        else pts[dr.idx] = np;
      }
      live.current.onUpdate(dr.id, { pts }, false);
    };
    const up = () => {
      const dr = drag.current;
      if (!dr) return;
      drag.current = null;
      live.current.engine.setInteractive(true);
      if (dr.moved) {
        const d = live.current.drawings.find((q) => q.id === dr.id);
        if (d) live.current.onUpdate(dr.id, { pts: d.pts }, true);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [toPt]);

  // ---------------------------------------------------------------- rendering helpers
  const axisTag = (y: number, text: string, color: string, key: string) => y > -50 && y < H + 50 && (
    <g key={key} className="dl-axis-tag">
      <rect x={W + 1} y={y - 10} width={S - 2} height={20} rx={2} fill={color} />
      <text x={W + 6} y={y + 4} fill="#fff">{text}</text>
    </g>
  );

  const ext = (x1: number, y1: number, x2: number, y2: number, left: boolean, right: boolean) => {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) < 1e-6) {
      return [x1, left ? (dy > 0 ? -50 : H + 50) : y1, x2, right ? (dy > 0 ? H + 50 : -50) : y2];
    }
    const k = dy / dx;
    let ax = x1, ay = y1, bx = x2, by = y2;
    if (right) { bx = dx >= 0 ? W + 50 : -50; by = y1 + k * (bx - x1); }
    if (left) { ax = dx >= 0 ? -50 : W + 50; ay = y1 + k * (ax - x1); }
    return [ax, ay, bx, by];
  };

  const label = (x: number, y: number, text: string, color: string, opts: { anchor?: "start" | "middle" | "end"; bg?: string; size?: number; key?: string } = {}) => (
    <text key={opts.key} x={x} y={y} fill={color} fontSize={opts.size ?? 12} fontWeight={600} textAnchor={opts.anchor ?? "start"}
      className={opts.bg ? "dl-label-bg" : "dl-label"} style={opts.bg ? ({ "--lbg": opts.bg } as any) : undefined}>{text}</text>
  );

  const box = (x: number, y: number, lines: string[], fill: string, color = "#fff") => {
    const w = Math.max(...lines.map((l) => l.length)) * 6.6 + 16, h = lines.length * 16 + 8;
    return (
      <g pointerEvents="none">
        <rect x={x - w / 2} y={y} width={w} height={h} rx={4} fill={fill} />
        {lines.map((l, i) => <text key={i} x={x} y={y + 17 + i * 16} fill={color} fontSize={12} fontWeight={600} textAnchor="middle">{l}</text>)}
      </g>
    );
  };

  const barsBetween = (t1: number, t2: number) => {
    const a = Math.min(t1, t2), b = Math.max(t1, t2);
    let vol = 0, n = 0;
    for (let i = 0; i < bars.t.length; i++) if (bars.t[i] >= a && bars.t[i] <= b) { vol += bars.v[i]; n++; }
    return { vol, n };
  };

  const rangeInfo = (a: Pt, b: Pt) => {
    const dp = b.p - a.p, pc = (dp / a.p) * 100;
    const nb = Math.round(engine.tToLogical(b.t) - engine.tToLogical(a.t));
    const { vol } = barsBetween(a.t, b.t);
    return [`${dp >= 0 ? "+" : ""}${fp(dp)} (${pc >= 0 ? "+" : ""}${pc.toFixed(2)}%)`, `${nb} bars, ${fmtSpan(b.t - a.t)}`, `Vol ${fmtVol(vol)}`];
  };

  /** Visual + hit-area + handles for one drawing (also used for previews). */
  const render = (d: Drawing, preview = false): { vis: ReactNode; hit: ReactNode; handles: { x: number; y: number }[]; tags: [number, number][] } => {
    const c = d.style.color, w = d.style.width, dash = dashOf(d.style.dash);
    const P = d.pts.map((p) => ({ x: X(p.t), y: Y(p.p) }));
    const line = (x1: number, y1: number, x2: number, y2: number, k: string | number, extra: any = {}) =>
      <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={w} strokeDasharray={dash} {...extra} />;
    const hitLine = (x1: number, y1: number, x2: number, y2: number, k: string | number) =>
      <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} className="dl-hit" />;
    const out = { vis: null as ReactNode, hit: null as ReactNode, handles: P, tags: [] as [number, number][] };
    switch (d.tool) {
      case "trend": case "ray": case "extended": case "arrowline": {
        if (P.length < 2) return out;
        const [ax, ay, bx, by] = ext(P[0].x, P[0].y, P[1].x, P[1].y, d.tool === "extended", d.tool === "ray" || d.tool === "extended");
        let head: ReactNode = null;
        if (d.tool === "arrowline") {
          const ang = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), s = 10 + w * 2;
          head = <polygon points={`${P[1].x},${P[1].y} ${P[1].x - s * Math.cos(ang - 0.4)},${P[1].y - s * Math.sin(ang - 0.4)} ${P[1].x - s * Math.cos(ang + 0.4)},${P[1].y - s * Math.sin(ang + 0.4)}`} fill={c} />;
        }
        out.vis = <>{line(ax, ay, bx, by, 0)}{head}</>;
        out.hit = hitLine(ax, ay, bx, by, 0);
        out.tags = d.pts.map((p) => [Y(p.p), p.p]);
        return out;
      }
      case "hline": case "hray": case "crossline": {
        const x0 = d.tool === "hray" ? P[0].x : -10;
        out.vis = <>{line(x0, P[0].y, W, P[0].y, 0)}{d.tool === "crossline" && line(P[0].x, -10, P[0].x, H + 10, 1)}</>;
        out.hit = <>{hitLine(x0, P[0].y, W, P[0].y, 0)}{d.tool === "crossline" && hitLine(P[0].x, 0, P[0].x, H, 1)}</>;
        out.handles = d.tool === "hline" ? [{ x: Math.min(Math.max(P[0].x, 30), W - 30), y: P[0].y }] : P;
        out.tags = [[P[0].y, d.pts[0].p]];
        return out;
      }
      case "vline":
        out.vis = line(P[0].x, -10, P[0].x, H + 10, 0);
        out.hit = hitLine(P[0].x, 0, P[0].x, H, 0);
        out.handles = [{ x: P[0].x, y: H / 2 }];
        return out;
      case "channel": {
        if (P.length < 2) return out;
        const off = P.length > 2 ? P[2].y - (P[0].y + ((P[1].y - P[0].y) * (P[2].x - P[0].x)) / ((P[1].x - P[0].x) || 1)) : 0;
        const poly = `${P[0].x},${P[0].y} ${P[1].x},${P[1].y} ${P[1].x},${P[1].y + off} ${P[0].x},${P[0].y + off}`;
        out.vis = <>{d.style.fill && <polygon points={poly} fill={c + "1f"} />}{line(P[0].x, P[0].y, P[1].x, P[1].y, 0)}
          {P.length > 2 && <>{line(P[0].x, P[0].y + off, P[1].x, P[1].y + off, 1)}{line(P[0].x, P[0].y + off / 2, P[1].x, P[1].y + off / 2, 2, { strokeDasharray: "4 4", strokeWidth: 1 })}</>}</>;
        out.hit = <polygon points={poly} className="dl-hit-area" />;
        if (P.length > 2) out.handles = [P[0], P[1], { x: P[2].x, y: P[0].y + off + ((P[1].y - P[0].y) * (P[2].x - P[0].x)) / ((P[1].x - P[0].x) || 1) }];
        return out;
      }
      case "fib": case "fibext": {
        if (P.length < 2) return out;
        const levels = d.tool === "fib" ? FIB_LEVELS : FIB_EXT_LEVELS;
        const price = (lv: number) => d.tool === "fib" ? d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv
          : (d.pts[2] ?? d.pts[1]).p + (d.pts[1].p - d.pts[0].p) * lv;
        const anchorX = d.tool === "fib" ? Math.min(P[0].x, P[1].x) : (P[2] ?? P[1]).x;
        const x1 = anchorX, x2 = Math.max(d.tool === "fib" ? Math.max(P[0].x, P[1].x) : x1 + 80, x1 + 60);
        if (d.tool === "fibext" && P.length < 3) { out.vis = line(P[0].x, P[0].y, P[1].x, P[1].y, 0, { strokeDasharray: "4 4" }); return out; }
        const ys = levels.map((lv) => Y(price(lv)));
        out.vis = <>
          {ys.slice(0, -1).map((y, i) => <rect key={"f" + i} x={x1} y={Math.min(y, ys[i + 1])} width={x2 - x1} height={Math.abs(ys[i + 1] - y)} fill={FIB_COLORS[(i + 1) % FIB_COLORS.length] + "18"} />)}
          {ys.map((y, i) => <g key={"l" + i}>
            <line x1={x1} y1={y} x2={x2} y2={y} stroke={FIB_COLORS[i % FIB_COLORS.length]} strokeWidth={1} />
            {label(x1 - 4, y + 4, `${levels[i]} (${fp(price(levels[i]))})`, FIB_COLORS[i % FIB_COLORS.length], { anchor: "end", size: 11 })}
          </g>)}
          <polyline points={P.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={c} strokeWidth={1} strokeDasharray="4 4" />
        </>;
        out.hit = <rect x={x1} y={Math.min(...ys)} width={x2 - x1} height={Math.max(...ys) - Math.min(...ys)} className="dl-hit-area" />;
        return out;
      }
      case "xabcd": case "elliott": case "triangle": {
        const names = d.tool === "xabcd" ? ["X", "A", "B", "C", "D"] : d.tool === "elliott" ? ["(0)", "(1)", "(2)", "(3)", "(4)", "(5)"] : ["A", "B", "C"];
        const pts = P.map((p) => `${p.x},${p.y}`).join(" ");
        const fills: ReactNode[] = [];
        if (d.tool === "xabcd") {
          if (P.length >= 3) fills.push(<polygon key="t1" points={`${P[0].x},${P[0].y} ${P[1].x},${P[1].y} ${P[2].x},${P[2].y}`} fill={c + "22"} />);
          if (P.length >= 5) fills.push(<polygon key="t2" points={`${P[2].x},${P[2].y} ${P[3].x},${P[3].y} ${P[4].x},${P[4].y}`} fill={c + "22"} />);
        }
        if (d.tool === "triangle" && P.length >= 3) fills.push(<polygon key="tri" points={pts} fill={c + "22"} />);
        out.vis = <>{fills}<polyline points={pts + (d.tool === "triangle" && P.length >= 3 ? ` ${P[0].x},${P[0].y}` : "")} fill="none" stroke={c} strokeWidth={w} strokeDasharray={dash} />
          {P.map((p, i) => {
            const up = i === 0 ? p.y < (P[1]?.y ?? p.y) : p.y < (P[i - 1]?.y ?? p.y);
            return label(p.x, p.y + (up ? -10 : 20), names[i] ?? "", "#fff", { anchor: "middle", bg: c, key: "n" + i });
          })}</>;
        out.hit = <polyline points={pts} className="dl-hit" fill="none" />;
        return out;
      }
      case "long": case "short": {
        if (P.length < 3) return out;
        const [e, tg, st] = d.pts;
        const x0 = P[0].x, x1 = Math.max(P[1].x, x0 + 20), yE = P[0].y, yT = P[1].y, yS = P[2].y;
        const pT = ((tg.p - e.p) / e.p) * 100, pS = ((st.p - e.p) / e.p) * 100;
        const rr = Math.abs(tg.p - e.p) / (Math.abs(e.p - st.p) || 1e-9);
        // Did price reach the target or the stop first after entry?
        let outcome: string | null = null;
        for (let i = 0; i < bars.t.length; i++) {
          if (bars.t[i] <= e.t || bars.t[i] > tg.t) continue;
          const hitStop = d.tool === "long" ? bars.l[i] <= st.p : bars.h[i] >= st.p;
          const hitTgt = d.tool === "long" ? bars.h[i] >= tg.p : bars.l[i] <= tg.p;
          if (hitStop) { outcome = "Stop hit"; break; }
          if (hitTgt) { outcome = "Target reached"; break; }
        }
        const G = "#089981", R = "#f23645";
        out.vis = <>
          <rect x={x0} y={Math.min(yE, yT)} width={x1 - x0} height={Math.abs(yT - yE)} fill={G + "33"} />
          <rect x={x0} y={Math.min(yE, yS)} width={x1 - x0} height={Math.abs(yS - yE)} fill={R + "33"} />
          <line x1={x0} y1={yE} x2={x1} y2={yE} stroke="#787b86" strokeWidth={1} />
          {!preview && <>
            {box((x0 + x1) / 2, (d.tool === "long" ? Math.min(yT, yE) : Math.max(yT, yE)) + (d.tool === "long" ? -42 : 4), [`Target: ${fp(tg.p)} (${pT >= 0 ? "+" : ""}${pT.toFixed(2)}%)`, `${fp(Math.abs(tg.p - e.p))}`], G)}
            {box((x0 + x1) / 2, (d.tool === "long" ? Math.max(yS, yE) : Math.min(yS, yE)) + (d.tool === "long" ? 4 : -42), [`Stop: ${fp(st.p)} (${pS >= 0 ? "+" : ""}${pS.toFixed(2)}%)`, `${fp(Math.abs(st.p - e.p))}`], R)}
            {box((x0 + x1) / 2, yE - 12, [`Risk/reward ratio: ${rr.toFixed(2)}${outcome ? ` · ${outcome}` : ""}`], outcome === "Stop hit" ? R : outcome ? G : "#787b86")}
          </>}
        </>;
        out.hit = <rect x={x0} y={Math.min(yT, yS)} width={x1 - x0} height={Math.abs(yT - yS)} className="dl-hit-area" />;
        out.handles = [{ x: x0, y: yE }, { x: x0, y: yT }, { x: x0, y: yS }, { x: x1, y: yE }];
        out.tags = [[yE, e.p], [yT, tg.p], [yS, st.p]];
        return out;
      }
      case "range": case "measure": {
        if (P.length < 2) return out;
        const up = d.pts[1].p >= d.pts[0].p;
        const col = d.tool === "measure" ? (up ? "#2962ff" : "#f23645") : c;
        const x1 = Math.min(P[0].x, P[1].x), x2 = Math.max(P[0].x, P[1].x), y1 = Math.min(P[0].y, P[1].y), y2 = Math.max(P[0].y, P[1].y);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        out.vis = <>
          <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill={col + "22"} />
          <line x1={mx} y1={P[0].y} x2={mx} y2={P[1].y} stroke={col} strokeWidth={1.4} />
          <line x1={P[0].x} y1={my} x2={P[1].x} y2={my} stroke={col} strokeWidth={1.4} />
          <polygon points={`${mx},${P[1].y} ${mx - 5},${P[1].y + (up ? 8 : -8)} ${mx + 5},${P[1].y + (up ? 8 : -8)}`} fill={col} />
          {box(mx, up ? y1 - 60 : y2 + 6, rangeInfo(d.pts[0], d.pts[1]), col)}
        </>;
        out.hit = <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} className="dl-hit-area" />;
        return out;
      }
      case "brush":
        out.vis = <polyline points={P.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={c} strokeWidth={w} strokeDasharray={dash} />;
        out.hit = <polyline points={P.map((p) => `${p.x},${p.y}`).join(" ")} className="dl-hit" fill="none" />;
        out.handles = [];
        return out;
      case "rect": case "ellipse": {
        if (P.length < 2) return out;
        const x1 = Math.min(P[0].x, P[1].x), y1 = Math.min(P[0].y, P[1].y), ww = Math.abs(P[1].x - P[0].x), hh = Math.abs(P[1].y - P[0].y);
        const fill = d.style.fill ? c + "26" : "none";
        out.vis = d.tool === "rect" ? <rect x={x1} y={y1} width={ww} height={hh} fill={fill} stroke={c} strokeWidth={w} strokeDasharray={dash} />
          : <ellipse cx={x1 + ww / 2} cy={y1 + hh / 2} rx={ww / 2} ry={hh / 2} fill={fill} stroke={c} strokeWidth={w} strokeDasharray={dash} />;
        out.hit = d.tool === "rect" ? <rect x={x1} y={y1} width={ww} height={hh} className="dl-hit-area" /> : <ellipse cx={x1 + ww / 2} cy={y1 + hh / 2} rx={ww / 2} ry={hh / 2} className="dl-hit-area" />;
        return out;
      }
      case "text": {
        const txt = d.text || "Text";
        out.vis = <text x={P[0].x} y={P[0].y} fill={c} fontSize={12 + w * 2} fontWeight={600}>{txt}</text>;
        out.hit = <rect x={P[0].x - 4} y={P[0].y - 14 - w * 2} width={txt.length * (7 + w) + 8} height={22 + w * 2} className="dl-hit-area" />;
        return out;
      }
      case "pricelabel": {
        const txt = fp(d.pts[0].p), bw = txt.length * 7.4 + 14;
        out.vis = <g>
          <path d={`M${P[0].x},${P[0].y} l8,-12 h${bw} v-14 h${-bw} z`} transform={`translate(0,0)`} fill="none" />
          <rect x={P[0].x + 8} y={P[0].y - 30} width={bw} height={22} rx={4} fill={c} />
          <path d={`M${P[0].x},${P[0].y} L${P[0].x + 8},${P[0].y - 12} L${P[0].x + 18},${P[0].y - 9}z`} fill={c} />
          <text x={P[0].x + 15} y={P[0].y - 15} fill="#fff" fontSize={12} fontWeight={700}>{txt}</text>
        </g>;
        out.hit = <rect x={P[0].x} y={P[0].y - 30} width={bw + 10} height={30} className="dl-hit-area" />;
        out.tags = [[P[0].y, d.pts[0].p]];
        return out;
      }
      case "icon":
        out.vis = <text x={P[0].x} y={P[0].y + 9} fontSize={24} textAnchor="middle">{d.icon || "⭐"}</text>;
        out.hit = <rect x={P[0].x - 14} y={P[0].y - 14} width={28} height={28} className="dl-hit-area" />;
        return out;
      default:
        return out;
    }
  };

  // ---------------------------------------------------------------- previews
  let preview: ReactNode = null;
  if (pending && cursor) {
    const def = TOOLS[pending.tool];
    let pts = def.points === -1 ? pending.pts : [...pending.pts, cursor.pt];
    if (pending.tool === "long" || pending.tool === "short") {
      const e = pts[0], tg = pts[1] ?? e;
      const t1 = tg.t > e.t ? tg.t : e.t + engine.step * 20;
      pts = [e, { t: t1, p: tg.p }, { t: t1, p: e.p - (tg.p - e.p) / 2 }];
    }
    if (pending.tool === "zoom") {
      const x1 = X(pts[0].t), x2 = cursor.x;
      preview = <rect x={Math.min(x1, x2)} y={0} width={Math.abs(x2 - x1)} height={H} className="dl-zoom" />;
    } else preview = render({ id: "_p", tool: pending.tool, pts, style: defaultStyle(pending.tool), icon: props.icon, text: "Text" }, true).vis;
  }

  const visible = hidden ? [] : drawings.filter((d) => !d.hidden);
  const sel = visible.find((d) => d.id === selected);
  const rendered = visible.map((d) => ({ d, r: render(d) }));
  const selR = rendered.find((x) => x.d.id === selected)?.r;
  const editD = editing ? drawings.find((d) => d.id === editing.id) : null;

  return (
    <>
      <svg ref={svgRef} className={`dl ${placing ? "placing" : ""} ${tool === "eraser" ? "erasing" : ""}`} width={W + S} height={H}
        style={{ pointerEvents: placing ? "all" : "none" }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)}
        onContextMenu={(e) => { if (pending) { e.preventDefault(); setPending(null); } }}>
        <defs><clipPath id="dl-clip"><rect x={0} y={0} width={W} height={H} /></clipPath></defs>
        <g clipPath="url(#dl-clip)">
          {rendered.map(({ d, r }) => <g key={d.id} className={`dl-item ${d.id === selected ? "sel" : ""}`}>{r.vis}</g>)}
          {/* Hit areas: filled shapes underneath, thin lines on top, so a line inside a box stays clickable. */}
          {[true, false].map((areas) => rendered.filter(({ r }) => isArea(r.hit) === areas).map(({ d, r }) => (
            <g key={(areas ? "a" : "l") + d.id} className="dl-hits" onPointerDown={(e) => startDrag(e, d, "move")}
              onDoubleClick={() => { if (d.tool === "text") setEditing({ id: d.id, value: d.text || "" }); }}>{r.hit}</g>
          )))}
          {temp && render({ id: "_m", tool: temp.tool, pts: temp.pts, style: defaultStyle(temp.tool) }).vis}
          {preview}
          {replaySelecting && cursor && cursor.x < W && <g pointerEvents="none">
            <rect x={cursor.x} y={0} width={W - cursor.x} height={H} className="dl-replay-shade" />
            <line x1={cursor.x} y1={0} x2={cursor.x} y2={H} className="dl-replay-line" />
            {box(cursor.x, 12, ["Click to start the replay here"], "#2962ff")}
          </g>}
          {sel && selR && !sel.locked && !lockAll && selR.handles.map((h, i) => (
            <circle key={i} cx={h.x} cy={h.y} r={5.5} className="dl-handle" stroke={sel.style.color}
              onPointerDown={(e) => startDrag(e, sel, "pt", i)} />
          ))}
        </g>
        {/* Price tags on the axis for horizontal lines and the selected drawing */}
        {rendered.filter(({ d }) => d.tool === "hline" || d.tool === "hray" || d.tool === "crossline" || d.id === selected)
          .flatMap(({ d, r }) => r.tags.map(([y, p], i) => axisTag(y, fp(p), d.style.color, d.id + i)))}
        {pending && cursor && TOOLS[pending.tool].hint && <text x={10} y={H - 12} className="dl-hint">{TOOLS[pending.tool].hint}</text>}
      </svg>
      {editing && editD && (
        <input className="dl-text-edit" autoFocus value={editing.value} placeholder="Type your text"
          style={{ left: X(editD.pts[0].t) - 4, top: Y(editD.pts[0].p) - 22 }}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
          onBlur={() => { if (editing.value.trim()) props.onUpdate(editing.id, { text: editing.value.trim() }, true); else if (!editD.text || editD.text === "Text") props.onErase(editing.id); setEditing(null); }} />
      )}
    </>
  );
}
