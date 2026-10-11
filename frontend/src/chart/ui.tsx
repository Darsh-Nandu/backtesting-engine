// Dialogs, popovers and menus for the chart workspace.
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileSpreadsheet, Search, Star, Trash2, Upload, X } from "lucide-react";
import { chartApi, Dataset } from "./api";
import { defaultInputs, INDICATORS, IndicatorDef } from "./indicators";
import type { IndicatorInst } from "./types";

/** Close on outside click / Escape. */
export function useDismiss(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const id = setTimeout(() => document.addEventListener("mousedown", down), 0);
    document.addEventListener("keydown", key);
    return () => { clearTimeout(id); document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, onClose, ref]);
}

export function Popover({ open, onClose, children, className = "", style }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, ref);
  if (!open) return null;
  return <div ref={ref} className={`ct-pop ${className}`} style={style} onMouseDown={(e) => e.stopPropagation()}>{children}</div>;
}

export function MenuItem({ icon, label, hint, onClick, active, danger, disabled }: { icon?: ReactNode; label: ReactNode; hint?: string; onClick: () => void; active?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <button className={`ct-mi ${active ? "on" : ""} ${danger ? "danger" : ""}`} onClick={onClick} disabled={disabled}>
      {icon !== undefined && <span className="ct-mi-ic">{icon}</span>}
      <span className="ct-mi-l">{label}</span>
      {hint && <span className="ct-mi-h">{hint}</span>}
      {active && <Check size={15} className="ct-mi-check" />}
    </button>
  );
}

export function Modal({ title, onClose, children, width = 560, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div className="ct-modal-bg">
      <div ref={ref} className="ct-modal" style={{ width }} role="dialog" aria-label={typeof title === "string" ? title : undefined}>
        <div className="ct-modal-head"><span>{title}</span><button className="ct-x" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="ct-modal-body">{children}</div>
        {footer && <div className="ct-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- indicators
const CATS = ["All", "Moving averages", "Bands & channels", "Trend", "Momentum", "Volatility", "Volume", "Statistics"];

export function IndicatorsDialog({ active, onAdd, onClose, favorites, toggleFav }: {
  active: IndicatorInst[]; onAdd: (def: IndicatorDef) => void; onClose: () => void; favorites: string[]; toggleFav: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(favorites.length ? "Favorites" : "All");
  const list = useMemo(() => INDICATORS.filter((d) => (cat === "All" || (cat === "Favorites" ? favorites.includes(d.id) : d.category === cat))
    && (!q || (d.name + " " + d.short).toLowerCase().includes(q.toLowerCase()))), [q, cat, favorites]);
  const count = (id: string) => active.filter((a) => a.type === id).length;
  return (
    <Modal title="Indicators" onClose={onClose} width={760}>
      <div className="ct-search"><Search size={18} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" /></div>
      <div className="ct-ind">
        <nav className="ct-ind-cats">
          {["Favorites", ...CATS].map((c) => <button key={c} className={c === cat ? "on" : ""} onClick={() => setCat(c)}>{c === "Favorites" && <Star size={14} />}{c}</button>)}
        </nav>
        <div className="ct-ind-list">
          <div className="ct-search-sec">{q ? "Search results" : cat === "All" ? "Built-in technicals" : cat}</div>
          {list.map((d) => (
            <div key={d.id} className="ct-ind-row" role="button" tabIndex={0} onClick={() => onAdd(d)} onKeyDown={(e) => e.key === "Enter" && onAdd(d)} title={d.desc}>
              <button className={`ct-fav ${favorites.includes(d.id) ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); toggleFav(d.id); }} aria-label="Favourite"><Star size={15} /></button>
              <div><b>{d.name}</b><small>{d.desc}</small></div>
              <span className="ct-ind-pane">{d.overlay ? "On chart" : "New pane"}</span>
              {count(d.id) > 0 && <span className="ct-ind-count">{count(d.id)}</span>}
            </div>
          ))}
          {!list.length && <div className="ct-empty">{cat === "Favorites" ? "Star an indicator to add it to your favourites." : "Nothing matches."}</div>}
        </div>
      </div>
    </Modal>
  );
}

const clamp = (v: number, lo?: number, hi?: number) => Math.min(Math.max(v, lo ?? -Infinity), hi ?? Infinity);

export function IndicatorSettings({ inst, def, onSave, onClose }: { inst: IndicatorInst; def: IndicatorDef; onSave: (i: IndicatorInst) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"inputs" | "style">(def.inputs.length ? "inputs" : "style");
  const [inputs, setInputs] = useState({ ...defaultInputs(def), ...inst.inputs });
  const [colors, setColors] = useState(def.plots.map((p, i) => inst.colors[i] || p.color));
  const [text, setText] = useState<Record<string, string>>({});
  return (
    <Modal title={def.name} onClose={onClose} width={440}
      footer={<>
        <button className="ct-btn ghost" onClick={() => { setText({}); setInputs(defaultInputs(def)); setColors(def.plots.map((p) => p.color)); }}>Defaults</button>
        <span style={{ flex: 1 }} />
        <button className="ct-btn" onClick={onClose}>Cancel</button>
        <button className="ct-btn primary" onClick={() => { onSave({ ...inst, inputs, colors }); onClose(); }}>Ok</button>
      </>}>
      <div className="ct-tabs">
        {def.inputs.length > 0 && <button className={tab === "inputs" ? "on" : ""} onClick={() => setTab("inputs")}>Inputs</button>}
        <button className={tab === "style" ? "on" : ""} onClick={() => setTab("style")}>Style</button>
      </div>
      <div className="ct-form">
        {tab === "inputs" && def.inputs.map((x) => (
          <label key={x.key} className="ct-row">
            <span>{x.label}</span>
            {x.type === "select" ? (
              <select value={String(inputs[x.key])} onChange={(e) => setInputs({ ...inputs, [x.key]: e.target.value })}>
                {x.options!.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : x.type === "bool" ? (
              <input type="checkbox" checked={!!inputs[x.key]} onChange={(e) => setInputs({ ...inputs, [x.key]: e.target.checked })} />
            ) : (
              <input type="number" value={text[x.key] ?? String(inputs[x.key])} step={x.step ?? (x.type === "int" ? 1 : 0.1)} min={x.min} max={x.max}
                onChange={(e) => {
                  // Keep what the user typed (even an empty field) and only store valid numbers.
                  setText({ ...text, [x.key]: e.target.value });
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v)) setInputs({ ...inputs, [x.key]: clamp(x.type === "int" ? Math.round(v) : v, x.min, x.max) });
                }}
                onBlur={() => setText(({ [x.key]: _, ...rest }) => rest)} />
            )}
          </label>
        ))}
        {tab === "style" && def.plots.map((p, i) => (
          <label key={p.key} className="ct-row">
            <span>{p.name}</span>
            <input type="color" value={colors[i].slice(0, 7)} onChange={(e) => setColors(colors.map((c, k) => (k === i ? e.target.value : c)))} />
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- CSV datasets
/** Upload box plus the list of uploaded CSV datasets (open / delete). */
export function DatasetList({ datasets, current, exclude = [], onPick, onChanged, autoFocus }: {
  datasets: Dataset[] | null; current?: string; exclude?: string[]; onPick: (name: string) => void; onChanged: () => void; autoFocus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (file?: File | null) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try { const info = await chartApi.upload(file); onChanged(); onPick(info.name); }
    catch (e: any) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const list = (datasets || []).filter((d) => !exclude.includes(d.name) && (!q || d.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="ct-csv">
      <div className={`ct-dropzone ${over ? "over" : ""}`} onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); upload(e.dataTransfer.files?.[0]); }}>
        <Upload size={22} />
        <b>{busy ? "Uploading…" : "Upload a CSV file"}</b>
        <span>Click or drop a file. Date/time, open, high, low, close and volume columns are detected automatically (NSE bhavcopy, TradingView, MetaTrader, Binance, Yahoo exports). Only a date and a close/price column are required.</span>
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </div>
      {err && <div className="ct-csv-err">{err}</div>}
      {(datasets?.length ?? 0) > 6 && (
        <div className="ct-search sm"><Search size={16} /><input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter datasets" /></div>
      )}
      <div className="ct-search-sec">Your datasets</div>
      {datasets == null ? <div className="ct-empty sm">Loading…</div> : !list.length ? <div className="ct-empty sm">{datasets.length ? "No other datasets match." : "No CSV files uploaded yet."}</div> : list.map((d) => (
        <div key={d.name} className={`ct-search-row ${d.name === current ? "hi" : ""}`} role="button" tabIndex={0} onClick={() => onPick(d.name)} onKeyDown={(e) => e.key === "Enter" && onPick(d.name)}>
          <span className="ct-sym-logo"><FileSpreadsheet size={12} /></span>
          <b>{d.name}</b>
          <span className="ct-search-name">{d.rows.toLocaleString()} rows · {d.start.slice(0, 10)} → {d.end.slice(0, 10)}</span>
          <button className="ct-icon-btn" title="Delete dataset" aria-label={`Delete ${d.name}`}
            onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete ${d.name}? This removes the uploaded file.`)) chartApi.deleteUpload(d.name).then(onChanged); }}><Trash2 size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function DatasetDialog({ title, datasets, current, exclude, onPick, onClose, onChanged }: {
  title: string; datasets: Dataset[] | null; current?: string; exclude?: string[]; onPick: (name: string) => void; onClose: () => void; onChanged: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} width={620}>
      <DatasetList datasets={datasets} current={current} exclude={exclude} autoFocus onChanged={onChanged} onPick={(n) => { onPick(n); onClose(); }} />
    </Modal>
  );
}
