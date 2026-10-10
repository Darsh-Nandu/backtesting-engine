import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { AlertCircle, CheckCircle2, FilePlus2, GitFork, Play, Save, Trash2 } from "lucide-react";
import { api, ApiError, StrategyInfo } from "../api";
import { Card, Spinner } from "../components/ui";
import { useApp } from "../store";

export function LabPage() {
  const { meta, strategies, reloadStrategies, setConfig, config, setResult, go, toast, theme } = useApp();
  const [code, setCode] = useState<string>(() => {
    try { return localStorage.getItem("qf.labcode") || ""; } catch { return ""; }
  });
  const [name, setName] = useState("My RSI Trend Strategy");
  const [status, setStatus] = useState<{ ok: boolean; msg: string; info?: StrategyInfo; line?: number | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { if (!code && meta) setCode(meta.template); }, [meta, code]);
  useEffect(() => { try { localStorage.setItem("qf.labcode", code); } catch { /* ignore */ } }, [code]);

  const custom = strategies.filter((s) => s.id.startsWith("custom:"));
  const builtins = strategies.filter((s) => !s.id.startsWith("custom:") && s.source);
  const extensions = useMemo(() => [python()], []);

  const validate = async () => {
    setBusy("validate");
    try {
      const info = await api.validate(code);
      setStatus({ ok: true, msg: `Valid strategy “${info.name}” with ${Object.keys(info.params).length} parameters`, info });
      return info;
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message, line: e instanceof ApiError ? e.line : null });
      return null;
    } finally { setBusy(null); }
  };

  const save = async () => {
    const info = await validate();
    if (!info) return null;
    setBusy("save");
    try {
      const saved = await api.saveStrategy(name || info.name, code);
      await reloadStrategies();
      toast(`Saved “${name || info.name}” to My strategies`);
      return saved.id;
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message }); return null;
    } finally { setBusy(null); }
  };

  const saveAndRun = async () => {
    const id = await save();
    if (!id) return;
    setBusy("run");
    const next = { ...config, strategy: { id, params: {} } };
    setConfig(() => next);
    try {
      const r = await api.backtest(next);
      setResult(r);
      go("backtest");
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message, line: e instanceof ApiError ? e.line : null });
    } finally { setBusy(null); }
  };

  const load = (s: StrategyInfo, fork = false) => {
    if (!s.source) return;
    setCode(s.source);
    setName(fork ? `${s.name} (fork)` : s.name);
    setStatus(null);
  };

  return (
    <div className="lab-layout">
      <div className="stack" style={{ minWidth: 0 }}>
        <Card title="Strategy editor" sub="Python · subclass Strategy, implement init() and next()"
          actions={<>
            <input className="input" style={{ width: 230, height: 30 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Strategy name" />
            <button className="btn btn-sm" onClick={() => { setCode(meta?.template || ""); setName("My strategy"); setStatus(null); }}><FilePlus2 size={14} />New</button>
          </>}>
          <div className="code-wrap">
            <CodeMirror value={code} height="560px" theme={theme === "dark" ? "dark" : "light"} extensions={extensions}
              onChange={setCode} basicSetup={{ foldGutter: true, highlightActiveLine: true, tabSize: 4 }} />
          </div>
          {status && (
            <div className={`alert ${status.ok ? "info" : "err"}`} style={{ marginTop: 12 }}>
              {status.ok ? <CheckCircle2 size={16} style={{ flex: "none" }} /> : <AlertCircle size={16} style={{ flex: "none" }} />}
              <div style={{ minWidth: 0 }}>
                <b>{status.ok ? "Looks good" : `Error${status.line ? ` on line ${status.line}` : ""}`}</b>
                <pre>{status.msg}</pre>
                {status.info && Object.keys(status.info.params).length > 0 && (
                  <div className="row" style={{ flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                    {Object.entries(status.info.params).map(([k, v]) => <span key={k} className="pill">{k} = {String(v.default)}</span>)}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <button className="btn" onClick={validate} disabled={!!busy}>{busy === "validate" ? <Spinner /> : <CheckCircle2 size={15} />}Validate</button>
            <button className="btn" onClick={save} disabled={!!busy}>{busy === "save" ? <Spinner /> : <Save size={15} />}Save</button>
            <button className="btn btn-primary" onClick={saveAndRun} disabled={!!busy}>{busy === "run" ? <Spinner /> : <Play size={15} fill="currentColor" />}Save & backtest</button>
          </div>
        </Card>
      </div>
      <div className="stack" style={{ minWidth: 0 }}>
        <Card title="My strategies" sub={custom.length ? `${custom.length} saved` : "Saved strategies appear here and in the strategy picker"}>
          {custom.length === 0 && <span className="muted">Nothing saved yet.</span>}
          {custom.map((s) => (
            <div key={s.id} className="metric-row" style={{ alignItems: "center" }}>
              <span style={{ minWidth: 0 }}><b>{s.name}</b>{s.broken && <span className="pill neg" style={{ marginLeft: 6 }}>error</span>}</span>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn btn-sm" onClick={() => load(s)}>Edit</button>
                <button className="btn btn-sm btn-icon btn-danger" title="Delete" onClick={async () => {
                  if (!confirm(`Delete “${s.name}”?`)) return;
                  await api.deleteStrategy(s.id.split(":")[1]); await reloadStrategies(); toast("Strategy deleted", "info");
                }}><Trash2 size={13} /></button>
              </span>
            </div>
          ))}
        </Card>
        <Card title="Fork a built-in" sub="Start from a proven template">
          <div className="quick-syms">
            {builtins.map((s) => <button key={s.id} onClick={() => load(s, true)}><GitFork size={10} /> {s.name}</button>)}
          </div>
        </Card>
        <Card title="API reference">
          <div className="doc">
            <h4>Data (inside next)</h4>
            <ul>
              <li><code>self.data.close[-1]</code> latest close, <code>[-2]</code> previous bar. Also <code>open high low volume</code></li>
              <li><code>self.data.df</code> pandas frame up to now · <code>self.data.time</code> current timestamp</li>
              <li><code>self.datas[symbol]</code> other symbols (portfolio strategies set <code>per_asset = False</code>)</li>
            </ul>
            <h4>Indicators (in init)</h4>
            <ul>
              <li><code>self.I(func, *args, name=, overlay=)</code> → line; plotted automatically</li>
              <li>Available: {meta?.indicators.filter((i) => !["crossover", "crossunder"].includes(i)).map((i) => <code key={i} style={{ marginRight: 3 }}>{i}</code>)}</li>
              <li><code>crossover(a, b)</code> / <code>crossunder(a, b)</code> for signals</li>
            </ul>
            <h4>Orders</h4>
            <ul>
              <li><code>self.buy(size=None, sl=, tp=, trail=, limit=, stop=)</code> go/add long</li>
              <li><code>self.sell(...)</code> exit long; open short if shorting enabled</li>
              <li><code>self.close()</code> · <code>self.order_target_percent(0.5)</code> · <code>self.set_stops(sl=, tp=)</code></li>
              <li><code>size</code>: None = sizing rule, 0-1 = fraction of equity, &gt;1 = units</li>
            </ul>
            <h4>State</h4>
            <ul>
              <li><code>self.position.is_long / is_short / qty / pnl_pct / bars_held</code></li>
              <li><code>self.equity</code>, <code>self.cash</code>, <code>self.p.&lt;param&gt;</code>, <code>self.log("msg")</code></li>
            </ul>
            <h4>Trading rules</h4>
            <ul>
              <li>Rules from the backtest settings (long/short only, daily square-off, capital limits, daily stops…) are enforced automatically. No code is needed.</li>
            </ul>
            <p className="muted" style={{ marginTop: 12 }}>Imports are limited to numerical modules (numpy, pandas, math, statistics…). Code runs locally on your machine.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
