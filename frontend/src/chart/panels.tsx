// Right-hand panels: datasets, dataset details, data window and object tree.
import { ReactNode } from "react";
import { Database, Eye, EyeOff, Info, Layers, Lock, Settings2, Table2, Trash2, Unlock, X } from "lucide-react";
import type { Dataset } from "./api";
import { INDICATOR_MAP, indLabel } from "./indicators";
import { TOOLS } from "./tools";
import type { Drawing, IndicatorInst, Quote } from "./types";
import { DatasetList } from "./ui";

export type PanelTab = "datasets" | "details" | "data" | "objects";
export const PANEL_TABS: { id: PanelTab; label: string; icon: ReactNode }[] = [
  { id: "datasets", label: "Datasets", icon: <Database size={19} /> },
  { id: "details", label: "Dataset details", icon: <Info size={19} /> },
  { id: "data", label: "Data window", icon: <Table2 size={19} /> },
  { id: "objects", label: "Object tree", icon: <Layers size={19} /> },
];

export const fmtNum = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "-" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtBig = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  return a >= 1e12 ? (v / 1e12).toFixed(2) + "T" : a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0);
};
const tone = (v?: number | null) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");
const signed = (v?: number | null, d = 2) => (v == null ? "-" : `${v > 0 ? "+" : ""}${fmtNum(v, d)}`);

export interface VisibleStats { bars: number; change: number; changePct: number; high: number; low: number; rangePct: number; vol: number | null; maxDd: number; upPct: number; avgVol: number; from: string; to: string }
export interface DataRow { name: string; color?: string; values: [string, string][] }

export function RightPanel(p: {
  tab: PanelTab; onClose: () => void; symbol: string; prec: number;
  datasets: Dataset[] | null; current: string; onOpen: (name: string) => void; onDatasetsChanged: () => void;
  quote: Quote | null; stats: VisibleStats | null;
  data: { title: string; rows: DataRow[] };
  drawings: Drawing[]; indicators: IndicatorInst[];
  onDrawing: (id: string, patch: Partial<Drawing> | null) => void; onSelectDrawing: (id: string) => void;
  onIndicator: (id: string, action: "hide" | "settings" | "remove") => void; onRemoveAll: () => void;
}) {
  const t = PANEL_TABS.find((x) => x.id === p.tab)!;
  return (
    <aside className="ct-panel" aria-label={t.label}>
      <div className="ct-panel-head">
        <b>{t.label}</b>
        <button className="ct-icon-btn" onClick={p.onClose} title="Close panel"><X size={17} /></button>
      </div>
      <div className="ct-panel-body">
        {p.tab === "datasets" && <DatasetList datasets={p.datasets} current={p.current} onPick={p.onOpen} onChanged={p.onDatasetsChanged} />}
        {p.tab === "details" && <Details quote={p.quote} stats={p.stats} symbol={p.symbol} prec={p.prec} />}
        {p.tab === "data" && (
          <div className="ct-dw">
            <div className="ct-dw-title">{p.data.title}</div>
            {p.data.rows.map((r) => (
              <div key={r.name} className="ct-dw-group">
                <div className="ct-dw-name" style={{ color: r.color }}>{r.name}</div>
                {r.values.map(([k, v]) => <div key={k} className="ct-kv"><span>{k}</span><b>{v}</b></div>)}
              </div>
            ))}
          </div>
        )}
        {p.tab === "objects" && (
          <div className="ct-list">
            <div className="ct-search-sec">Indicators</div>
            {!p.indicators.length && <div className="ct-empty sm">No indicators</div>}
            {p.indicators.map((i) => {
              const def = INDICATOR_MAP[i.type];
              return def && (
                <div key={i.id} className={`ct-obj ${i.hidden ? "off" : ""}`}>
                  <span className="ct-obj-name">{indLabel(def, i.inputs)}</span>
                  <button className="ct-icon-btn" onClick={() => p.onIndicator(i.id, "hide")} title={i.hidden ? "Show" : "Hide"}>{i.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                  <button className="ct-icon-btn" onClick={() => p.onIndicator(i.id, "settings")} title="Settings"><Settings2 size={15} /></button>
                  <button className="ct-icon-btn" onClick={() => p.onIndicator(i.id, "remove")} title="Remove"><Trash2 size={15} /></button>
                </div>
              );
            })}
            <div className="ct-search-sec">Drawings on {p.symbol.replace(/^CSV:/i, "")}</div>
            {!p.drawings.length && <div className="ct-empty sm">No drawings</div>}
            {p.drawings.map((d) => (
              <div key={d.id} className={`ct-obj ${d.hidden ? "off" : ""}`}>
                <span className="ct-obj-dot" style={{ background: d.style.color }} />
                <button className="ct-obj-name link" onClick={() => p.onSelectDrawing(d.id)}>{TOOLS[d.tool].name}{d.text ? `: ${d.text}` : ""}</button>
                <button className="ct-icon-btn" onClick={() => p.onDrawing(d.id, { hidden: !d.hidden })} title={d.hidden ? "Show" : "Hide"}>{d.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button className="ct-icon-btn" onClick={() => p.onDrawing(d.id, { locked: !d.locked })} title={d.locked ? "Unlock" : "Lock"}>{d.locked ? <Lock size={15} /> : <Unlock size={15} />}</button>
                <button className="ct-icon-btn" onClick={() => p.onDrawing(d.id, null)} title="Remove"><Trash2 size={15} /></button>
              </div>
            ))}
            {(p.drawings.length > 0 || p.indicators.length > 0) && <button className="ct-btn ghost danger" style={{ margin: "12px 14px" }} onClick={p.onRemoveAll}>Remove all drawings and indicators</button>}
          </div>
        )}
      </div>
    </aside>
  );
}

function RangeBar({ lo, hi, v, label }: { lo?: number; hi?: number; v?: number; label: string }) {
  const pos = lo != null && hi != null && v != null && hi > lo ? Math.min(Math.max((v - lo) / (hi - lo), 0), 1) * 100 : null;
  return (
    <div className="ct-range">
      <div className="ct-range-k">{label}</div>
      <div className="ct-range-bar"><i style={{ left: `${pos ?? 50}%`, opacity: pos == null ? 0 : 1 }} /></div>
      <div className="ct-range-v"><span>{fmtNum(lo)}</span><span>{fmtNum(hi)}</span></div>
    </div>
  );
}

const STATE: Record<string, [string, string]> = { REGULAR: ["Market open", "open"], PRE: ["Pre-market", "ext"], PREPRE: ["Pre-market", "ext"], POST: ["Post-market", "ext"], POSTPOST: ["Post-market", "ext"], CLOSED: ["Market closed", "closed"] };
export const marketState = (s?: string) => STATE[s || ""] || ["", "closed"];

function Details({ quote: q, stats: s, symbol, prec }: { quote: Quote | null; stats: VisibleStats | null; symbol: string; prec: number }) {
  if (!q) return <div className="ct-empty">{symbol ? `Loading ${symbol.replace(/^CSV:/i, "")}…` : "Open a dataset to see its details."}</div>;
  const [st, cls] = marketState(q.market_state);
  const kv: [string, string][] = [
    ["Last bar open", fmtNum(q.open, prec)], ["Previous close", fmtNum(q.prev_close, prec)], ["Last bar volume", fmtBig(q.volume)], ["Avg volume (3M)", fmtBig(q.avg_volume)],
    ["Market cap", fmtBig(q.market_cap)], ["P/E (TTM)", fmtNum(q.pe)], ["Forward P/E", fmtNum(q.forward_pe)], ["EPS (TTM)", fmtNum(q.eps)],
    ["Beta", fmtNum(q.beta)], ["Dividend yield", q.dividend_yield == null ? "-" : `${fmtNum(q.dividend_yield)}%`], ["Price/book", fmtNum(q.pb)],
    ["50-day avg", fmtNum(q.fifty_day_avg, prec)], ["200-day avg", fmtNum(q.two_hundred_day_avg, prec)], ["Analyst target", fmtNum(q.target_price, prec)],
  ];
  return (
    <div className="ct-details">
      <div className="ct-det-head">
        <span className="ct-sym-logo lg">{symbol.replace(/^CSV:/i, "").slice(0, 1)}</span>
        <div><b>{symbol.replace(/^CSV:/i, "")}</b><small>{q.name || q.short_name}</small><small className="muted">{[q.exchange_name, q.currency].filter(Boolean).join(" · ")}</small></div>
      </div>
      <div className="ct-det-price">
        <span className="big">{fmtNum(q.last, prec)}</span><span className="cur">{q.currency}</span>
        <span className={tone(q.change)}>{signed(q.change, prec)} ({signed(q.change_pct)}%)</span>
      </div>
      {st && <div className={`ct-state ${cls}`}><i />{st}</div>}
      <RangeBar label="Last bar's range" lo={q.day_low} hi={q.day_high} v={q.last} />
      <RangeBar label="Last 12 months' range" lo={q.year_low} hi={q.year_high} v={q.last} />
      <div className="ct-kvs">{kv.filter(([, v]) => v !== "-").map(([k, v]) => <div key={k} className="ct-kv"><span>{k}</span><b>{v}</b></div>)}</div>
      {s && (
        <>
          <div className="ct-search-sec">Visible range · {s.bars} bars</div>
          <div className="ct-sub">{s.from} - {s.to}</div>
          <div className="ct-kvs">
            <div className="ct-kv"><span>Change</span><b className={tone(s.change)}>{signed(s.change, prec)} ({signed(s.changePct)}%)</b></div>
            <div className="ct-kv"><span>High / low</span><b>{fmtNum(s.high, prec)} / {fmtNum(s.low, prec)}</b></div>
            <div className="ct-kv"><span>Range</span><b>{fmtNum(s.rangePct)}%</b></div>
            <div className="ct-kv"><span>Volatility (annualised)</span><b>{s.vol == null ? "-" : `${fmtNum(s.vol, 1)}%`}</b></div>
            <div className="ct-kv"><span>Max drawdown</span><b className="down">{fmtNum(s.maxDd)}%</b></div>
            <div className="ct-kv"><span>Up bars</span><b>{fmtNum(s.upPct, 1)}%</b></div>
            <div className="ct-kv"><span>Avg volume per bar</span><b>{fmtBig(s.avgVol)}</b></div>
          </div>
        </>
      )}
      {(q.sector || q.industry) && <><div className="ct-search-sec">Profile</div><div className="ct-kvs">
        {q.sector && <div className="ct-kv"><span>Sector</span><b>{q.sector}</b></div>}
        {q.industry && <div className="ct-kv"><span>Industry</span><b>{q.industry}</b></div>}
        {q.country && <div className="ct-kv"><span>Country</span><b>{q.country}</b></div>}
      </div></>}
      {q.summary && <p className="ct-summary">{q.summary}</p>}
    </div>
  );
}
