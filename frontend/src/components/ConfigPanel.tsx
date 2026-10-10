import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api, BacktestRequest, StrategyInfo, TradingRules } from "../api";
import { isoDay, money } from "../format";
import { activeRules, DEFAULT_RULES, useApp } from "../store";
import { Field, NumberInput, Section, Seg, Select, Toggle } from "./ui";

export function ConfigPanel({ footer, hideParams = false }: { footer?: React.ReactNode; hideParams?: boolean }) {
  const { config: c, setConfig, meta, strategies } = useApp();
  const set = (patch: Partial<BacktestRequest>) => setConfig((x) => ({ ...x, ...patch }));
  const market = meta?.markets.find((m) => m.code === c.market);
  const strat = strategies.find((s) => s.id === c.strategy.id);
  const [uploads, setUploads] = useState<{ name: string; rows: number }[]>([]);

  useEffect(() => {
    if (c.source === "csv") api.uploads().then(setUploads).catch(() => setUploads([]));
  }, [c.source]);

  const grouped = useMemo(() => {
    const g: Record<string, StrategyInfo[]> = {};
    strategies.forEach((s) => (g[s.category] ||= []).push(s));
    return g;
  }, [strategies]);

  const preset = (years: number | "ytd" | "max") => {
    const end = new Date();
    let start: Date;
    if (years === "ytd") start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
    else if (years === "max") start = new Date("1990-01-01");
    else { start = new Date(end); start.setFullYear(end.getFullYear() - years); }
    set({ start: isoDay(start), end: isoDay(end) });
  };

  const costKind = c.cost.kind || market?.cost_model || "percent";
  const intraday = meta?.intraday_limits[c.interval];

  return (
    <div className="card">
      <Section title="Data"
        summary={`${c.source === "yahoo" ? c.market : c.source === "csv" ? "CSV" : "Synthetic"} · ${c.symbols.join(", ")}`}>
        <Seg full value={c.source} onChange={(v) => set({ source: v, symbols: v === "csv" ? [] : c.symbols.length ? c.symbols : ["RELIANCE"], market: v === "csv" ? "CUSTOM" : c.market === "CUSTOM" ? "NSE" : c.market })}
          options={[{ value: "yahoo", label: "Markets" }, { value: "csv", label: "My CSV" }, { value: "synthetic", label: "Synthetic" }]} />
        {c.source === "yahoo" && (
          <Field label="Exchange">
            <Select value={c.market} onChange={(v) => set({ market: v, symbols: (meta?.markets.find((m) => m.code === v)?.popular || []).slice(0, 1), cost: { ...c.cost, kind: "" } })}>
              {meta?.markets.filter((m) => m.code !== "CUSTOM").map((m) => (
                <option key={m.code} value={m.code}>{m.code} · {m.name}</option>
              ))}
            </Select>
          </Field>
        )}
        {c.source === "csv" ? (
          <Field label="Datasets" hint={uploads.length ? "Pick one or more uploaded datasets" : "No uploads yet - add CSVs on the Data page"}>
            <div className="link-row">
              {uploads.map((u) => {
                const on = c.symbols.includes(u.name);
                return <button key={u.name} style={on ? { background: "var(--accent-soft)", color: "var(--text)" } : {}}
                  onClick={() => set({ symbols: on ? c.symbols.filter((s) => s !== u.name) : [...c.symbols, u.name] })}>
                  {on ? "✓ " : ""}{u.name}</button>;
              })}
            </div>
          </Field>
        ) : (
          <Field label={<>Symbols {c.symbols.length > 1 && <span className="muted">· portfolio of {c.symbols.length}</span>}</>}>
            <SymbolPicker value={c.symbols} onChange={(symbols) => set({ symbols })} market={c.market} synthetic={c.source === "synthetic"} />
            {c.source === "yahoo" && market && (
              <div className="quick-syms" style={{ marginTop: 2 }}>
                <span>Try</span>
                {market.popular.filter((s) => !c.symbols.includes(s)).slice(0, 5).map((s) => (
                  <button key={s} onClick={() => set({ symbols: [...c.symbols, s] })}>{s}</button>
                ))}
              </div>
            )}
          </Field>
        )}
        <div className="grid2">
          <Field label="Start"><input className="input" type="date" value={c.start} onChange={(e) => set({ start: e.target.value })} /></Field>
          <Field label="End"><input className="input" type="date" value={c.end} onChange={(e) => set({ end: e.target.value })} /></Field>
        </div>
        <div className="link-row" style={{ marginTop: -6 }}>
          {([1, 3, 5, 10, "ytd", "max"] as const).map((y) => (
            <button key={y} onClick={() => preset(y)}>{typeof y === "number" ? `${y}Y` : y === "ytd" ? "YTD" : "Max"}</button>
          ))}
        </div>
        <div className="grid2">
          <Field label="Timeframe" hint={intraday ? `Yahoo keeps ~${intraday} days of ${c.interval} data` : undefined}>
            <Select value={c.interval} onChange={(v) => set({ interval: v })}>
              {(meta?.intervals || ["1d"]).map((i) => <option key={i} value={i}>{i}</option>)}
            </Select>
          </Field>
          <Field label="Benchmark">
            <input className="input" value={c.benchmark} placeholder="auto" onChange={(e) => set({ benchmark: e.target.value })}
              title="'auto' = market index, 'none', or any Yahoo symbol like ^GSPC" />
          </Field>
        </div>
        {c.source === "yahoo" && <Toggle checked={c.adjusted} onChange={(v) => set({ adjusted: v })} label="Adjust for splits & dividends" />}
      </Section>

      <Section title="Strategy" summary={strat?.name}>
        <Select value={c.strategy.id} onChange={(id) => set({ strategy: { id, params: {} } })}>
          {Object.entries(grouped).map(([cat, list]) => (
            <optgroup key={cat} label={cat}>
              {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </optgroup>
          ))}
        </Select>
        {strat && <div className="strategy-desc">{strat.description}</div>}
        {strat?.long_only && c.rules?.direction === "short" && (
          <div className="alert warn" style={{ padding: "9px 11px", fontSize: 12.5 }}>
            This strategy only buys, so it can't trade while Trading rules are set to Short only.
          </div>
        )}
        {strat && !hideParams && Object.keys(strat.params).length > 0 && (
          <ParamForm strat={strat} values={c.strategy.params} onChange={(params) => set({ strategy: { ...c.strategy, params } })} />
        )}
      </Section>

      <Section title="Capital & costs" defaultOpen={false}
        summary={`${money(c.capital, market?.currency || "USD", true)} · ${costKind}`}>
        <Field label="Initial capital">
          <NumberInput value={c.capital} onChange={(capital) => set({ capital })} min={100} suffix={market?.currency} />
        </Field>
        <Field label="Commission model" hint={costKind.startsWith("india") ? "Includes STT, exchange charges, SEBI fee, stamp duty & GST" : undefined}>
          <Select value={c.cost.kind} onChange={(kind) => set({ cost: { ...c.cost, kind } })}>
            <option value="">Auto ({market?.cost_model || "percent"})</option>
            {meta?.cost_models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>
        <div className="grid2">
          {["percent", "india_delivery", "india_intraday"].includes(costKind) && (
            <Field label={costKind === "percent" ? "Rate" : "Brokerage rate"} hint={costKind !== "percent" ? "capped at ₹20/order" : undefined}>
              <NumberInput value={costKind === "india_delivery" && !c.cost.kind ? 0 : c.cost.rate_pct} step={0.01} onChange={(rate_pct) => set({ cost: { ...c.cost, kind: costKind, rate_pct } })} suffix="%" />
            </Field>
          )}
          {["fixed", "percent", "per_share"].includes(costKind) && (
            <Field label="Fixed per order"><NumberInput value={c.cost.fixed} onChange={(fixed) => set({ cost: { ...c.cost, fixed } })} /></Field>
          )}
          {costKind === "per_share" && (
            <Field label="Per share"><NumberInput value={c.cost.per_share} step={0.001} onChange={(per_share) => set({ cost: { ...c.cost, per_share } })} /></Field>
          )}
          <Field label="Slippage"><NumberInput value={c.slippage_pct} step={0.01} onChange={(slippage_pct) => set({ slippage_pct })} suffix="%" /></Field>
        </div>
        <Field label="Order fills">
          <Seg full value={c.fill_on} onChange={(fill_on) => set({ fill_on })}
            options={[{ value: "next_open", label: "Next bar open", title: "Realistic: signal on close, fill next open" }, { value: "close", label: "Same bar close" }]} />
        </Field>
        <div className="grid2">
          <Field label="Risk-free rate"><NumberInput value={c.risk_free_pct} step={0.25} onChange={(risk_free_pct) => set({ risk_free_pct })} suffix="%" /></Field>
          <Field label="Max % of bar volume" hint="0 = unlimited"><NumberInput value={c.max_volume_pct} onChange={(max_volume_pct) => set({ max_volume_pct })} suffix="%" /></Field>
        </div>
      </Section>

      <Section title="Sizing & risk" defaultOpen={false}
        summary={`${c.sizing.mode} ${c.sizing.value}`}>
        <div className="grid2">
          <Field label="Position sizing">
            <Select value={c.sizing.mode} onChange={(mode) => set({ sizing: { mode, value: mode === "percent" ? 100 : mode === "risk" ? 1 : mode === "fixed_qty" ? 10 : 10000 } })}>
              <option value="percent">% of equity</option>
              <option value="risk">Risk % per trade</option>
              <option value="fixed_cash">Fixed cash</option>
              <option value="fixed_qty">Fixed quantity</option>
            </Select>
          </Field>
          <Field label={{ percent: "Allocation", risk: "Risk per trade", fixed_cash: "Cash per trade", fixed_qty: "Units" }[c.sizing.mode] || "Value"}>
            <NumberInput value={c.sizing.value} onChange={(value) => set({ sizing: { ...c.sizing, value } })}
              suffix={c.sizing.mode === "percent" || c.sizing.mode === "risk" ? "%" : undefined} />
          </Field>
        </div>
        <div className="grid3">
          <Field label="Stop loss"><NumberInput value={c.stops.stop_loss_pct} step={0.5} min={0} onChange={(v) => set({ stops: { ...c.stops, stop_loss_pct: v } })} suffix="%" /></Field>
          <Field label="Take profit"><NumberInput value={c.stops.take_profit_pct} step={0.5} min={0} onChange={(v) => set({ stops: { ...c.stops, take_profit_pct: v } })} suffix="%" /></Field>
          <Field label="Trailing"><NumberInput value={c.stops.trailing_pct} step={0.5} min={0} onChange={(v) => set({ stops: { ...c.stops, trailing_pct: v } })} suffix="%" /></Field>
        </div>
        <div className="grid3">
          <Field label="Max bars" hint="time exit"><NumberInput value={c.stops.max_bars} min={0} step={1} onChange={(v) => set({ stops: { ...c.stops, max_bars: v } })} /></Field>
          <Field label="Leverage"><NumberInput value={c.leverage} min={0.1} step={0.5} onChange={(leverage) => set({ leverage })} suffix="×" /></Field>
          <Field label="Pyramiding"><NumberInput value={c.pyramiding} min={1} step={1} onChange={(pyramiding) => set({ pyramiding })} /></Field>
        </div>
        <div className="grid2">
          <Field label="Lot size" hint="e.g. F&O lot"><NumberInput value={c.lot_size} min={0} step={1} onChange={(lot_size) => set({ lot_size })} /></Field>
          <Field label="Quantities">
            <Select value={c.fractional == null ? "auto" : c.fractional ? "yes" : "no"} onChange={(v) => set({ fractional: v === "auto" ? null : v === "yes" })}>
              <option value="auto">Auto ({market?.fractional ? "fractional" : "whole"})</option>
              <option value="no">Whole units</option>
              <option value="yes">Fractional</option>
            </Select>
          </Field>
        </div>
      </Section>
      <RulesSection rules={c.rules || DEFAULT_RULES} currency={market?.currency || "USD"} intraday={!["1d", "1wk", "1mo"].includes(c.interval)}
        strategyLongOnly={!!strat?.long_only}
        onChange={(rules) => set({ rules, allow_short: rules.direction !== "long" })} />
      {footer && <div style={{ padding: "16px 20px 20px", borderTop: "1px solid var(--border)" }}>{footer}</div>}
    </div>
  );
}

function RulesSection({ rules: r, onChange, currency, intraday, strategyLongOnly }: {
  rules: TradingRules; onChange: (r: TradingRules) => void; currency: string; intraday: boolean; strategyLongOnly: boolean;
}) {
  const set = (patch: Partial<TradingRules>) => onChange({ ...r, ...patch });
  const on = activeRules(r);
  const sub = (t: string) => <div className="rule-sub">{t}</div>;
  return (
    <Section title="Trading rules" defaultOpen={false} summary={on.length ? `${on.length} active` : "None"}>
      <div className="hint" style={{ marginTop: -4 }}>
        Constraints applied on top of any strategy, including your own code. Leave a field empty to switch it off.
      </div>

      {sub("Direction")}
      <Seg full value={r.direction} onChange={(direction) => set({ direction })}
        options={[{ value: "long", label: "Long only" }, { value: "both", label: "Both" }, { value: "short", label: "Short only" }]} />
      {r.direction === "short" && (
        <div className="hint" style={{ marginTop: -6, color: strategyLongOnly ? "var(--warn)" : undefined }}>
          {strategyLongOnly ? "The selected strategy only buys, so it won't make any trades in this mode."
            : "Buy signals are ignored unless they cover an open short."}
        </div>
      )}

      {sub("Capital")}
      <Field hint={r.sizing_base === "fixed" ? "Every trade is sized from the initial capital; profits are not reinvested."
        : "Trade size grows with your profits (and shrinks after losses)."}>
        <Seg full value={r.sizing_base} onChange={(sizing_base) => set({ sizing_base })}
          options={[{ value: "compound", label: "Reinvest profits" }, { value: "fixed", label: "Fixed capital" }]} />
      </Field>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Max new capital per day" hint="Total value of positions you may open in one day">
          <div className="input-group">
            <NumberInput value={r.daily_capital_limit} min={0} zeroIsOff onChange={(daily_capital_limit) => set({ daily_capital_limit })} />
            <select className="addon" style={{ cursor: "pointer", appearance: "none", border: "1px solid var(--border)", borderLeft: 0 }}
              value={r.daily_capital_mode} onChange={(e) => set({ daily_capital_mode: e.target.value as TradingRules["daily_capital_mode"] })}>
              <option value="amount">{currency}</option>
              <option value="pct">% of equity</option>
            </select>
          </div>
        </Field>
        <Field label="Max position size" hint="Per symbol, as % of equity">
          <NumberInput value={r.max_position_pct} min={0} step={5} zeroIsOff suffix="%" onChange={(max_position_pct) => set({ max_position_pct })} />
        </Field>
      </div>

      {sub("Daily session")}
      <Toggle checked={r.square_off} onChange={(square_off) => set({ square_off })} label="Square off at the end of each day" />
      {r.square_off && !intraday && <div className="hint" style={{ marginTop: -6 }}>On daily bars: enter at the open, exit at that day's close.</div>}
      {intraday && r.square_off && (
        <Field label="Square-off time" hint="Empty = the last bar of each day">
          <input className="input" type="time" value={r.square_off_time} onChange={(e) => set({ square_off_time: e.target.value })} />
        </Field>
      )}
      {intraday && (
        <div className="grid2">
          <Field label="New entries from"><input className="input" type="time" value={r.entry_start} onChange={(e) => set({ entry_start: e.target.value })} /></Field>
          <Field label="New entries until"><input className="input" type="time" value={r.entry_end} onChange={(e) => set({ entry_end: e.target.value })} /></Field>
        </div>
      )}
      <div className="grid2">
        <Field label="Max trades per day"><NumberInput value={r.max_trades_per_day} min={0} step={1} zeroIsOff onChange={(max_trades_per_day) => set({ max_trades_per_day })} /></Field>
        <Field label="Max open positions"><NumberInput value={r.max_open_positions} min={0} step={1} zeroIsOff onChange={(max_open_positions) => set({ max_open_positions })} /></Field>
      </div>

      {sub("Stops")}
      <div className="grid2">
        <Field label="Daily loss limit" hint="Flatten, pause till tomorrow">
          <NumberInput value={r.daily_loss_limit_pct} min={0} step={0.5} zeroIsOff suffix="%" onChange={(daily_loss_limit_pct) => set({ daily_loss_limit_pct })} />
        </Field>
        <Field label="Daily profit target" hint="Lock in, pause till tomorrow">
          <NumberInput value={r.daily_profit_target_pct} min={0} step={0.5} zeroIsOff suffix="%" onChange={(daily_profit_target_pct) => set({ daily_profit_target_pct })} />
        </Field>
        <Field label="Drawdown kill switch" hint="Stop trading for good">
          <NumberInput value={r.max_drawdown_stop_pct} min={0} step={1} zeroIsOff suffix="%" onChange={(max_drawdown_stop_pct) => set({ max_drawdown_stop_pct })} />
        </Field>
        <Field label="Cooldown after exit" hint="Bars before re-entering">
          <NumberInput value={r.cooldown_bars} min={0} step={1} zeroIsOff suffix="bars" onChange={(cooldown_bars) => set({ cooldown_bars })} />
        </Field>
      </div>
      {on.length > 0 && (
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start", marginLeft: -10 }}
          onClick={() => onChange({ ...DEFAULT_RULES, direction: r.direction })}>Reset rules</button>
      )}
    </Section>
  );
}

export function ParamForm({ strat, values, onChange }: { strat: StrategyInfo; values: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  return (
    <div className="grid2">
      {Object.entries(strat.params).map(([k, spec]) => {
        const v = values[k] ?? spec.default;
        const label = k.replace(/_/g, " ");
        if (spec.type === "bool") {
          return <div key={k} className="field" style={{ justifyContent: "flex-end" }}>
            <Toggle checked={!!v} onChange={(b) => onChange({ ...values, [k]: b })} label={label} />
          </div>;
        }
        if (spec.type === "str") {
          return <Field key={k} label={label}><input className="input" value={v} onChange={(e) => onChange({ ...values, [k]: e.target.value })} /></Field>;
        }
        return (
          <Field key={k} label={label}>
            <NumberInput value={v} step={spec.step ?? (spec.type === "int" ? 1 : 0.1)} onChange={(n) => onChange({ ...values, [k]: n })} />
          </Field>
        );
      })}
    </div>
  );
}

function SymbolPicker({ value, onChange, market, synthetic }: { value: string[]; onChange: (v: string[]) => void; market: string; synthetic: boolean }) {
  const [q, setQ] = useState("");
  const [sugs, setSugs] = useState<{ symbol: string; name: string; exchange: string }[]>([]);
  const [hl, setHl] = useState(0);
  const [open, setOpen] = useState(false);
  const timer = useRef<number>();
  const seq = useRef(0); // id of the latest search; older responses are ignored

  useEffect(() => {
    const id = ++seq.current;
    window.clearTimeout(timer.current);
    if (synthetic || q.trim().length < 2) { setSugs([]); return; }
    timer.current = window.setTimeout(() => {
      api.search(q).then((r) => {
        if (id !== seq.current) return; // a newer query is in flight or the input was cleared
        // Listings on the selected exchange first (e.g. INFY.NS before the NYSE ADR when on NSE).
        const sfx = SUFFIX[market];
        const rank = (sym: string) => (sfx ? (sym.toUpperCase().endsWith(sfx) ? 0 : 1) : (sym.includes(".") ? 1 : 0));
        setSugs([...r].sort((a, b) => rank(a.symbol) - rank(b.symbol)).slice(0, 10));
        setHl(0);
      }).catch(() => { if (id === seq.current) setSugs([]); });
    }, 280);
  }, [q, synthetic, market]);

  const add = (s: string) => {
    const sym = s.trim().toUpperCase();
    if (sym && !value.includes(sym)) onChange([...value, sym]);
    seq.current++;
    setQ(""); setSugs([]);
  };

  return (
    <div className="chips" onBlur={() => setTimeout(() => setOpen(false), 150)}>
      {value.map((s) => (
        <span key={s} className="chip">{s}<button onClick={() => onChange(value.filter((x) => x !== s))} aria-label={`Remove ${s}`}><X size={12} /></button></span>
      ))}
      <input value={q} placeholder={value.length ? "Add…" : synthetic ? "Any name, e.g. ALPHA" : `Search ${market} symbols…`}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            if (sugs[hl] && open) add(stripSuffix(sugs[hl].symbol, market)); else add(q);
          } else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
          else if (e.key === "ArrowDown") setHl((h) => Math.min(h + 1, sugs.length - 1));
          else if (e.key === "ArrowUp") setHl((h) => Math.max(h - 1, 0));
        }} />
      {q && <button className="btn btn-sm btn-ghost btn-icon" onClick={() => add(q)} title="Add"><Plus size={14} /></button>}
      {open && sugs.length > 0 && (
        <div className="suggest">
          {sugs.map((s, i) => (
            <div key={s.symbol} className={`suggest-item ${i === hl ? "hl" : ""}`} onMouseDown={() => add(stripSuffix(s.symbol, market))}>
              <span className="sym">{s.symbol}</span><span className="nm">{s.name}</span><span className="pill">{s.exchange}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SUFFIX: Record<string, string> = { NSE: ".NS", BSE: ".BO", LSE: ".L", XETRA: ".DE", EURONEXT: ".PA", TSE: ".T", HKEX: ".HK", TSX: ".TO", ASX: ".AX" };

// "RELIANCE.NS" picked while on NSE -> "RELIANCE" (the backend re-applies the suffix).
function stripSuffix(sym: string, market: string) {
  const s = SUFFIX[market];
  return s && sym.toUpperCase().endsWith(s) ? sym.slice(0, -s.length) : sym;
}

