import React, { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

export function Card({ title, sub, actions, children, className = "", bodyClass = "card-body", style }: {
  title?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode;
  className?: string; bodyClass?: string; style?: React.CSSProperties;
}) {
  return (
    <div className={`card ${className}`} style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, full }: {
  value: T; options: { value: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void; full?: boolean;
}) {
  return (
    <div className={`seg ${full ? "full" : ""}`} role="tablist">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? "on" : ""} title={o.title}
          onClick={() => onChange(o.value)} type="button">{o.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{label}</span>
    </label>
  );
}

export function Field({ label, hint, children }: { label?: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function NumberInput({ value, onChange, step, min, max, suffix, placeholder, zeroIsOff }: {
  value: number | null | undefined; onChange: (v: number) => void; step?: number; min?: number; max?: number;
  suffix?: string; placeholder?: string; zeroIsOff?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = zeroIsOff && !value ? "" : (value ?? "");
  const input = (
    <input className="input num" type="number" step={step ?? "any"} min={min} max={max}
      placeholder={placeholder ?? (zeroIsOff ? "Off" : undefined)}
      value={text ?? shown}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value === "" && zeroIsOff) { onChange(0); return; }
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
      onBlur={() => setText(null)} />
  );
  if (!suffix) return input;
  return <div className="input-group">{input}<span className="addon">{suffix}</span></div>;
}

export function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>;
}

export function Section({ title, summary, children, defaultOpen = true }: {
  icon?: React.ReactNode; title: string; summary?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${open ? "open" : ""}`}>
      <div className="section-head" onClick={() => setOpen(!open)}>
        <span className="t">{title}</span>
        {!open && summary ? <span className="s">{summary}</span> : <span className="s" />}
        <ChevronDown size={15} className="chev" />
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />;
}

export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (v: T) => void; tabs: { id: T; label: React.ReactNode; icon?: React.ReactNode; count?: number }[];
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab ${t.id === value ? "on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}{t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, total }: { value: number; total: number }) {
  const p = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return <div className="progress"><div style={{ width: `${p}%` }} /></div>;
}
