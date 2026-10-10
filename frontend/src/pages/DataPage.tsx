import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, UTCTimestamp } from "lightweight-charts";
import { AlertCircle, FileUp, Search, Trash2, Upload } from "lucide-react";
import { api } from "../api";
import { Card, Field, Select, Spinner } from "../components/ui";
import { compact, date, money, num, pct, tone } from "../format";
import { useApp, usePalette } from "../store";

export function DataPage() {
  const { meta, toast, setConfig, go } = useApp();
  const [market, setMarket] = useState("NSE");
  const [symbol, setSymbol] = useState("RELIANCE");
  const [interval, setInterval] = useState("1d");
  const [start, setStart] = useState("2015-01-01");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<any[]>([]);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshUploads = () => api.uploads().then(setUploads).catch(() => {});
  useEffect(() => { refreshUploads(); }, []);

  const explore = async (src = "yahoo", sym = symbol, mkt = market) => {
    setLoading(true); setError(null);
    try {
      setData(await api.preview({ symbol: sym, market: mkt, source: src, interval, start }));
    } catch (e: any) { setError(e.message); setData(null); } finally { setLoading(false); }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const info = await api.upload(f);
        toast(`Uploaded ${info.name} · ${info.rows} rows`);
      } catch (e: any) { toast(`${f.name}: ${e.message}`, "err"); }
    }
    refreshUploads();
  };

  const s = data?.stats;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Market data explorer" sub="Inspect any instrument before you backtest it">
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ width: 230 }}><Field label="Market">
            <Select value={market} onChange={setMarket}>
              {meta?.markets.filter((m) => m.code !== "CUSTOM").map((m) => <option key={m.code} value={m.code}>{m.code} - {m.name}</option>)}
            </Select></Field></div>
          <div style={{ width: 180 }}><Field label="Symbol"><input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && explore()} /></Field></div>
          <div style={{ width: 110 }}><Field label="Interval"><Select value={interval} onChange={setInterval}>
            {meta?.intervals.map((i) => <option key={i}>{i}</option>)}</Select></Field></div>
          <div style={{ width: 160 }}><Field label="From"><input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field></div>
          <button className="btn btn-primary" onClick={() => explore()} disabled={loading}>{loading ? <Spinner /> : <Search size={15} />}Load</button>
          {s && <button className="btn" onClick={() => { setConfig((c) => ({ ...c, source: "yahoo", market, symbols: [symbol], interval, start })); go("backtest"); }}>Backtest this →</button>}
        </div>
        <div className="quick-syms" style={{ marginTop: 10 }}>
          {meta?.markets.find((m) => m.code === market)?.popular.slice(0, 14).map((p) => (
            <button key={p} onClick={() => { setSymbol(p); explore("yahoo", p); }}>{p}</button>
          ))}
        </div>
      </Card>
      {error && <div className="alert err"><AlertCircle size={16} /><div>{error}</div></div>}
      {s && (
        <>
          <div className="kpis">
            {[
              { k: "Last price", v: money(s.last, s.currency), c: "" },
              { k: "Period return", v: pct(s.return_pct), c: tone(s.return_pct) },
              { k: "CAGR", v: pct(s.cagr_pct), c: tone(s.cagr_pct) },
              { k: "Volatility (ann.)", v: pct(s.volatility_pct, 1, false), c: "" },
              { k: "Max drawdown", v: pct(s.max_drawdown_pct), c: "" },
              { k: "Bars", v: num(s.rows, 0), c: "", sub: `${date(s.start)} → ${date(s.end)}` },
            ].map((t) => <div key={t.k} className="kpi"><div className="kpi-label">{t.k}</div><div className={`kpi-value num ${t.c}`}>{t.v}</div>{t.sub && <div className="kpi-sub">{t.sub}</div>}</div>)}
          </div>
          <Card title={s.symbol} sub={`Avg volume ${compact(s.avg_volume)} · range ${num(s.low)} - ${num(s.high)}${s.missing_volume_pct > 5 ? ` · ${s.missing_volume_pct}% bars without volume` : ""}`}>
            <MiniCandles d={data} />
          </Card>
        </>
      )}
      <div className="charts-2">
        <Card title="Upload your own data" sub="CSV with date + OHLC (+ volume) columns. Column names are detected automatically.">
          <div className={`drop ${over ? "over" : ""}`} onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}>
            <FileUp size={28} style={{ marginBottom: 8 }} />
            <div><b>Drop CSV files here</b> or click to browse</div>
            <div className="hint" style={{ marginTop: 6 }}>Works with NSE/BSE bhavcopy-style exports, TradingView, MetaTrader, Binance, Yahoo… up to 100 MB</div>
            <input ref={fileRef} type="file" accept=".csv,.txt" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </div>
        </Card>
        <Card title="Uploaded datasets" sub={`${uploads.length} stored locally in data_store/uploads`} bodyClass="table-wrap">
          {uploads.length === 0 ? <div className="empty" style={{ padding: 40 }}><Upload size={22} /><p style={{ marginTop: 8 }}>No datasets yet</p></div> : (
            <table className="tbl">
              <thead><tr><th>Name</th><th className="r">Rows</th><th>From</th><th>To</th><th className="r">Last</th><th /></tr></thead>
              <tbody>{uploads.map((u) => (
                <tr key={u.name}>
                  <td><b>{u.name}</b></td><td className="r">{num(u.rows, 0)}</td><td>{date(u.start)}</td><td>{date(u.end)}</td><td className="r">{num(u.last_close)}</td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => explore("csv", u.name, "CUSTOM")}>View</button>{" "}
                    <button className="btn btn-sm" onClick={() => { setConfig((c) => ({ ...c, source: "csv", market: "CUSTOM", symbols: [u.name], start: u.start.slice(0, 10), end: u.end.slice(0, 10) })); go("backtest"); }}>Backtest</button>{" "}
                    <button className="btn btn-sm btn-icon btn-danger" onClick={async () => { if (confirm(`Delete ${u.name}?`)) { await api.deleteUpload(u.name); refreshUploads(); } }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="Supported markets" bodyClass="table-wrap">
        <table className="tbl">
          <thead><tr><th>Code</th><th>Exchange</th><th>Country</th><th>Currency</th><th>Ticker format</th><th>Benchmark</th><th>Default costs</th></tr></thead>
          <tbody>{meta?.markets.map((m) => (
            <tr key={m.code}><td><b>{m.code}</b></td><td>{m.name}</td><td className="dim">{m.country}</td><td>{m.currency}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>{m.popular[0] ? `${m.popular[0]} → ${m.popular[0]}${m.suffix}` : "-"}</td>
              <td>{m.benchmark || "-"}</td><td className="dim">{m.cost_model}</td></tr>
          ))}</tbody>
        </table>
      </Card>
    </div>
  );
}

function MiniCandles({ d }: { d: any }) {
  const el = useRef<HTMLDivElement>(null);
  const p = usePalette();
  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: p.muted, fontSize: 11, fontFamily: "IBM Plex Sans, system-ui, sans-serif", attributionLogo: false },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.grid }, timeScale: { borderColor: p.grid, minBarSpacing: 0.05 },
    });
    const c = chart.addSeries(CandlestickSeries, { upColor: p.pos, downColor: p.neg, borderVisible: false, wickUpColor: p.pos, wickDownColor: p.neg });
    const rows: any[] = [], vols: any[] = [];
    d.t.forEach((t: number, i: number) => {
      if (d.close[i] == null) return;
      rows.push({ time: t as UTCTimestamp, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] });
      vols.push({ time: t as UTCTimestamp, value: d.volume[i] ?? 0, color: (d.close[i] >= d.open[i] ? p.pos : p.neg) + "55" });
    });
    c.setData(rows);
    const v = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "v", lastValueVisible: false, priceLineVisible: false });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    v.setData(vols);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [d, p]);
  return <div ref={el} style={{ height: 440 }} />;
}
