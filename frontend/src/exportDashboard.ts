// Export a backtest as a single self-contained HTML dashboard (Chart.js, embedded JSON).
// The file opens offline-ready in any browser and can be shared as an attachment.
import { BacktestResult } from "./api";

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

function payload(res: BacktestResult) {
  const s = res.series;
  const n = s.t.length;
  const step = Math.max(1, Math.ceil(n / 500)); // <=500 points per series
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return {
    meta: {
      strategy: res.name && res.name !== res.strategy.name ? res.name : res.strategy.name,
      market: res.market.code, currency: res.currency, symbols: Object.keys(res.symbols), interval: res.request.interval,
      start: res.metrics.start?.slice(0, 10), end: res.metrics.end?.slice(0, 10), benchmark: res.benchmark_name,
      params: res.strategy.params, rules: res.rules_active || [], generated: new Date().toISOString().slice(0, 16).replace("T", " "),
      capital: res.metrics.initial_capital, ppy: (res as any).config?.periods_per_year || 252,
    },
    // Charts use <=500 points per series; KPIs use the full-resolution curve so drawdowns are exact.
    series: idx.map((i) => [day(s.t[i]), s.equity[i], s.benchmark ? s.benchmark[i] : null, s.exposure[i]]),
    full: s.t.map((t, i) => [day(t), Math.round(s.equity[i] * 100) / 100, s.benchmark ? Math.round((s.benchmark[i] ?? 0) * 100) / 100 : null]),
    yearly: res.yearly,
    trades: res.trades.map((t) => [t.id, t.symbol, t.side, day(t.entry_time), day(t.exit_time), t.entry_price, t.exit_price,
      t.qty, Math.round(t.pnl * 100) / 100, Math.round(t.return_pct * 100) / 100, t.bars_held, t.exit_reason, Math.round(t.fees * 100) / 100]),
  };
}

export function buildDashboardHTML(res: BacktestResult): string {
  const data = JSON.stringify(payload(res)).replace(/</g, "\\u003c");
  const title = `${res.strategy.name} · ${Object.keys(res.symbols).slice(0, 3).join(", ")} - QuantForge backtest`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.replace(/</g, "&lt;")}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1" integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0" integrity="sha384-cVMg8E3QFwTvGCDuK+ET4PD341jF3W8nO1auiXfuZNQkzbUUiBGLsIQUE+b1mxws" crossorigin="anonymous"></script>
<style>
:root{--bg:#f3f5f9;--card:#fff;--header:#0d1b3a;--text:#0b1220;--text2:#3b4a63;--muted:#5f6c84;--line:#e3e7ef;
--c1:#1f5eff;--bench:#8a94a8;--pos:#047857;--neg:#c81e1e;--posmark:#16a34a;--negmark:#dc2626;--gap:16px;--radius:10px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;font-size:15px}
.wrap{max-width:1440px;margin:0 auto;padding:var(--gap)}
header{background:var(--header);color:#fff;padding:20px 24px;border-radius:var(--radius);margin-bottom:var(--gap);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px}
header h1{font-size:22px;font-weight:700;letter-spacing:-.01em}
header .sub{font-size:13.5px;color:rgba(255,255,255,.72);margin-top:3px}
.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.fg{display:flex;flex-direction:column;gap:4px}
.fg label{font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.65)}
.fg select{padding:8px 12px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:rgba(255,255,255,.1);color:#fff;font-size:14px;font-weight:600;min-width:130px}
.fg select option{background:var(--header);color:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--gap);margin-bottom:var(--gap)}
.card{background:var(--card);border-radius:var(--radius);box-shadow:0 1px 2px rgba(16,24,40,.05),0 2px 8px rgba(16,24,40,.06);border:1px solid var(--line)}
.kpi{padding:18px 22px}
.kpi .l{font-size:12.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.kpi .v{font-size:30px;font-weight:800;margin:4px 0 2px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi .c{font-size:13.5px;font-weight:600;color:var(--muted)}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12.5px;font-weight:700;margin-right:6px}
.chip.pos{background:rgba(22,163,74,.12)}.chip.neg{background:rgba(220,38,38,.1)}
.row{display:grid;grid-template-columns:2fr 1fr;gap:var(--gap);margin-bottom:var(--gap)}
.chart{padding:18px 22px}
.chart h3{font-size:15.5px;font-weight:700;margin-bottom:12px}
.chart .box{position:relative;height:300px}
.chart .box.sm{height:150px}
.table{padding:18px 22px;overflow-x:auto}
.table .top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;gap:10px;flex-wrap:wrap}
.table h3{font-size:15.5px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th{text-align:left;padding:10px 12px;border-bottom:2px solid var(--line);color:var(--muted);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;cursor:pointer;user-select:none}
th:hover{color:var(--text)} th.r,td.r{text-align:right}
td{padding:9px 12px;border-bottom:1px solid #eef1f6;white-space:nowrap}
tbody tr:hover{background:#f7f9fc}
.pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:12px;font-size:13.5px;color:var(--muted)}
.pager button{padding:6px 12px;border:1px solid var(--line);background:#fff;border-radius:6px;font-weight:600;cursor:pointer}
.pager button:disabled{opacity:.4;cursor:default}
footer{color:var(--muted);font-size:13px;padding:6px 4px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
@media(max-width:900px){.row{grid-template-columns:1fr}header{flex-direction:column;align-items:flex-start}}
@media print{body{background:#fff}.filters,.pager{display:none}.card{box-shadow:none;break-inside:avoid}header{background:#fff;color:#000;border:1px solid var(--line)}header .sub{color:#555}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div><h1 id="title"></h1><div class="sub" id="subtitle"></div></div>
    <div class="filters">
      <div class="fg"><label for="f-period">Period</label><select id="f-period"><option value="ALL">Full period</option><option value="5">Last 5 years</option><option value="3">Last 3 years</option><option value="1">Last 12 months</option></select></div>
      <div class="fg"><label for="f-symbol">Symbol</label><select id="f-symbol"><option value="all">All symbols</option></select></div>
      <div class="fg"><label for="f-side">Side</label><select id="f-side"><option value="all">Long &amp; short</option><option value="Long">Long</option><option value="Short">Short</option></select></div>
    </div>
  </header>

  <section class="kpis">
    <div class="card kpi"><div class="l">Total return</div><div class="v" id="k-ret"></div><div class="c" id="k-ret-c"></div></div>
    <div class="card kpi"><div class="l">CAGR</div><div class="v" id="k-cagr"></div><div class="c" id="k-cagr-c"></div></div>
    <div class="card kpi"><div class="l">Max drawdown</div><div class="v" id="k-dd"></div><div class="c" id="k-dd-c"></div></div>
    <div class="card kpi"><div class="l">Win rate</div><div class="v" id="k-win"></div><div class="c" id="k-win-c"></div></div>
  </section>

  <section class="row">
    <div class="card chart"><h3>Equity vs benchmark</h3><div class="box"><canvas id="c-equity"></canvas></div><div class="box sm" style="margin-top:10px"><canvas id="c-dd"></canvas></div></div>
    <div class="card chart"><h3>Annual returns</h3><div class="box" style="height:300px"><canvas id="c-years"></canvas></div><h3 style="margin-top:14px">Exit reasons</h3><div class="box sm"><canvas id="c-exits"></canvas></div></div>
  </section>

  <section class="card table">
    <div class="top"><h3>Trades</h3><span id="t-count" style="color:var(--muted);font-size:13.5px"></span></div>
    <div id="t-body"></div>
    <div class="pager"><span id="t-page"></span><button id="t-prev">Previous</button><button id="t-next">Next</button></div>
  </section>

  <footer><span>Data as of: <span id="data-date"></span> · generated <span id="gen"></span> by QuantForge</span><span>Past performance does not guarantee future results.</span></footer>
</div>
<script>
const DATA = ${data};
const COLS = [["id","#"],["sym","Symbol"],["side","Side"],["entry","Entry"],["exit","Exit"],["ep","Entry px","r"],["xp","Exit px","r"],["qty","Qty","r"],["pnl","P&L","r"],["ret","Return","r"],["bars","Bars","r"],["why","Exit"]];
const M = DATA.meta, cur = M.currency;
const money = v => { try { return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", {style:"currency",currency:cur,maximumFractionDigits:0}).format(v); } catch(e) { return v.toFixed(0); } };
const pct = (v, d = 2, sign = true) => v == null || !isFinite(v) ? "-" : (sign && v > 0 ? "+" : "") + v.toFixed(d) + "%";
const num = (v, d = 2) => v == null || !isFinite(v) ? "-" : v.toLocaleString(undefined, {minimumFractionDigits:d, maximumFractionDigits:d});
const tone = v => v > 0 ? "pos" : v < 0 ? "neg" : "";

class Dashboard {
  constructor(data) {
    this.trades = data.trades.map(r => ({id:r[0],sym:r[1],side:r[2],entry:r[3],exit:r[4],ep:r[5],xp:r[6],qty:r[7],pnl:r[8],ret:r[9],bars:r[10],why:r[11],fee:r[12]}));
    this.series = data.series; this.full = data.full; this.charts = {}; this.sort = {col:"exit", dir:"desc"}; this.page = 0; this.pageSize = 25;
    document.getElementById("title").textContent = M.strategy;
    document.getElementById("subtitle").textContent = [M.market, M.symbols.join(", "), M.start + " to " + M.end, M.interval,
      Object.entries(M.params).map(([k, v]) => k.replace(/_/g, " ") + " " + v).join(", "), ...M.rules].filter(Boolean).join(" · ");
    document.getElementById("data-date").textContent = M.end; document.getElementById("gen").textContent = M.generated;
    const sel = document.getElementById("f-symbol");
    M.symbols.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s; sel.appendChild(o); });
    ["f-period","f-symbol","f-side"].forEach(id => document.getElementById(id).addEventListener("change", () => { this.page = 0; this.apply(); }));
    document.getElementById("t-prev").onclick = () => { this.page--; this.renderTable(); };
    document.getElementById("t-next").onclick = () => { this.page++; this.renderTable(); };
    this.apply();
  }
  apply() {
    const p = document.getElementById("f-period").value, sym = document.getElementById("f-symbol").value, side = document.getElementById("f-side").value;
    const last = this.series[this.series.length - 1][0];
    const from = p === "ALL" ? null : new Date(new Date(last).getTime() - (+p) * 365.25 * 864e5).toISOString().slice(0, 10);
    this.view = from ? this.series.filter(r => r[0] >= from) : this.series;
    this.fullView = from ? this.full.filter(r => r[0] >= from) : this.full;
    this.filtered = this.trades.filter(t => (!from || t.exit >= from) && (sym === "all" || t.sym === sym) && (side === "all" || t.side === side));
    this.from = from; this.renderKPIs(); this.renderCharts(); this.renderTable();
  }
  renderKPIs() {
    const v = this.fullView, e0 = v[0][1], e1 = v[v.length - 1][1];
    const yrs = Math.max((new Date(v[v.length - 1][0]) - new Date(v[0][0])) / (365.25 * 864e5), 1 / 365);
    const ret = (e1 / e0 - 1) * 100, cagr = (Math.pow(e1 / e0, 1 / yrs) - 1) * 100;
    const b0 = v[0][2], b1 = v[v.length - 1][2], bret = b0 ? (b1 / b0 - 1) * 100 : null;
    let peak = -Infinity, dd = 0; v.forEach(r => { peak = Math.max(peak, r[1]); dd = Math.min(dd, r[1] / peak - 1); });
    const t = this.filtered, wins = t.filter(x => x.pnl > 0), gp = wins.reduce((s, x) => s + x.pnl, 0), gl = -t.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
    const set = (id, txt, cls) => { const el = document.getElementById(id); el.innerHTML = txt; el.className = el.className.split(" ")[0] + (cls ? " " + cls : ""); };
    set("k-ret", pct(ret), tone(ret));
    set("k-ret-c", bret == null ? money(e1 - e0) + " net profit" : '<span class="chip ' + tone(ret - bret) + '">' + pct(ret - bret, 1) + "</span>vs " + (M.benchmark || "benchmark") + " " + pct(bret, 1));
    set("k-cagr", pct(cagr), tone(cagr)); set("k-cagr-c", num(yrs, 1) + " years · " + money(e1) + " final equity");
    set("k-dd", pct(dd * 100), dd < 0 ? "neg" : ""); set("k-dd-c", "Peak-to-trough on the equity curve");
    set("k-win", t.length ? pct(wins.length / t.length * 100, 1, false) : "-"); set("k-win-c", t.length + " trades · profit factor " + (gl > 0 ? num(gp / gl) : "-"));
  }
  renderCharts() {
    const v = this.view, labels = v.map(r => r[0]);
    let peak = -Infinity; const dd = v.map(r => { peak = Math.max(peak, r[1]); return +((r[1] / peak - 1) * 100).toFixed(2); });
    const base = {responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:"index", intersect:false},
      plugins:{legend:{position:"top", align:"end", labels:{usePointStyle:true, boxWidth:8, font:{size:13, weight:"600"}}}},
      scales:{x:{grid:{display:false}, ticks:{maxTicksLimit:8, font:{size:12}}}, y:{grid:{color:"#eef1f6"}, ticks:{font:{size:12}}}}};
    const eqSets = [{label:"Strategy", data:v.map(r => r[1]), borderColor:"#1f5eff", backgroundColor:"rgba(31,94,255,.08)", fill:true, borderWidth:2.2, pointRadius:0, tension:.15}];
    if (v[0][2] != null) eqSets.push({label:M.benchmark || "Benchmark", data:v.map(r => r[2]), borderColor:"#8a94a8", borderDash:[5,4], borderWidth:1.8, pointRadius:0, fill:false});
    this.upsert("equity", "line", {labels, datasets:eqSets}, {...base, plugins:{...base.plugins, tooltip:{callbacks:{label:c => c.dataset.label + ": " + money(c.parsed.y)}}},
      scales:{...base.scales, y:{...base.scales.y, ticks:{font:{size:12}, callback:x => money(x)}}}});
    this.upsert("dd", "line", {labels, datasets:[{label:"Drawdown %", data:dd, borderColor:"#dc2626", backgroundColor:"rgba(220,38,38,.12)", fill:true, borderWidth:1.6, pointRadius:0}]},
      {...base, plugins:{legend:{display:false}, tooltip:{callbacks:{label:c => "Drawdown: " + c.parsed.y.toFixed(2) + "%"}}}, scales:{x:{display:false}, y:{grid:{color:"#eef1f6"}, max:0, ticks:{font:{size:12}, callback:x => x + "%"}}}});
    const yrs = DATA.yearly.filter(y => !this.from || y.year >= +this.from.slice(0, 4));
    const ySets = [{label:"Strategy", data:yrs.map(y => y.ret), backgroundColor:"#1f5effd9", borderRadius:4}];
    if (yrs.some(y => y.bench != null)) ySets.push({label:M.benchmark || "Benchmark", data:yrs.map(y => y.bench), backgroundColor:"#8a94a899", borderRadius:4});
    this.upsert("years", "bar", {labels:yrs.map(y => String(y.year)), datasets:ySets}, {...base, plugins:{...base.plugins, tooltip:{callbacks:{label:c => c.dataset.label + ": " + pct(c.parsed.y)}}},
      scales:{x:{grid:{display:false}, ticks:{font:{size:12}}}, y:{grid:{color:"#eef1f6"}, ticks:{font:{size:12}, callback:x => x + "%"}}}});
    const reasons = {}; this.filtered.forEach(t => reasons[t.why] = (reasons[t.why] || 0) + 1);
    const rk = Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]).slice(0, 5);
    this.upsert("exits", "doughnut", {labels:rk.map(r => r.replace(/_/g, " ")), datasets:[{data:rk.map(r => reasons[r]), backgroundColor:["#1f5eff","#d97706","#059669","#7c3aed","#8a94a8"], borderColor:"#fff", borderWidth:2}]},
      {responsive:true, maintainAspectRatio:false, animation:false, cutout:"62%", plugins:{legend:{position:"right", labels:{usePointStyle:true, boxWidth:8, font:{size:12.5, weight:"600"}}}}});
  }
  upsert(key, type, data, options) {
    if (this.charts[key]) { this.charts[key].data = data; this.charts[key].options = options; this.charts[key].update("none"); return; }
    this.charts[key] = new Chart(document.getElementById("c-" + key), {type, data, options});
  }
  renderTable() {
    const {col, dir} = this.sort, rows = [...this.filtered].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === "asc" ? 1 : -1));
    const pages = Math.max(1, Math.ceil(rows.length / this.pageSize)); this.page = Math.min(Math.max(this.page, 0), pages - 1);
    const part = rows.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    let h = "<table><thead><tr>" + COLS.map(([k, l, r]) => '<th class="' + (r || "") + '" data-col="' + k + '">' + l + (col === k ? (dir === "asc" ? " ▲" : " ▼") : "") + "</th>").join("") + "</tr></thead><tbody>";
    part.forEach(t => { h += "<tr><td>" + t.id + "</td><td><b>" + t.sym + "</b></td><td>" + t.side + "</td><td>" + t.entry + "</td><td>" + t.exit + '</td><td class="r">' + num(t.ep) + '</td><td class="r">' + num(t.xp) +
      '</td><td class="r">' + num(t.qty, t.qty % 1 ? 4 : 0) + '</td><td class="r ' + tone(t.pnl) + '"><b>' + money(t.pnl) + '</b></td><td class="r ' + tone(t.ret) + '">' + pct(t.ret) + '</td><td class="r">' + t.bars + "</td><td>" + t.why.replace(/_/g, " ") + "</td></tr>"; });
    document.getElementById("t-body").innerHTML = h + "</tbody></table>";
    document.querySelectorAll("#t-body th").forEach(th => th.onclick = () => { const c = th.dataset.col; this.sort = {col:c, dir:this.sort.col === c && this.sort.dir === "desc" ? "asc" : "desc"}; this.renderTable(); });
    document.getElementById("t-count").textContent = rows.length + " trades";
    document.getElementById("t-page").textContent = rows.length ? "Showing " + (this.page * this.pageSize + 1) + "-" + Math.min((this.page + 1) * this.pageSize, rows.length) + " of " + rows.length : "No trades match the filters";
    document.getElementById("t-prev").disabled = this.page === 0; document.getElementById("t-next").disabled = this.page >= pages - 1;
  }
}
const dashboard = new Dashboard(DATA);
</script>
</body>
</html>`;
}

export function downloadDashboard(res: BacktestResult) {
  const html = buildDashboardHTML(res);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const slug = res.strategy.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  a.download = `${slug}_dashboard_${(res.metrics.end || "").slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}
