"""End-to-end UI test: drives the real dashboard in Firefox like a user would.

    uv run --group e2e python e2e/run_e2e.py            # starts its own isolated server on :8765
    uv run --group e2e python e2e/run_e2e.py --headed   # watch it
    uv run --group e2e python e2e/run_e2e.py --only lab,optimize

The suite runs against a private server with a throwaway data folder
(e2e/output/data_store), so your run history and saved strategies are never
touched. Only the downloaded-price cache is shared, to keep it fast.

It clicks every navigation item, control and results tab, runs every built-in
strategy, writes a new strategy in the Strategy Lab (plus broken ones, to check
error reporting), optimises and walk-forward-tests it, uploads a CSV, and
exercises the history page. A report is written to e2e/output/report.md with
screenshots of any failure.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import traceback
from datetime import date, timedelta
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import NoAlertPresentException, TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import Select, WebDriverWait

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output"
DOWNLOADS = OUT / "downloads"
PORT = 8765
BASE = os.environ.get("QF_URL", f"http://localhost:{PORT}")
SQUEEZE = (ROOT / "strategies" / "squeeze_breakout.py").read_text()

BROKEN_SYNTAX = '''class Broken(Strategy):
    params = {"n": 5}
    def next(self)
        self.buy()
'''
CRASHY = '''class Crashy(Strategy):
    name = "E2E Crashy"
    params = {"n": 10}
    def init(self):
        self.s = self.I(sma, self.data.close, self.p.n)
    def next(self):
        if self.bar == 300:
            self.oops = 1 / 0
'''
HOOK = """if (!window.__errs) { window.__errs = [];
  const oe = console.error; console.error = function (...a) { window.__errs.push(a.map(String).join(' ')); oe.apply(console, a); };
  window.addEventListener('error', e => window.__errs.push('onerror: ' + e.message));
  window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + ((e.reason && e.reason.message) || e.reason))); }"""


# --------------------------------------------------------------------------- #
class UI:
    def __init__(self, headed: bool):
        o = Options()
        if not headed:
            o.add_argument("-headless")
        snap_ff = Path("/snap/firefox/current/usr/lib/firefox/firefox")
        if os.environ.get("FIREFOX_BIN") or snap_ff.exists():
            o.binary_location = os.environ.get("FIREFOX_BIN", str(snap_ff))
        for k, v in {"browser.download.folderList": 2, "browser.download.dir": str(DOWNLOADS),
                     "browser.download.useDownloadDir": True, "browser.download.manager.showWhenStarting": False,
                     "browser.helperApps.neverAsk.saveToDisk": "text/csv,application/json,application/octet-stream"}.items():
            o.set_preference(k, v)
        gd = os.environ.get("GECKODRIVER") or ("/snap/bin/geckodriver" if Path("/snap/bin/geckodriver").exists() else None)
        self.d = webdriver.Firefox(options=o, service=Service(gd) if gd else None)
        self.d.set_window_size(1600, 1000)

    # -- basics ---------------------------------------------------------------
    def js(self, code, *args):
        return self.d.execute_script(code, *args)

    def load(self, page="backtest", config: dict | None = None, theme="dark"):
        self.d.get(BASE + "/")
        if config is not None:
            self.js("localStorage.setItem('qf.config', arguments[0]);", json.dumps(config))
        self.js("localStorage.setItem('qf.theme', arguments[0]);", theme)
        self.d.get(f"{BASE}/#{page}")
        self.d.refresh()
        self.js(HOOK)
        self.wait("document.querySelector('.topbar h1') && !document.querySelector('.content .spin')", 20, "app boot")

    def wait(self, cond_js, timeout=30, what="condition"):
        try:
            WebDriverWait(self.d, timeout, 0.2).until(lambda d: d.execute_script("return !!(" + cond_js + ")"))
        except TimeoutException:
            raise AssertionError(f"timed out after {timeout}s waiting for {what}")

    def els(self, css, scope=None):
        return (scope or self.d).find_elements(By.CSS_SELECTOR, css)

    def el(self, css, scope=None):
        found = self.els(css, scope)
        assert found, f"element not found: {css}"
        return found[0]

    def by_text(self, text, css="button", scope=None, exact=False):
        for e in self.els(css, scope):
            t = e.text.strip()
            if (t == text) if exact else t.startswith(text):
                return e
        raise AssertionError(f"no <{css}> with text {text!r}")

    def click(self, e):
        self.js("arguments[0].scrollIntoView({block: 'center'})", e)
        try:
            e.click()
        except Exception:
            self.js("arguments[0].click()", e)
        time.sleep(0.15)

    def click_text(self, text, css="button", scope=None, exact=False):
        self.click(self.by_text(text, css, scope, exact))

    def nav(self, label):
        self.click_text(label, ".nav-item")

    def section(self, title, open_=True) -> object:
        for s in self.els(".section"):
            if self.el(".section-head .t", s).text.strip() == title:
                is_open = "open" in s.get_attribute("class")
                if is_open != open_:
                    self.click(self.el(".section-head", s))
                return s
        raise AssertionError(f"section {title!r} not found")

    def field(self, label, scope=None):
        for f in self.els(".field", scope):
            lab = self.els(":scope > label", f)
            if lab and lab[0].text.strip().startswith(label):
                return f
        raise AssertionError(f"field {label!r} not found")

    def type_into(self, inp, value):
        self.click(inp)
        inp.send_keys(Keys.CONTROL, "a")
        inp.send_keys(Keys.BACKSPACE)
        inp.send_keys(str(value))
        time.sleep(0.1)

    def config(self) -> dict:
        return json.loads(self.js("return localStorage.getItem('qf.config')") or "{}")

    def errors(self):
        return self.js("return window.__errs || []")

    def accept_dialog(self, text=None, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            try:
                a = self.d.switch_to.alert
                if text is not None:
                    a.send_keys(text)
                a.accept()
                return True
            except NoAlertPresentException:
                time.sleep(0.1)
        raise AssertionError("expected a browser dialog")

    # -- app actions ----------------------------------------------------------
    def result_id(self):
        return self.js("const e = document.querySelector('[data-result-id]'); return e ? e.dataset.resultId : null")

    def run_backtest(self, timeout=150, expect_error=False):
        before = self.result_id()
        self.click_text("Run backtest")
        self.wait(f"(document.querySelector('[data-result-id]') && document.querySelector('[data-result-id]').dataset.resultId !== {json.dumps(before)})"
                  " || document.querySelector('.pane .alert.err')", timeout, "backtest to finish")
        self.wait("![...document.querySelectorAll('button')].some(b => b.textContent.includes('Running'))", timeout, "run button to reset")
        err = self.els(".pane .alert.err")
        if expect_error:
            assert err, "expected an error alert"
            return err[0].text
        assert not err, "backtest failed: " + (err[0].text if err else "")
        return self.summary()

    def summary(self) -> dict:
        return self.js("""
          const k = {}; document.querySelectorAll('.kpis .kpi').forEach(e => k[e.querySelector('.kpi-label').textContent.trim()] = e.querySelector('.kpi-value').textContent.trim());
          const tab = [...document.querySelectorAll('button.tab')].find(b => b.textContent.startsWith('Trades'));
          return { title: (document.querySelector('.result-title') || {}).textContent, kpis: k,
                   trades: tab ? parseInt(tab.querySelector('.count').textContent) : null,
                   warnings: [...document.querySelectorAll('.pane .alert.warn')].map(e => e.textContent.trim()) };""")

    def tab(self, name):
        self.click_text(name, "button.tab")
        time.sleep(0.6)

    def canvases(self, scope_css=".pane"):
        return self.js(f"return document.querySelectorAll('{scope_css} canvas').length")

    def downloads(self):
        return sorted(p.name for p in DOWNLOADS.glob("*") if not p.name.endswith(".part"))

    def set_code(self, code):
        """Select everything in the editor and type the code in through the editor's input handling."""
        cm = self.el(".cm-content")
        self.click(cm)
        cm.send_keys(Keys.CONTROL, "a")
        # Synthetic paste events carry no data in Firefox; insertText goes through the same path as typing.
        self.js("return document.execCommand('insertText', false, arguments[0])", code)
        time.sleep(0.4)
        got = self.js("return localStorage.getItem('qf.labcode')")
        assert got.strip() == code.strip(), "editor content does not match the pasted code"


# --------------------------------------------------------------------------- #
class Suite:
    def __init__(self, ui: UI):
        self.ui = ui
        self.results: list[tuple[str, str, str, float]] = []
        self.notes: list[str] = []

    def check(self, name, fn):
        t0 = time.time()
        try:
            detail = fn() or ""
            errs = self.ui.errors()
            if errs:
                raise AssertionError("JavaScript errors: " + " | ".join(errs[:3]))
            self.results.append(("PASS", name, str(detail), time.time() - t0))
            print(f"  PASS  {name}  {detail}")
        except Exception as e:
            shot = OUT / f"fail_{len(self.results):03d}.png"
            try:
                self.ui.d.save_screenshot(str(shot))
            except Exception:
                pass
            msg = f"{type(e).__name__}: {e}".split("\n")[0][:300]
            self.results.append(("FAIL", name, f"{msg} ({shot.name})", time.time() - t0))
            print(f"  FAIL  {name}  {msg}")
            traceback.print_exc(limit=2)
            try:
                self.ui.js("window.__errs = []")
            except Exception:
                pass


# --------------------------------------------------------------------------- #
CANON = {"source": "yahoo", "market": "NSE", "symbols": ["RELIANCE", "TCS", "INFY"], "start": "2015-01-01",
         "interval": "1d", "strategy": {"id": "SmaCross", "params": {}}}


def shell_tests(s: Suite):
    ui = s.ui
    print("\n[1] App shell")
    ui.load("backtest", CANON)

    def nav_all():
        pages = {"Backtest": "Backtest", "Optimize": "Parameter optimisation", "Walk-forward": "Walk-forward analysis",
                 "Strategy Lab": "Strategy Lab", "Data": "Market data", "History": "Run history"}
        for label, title in pages.items():
            ui.nav(label)
            ui.wait(f"document.querySelector('.topbar h1').textContent === {json.dumps(title)}", 10, f"{label} page")
        ui.nav("Backtest")
        return f"{len(pages)} pages"
    s.check("Sidebar navigation reaches every page", nav_all)

    def theme():
        start = ui.js("return document.documentElement.dataset.theme")
        ui.click_text("Light mode" if start == "dark" else "Dark mode", ".nav-item")
        mid = ui.js("return document.documentElement.dataset.theme")
        ui.click_text("Light mode" if mid == "dark" else "Dark mode", ".nav-item")
        end = ui.js("return document.documentElement.dataset.theme")
        assert start != mid and end == start, (start, mid, end)
        return f"{start} -> {mid} -> {end}"
    s.check("Theme toggle switches and switches back", theme)

    def collapse():
        ui.click_text("Collapse", ".nav-item")
        assert "collapsed" in ui.el(".app").get_attribute("class")
        ui.click(ui.els(".sidebar-foot .nav-item")[-1])
        assert "collapsed" not in ui.el(".app").get_attribute("class")
    s.check("Sidebar collapses and expands", collapse)


def config_tests(s: Suite):
    ui = s.ui
    print("\n[2] Backtest settings panel")
    ui.load("backtest", CANON)

    def sources():
        data = ui.section("Data")
        ui.click_text("My CSV", ".seg button", data)
        ui.field("Datasets", data)
        assert ui.config()["source"] == "csv"
        ui.click_text("Synthetic", ".seg button", data)
        assert ui.config()["source"] == "synthetic"
        ui.click_text("Markets", ".seg button", data)
        assert ui.config()["source"] == "yahoo"
    s.check("Data source switch: Markets / My CSV / Synthetic", sources)

    def exchange():
        data = ui.section("Data")
        Select(ui.el("select", ui.field("Exchange", data))).select_by_value("NASDAQ")
        time.sleep(0.3)
        c = ui.config()
        assert c["market"] == "NASDAQ" and c["symbols"] == ["AAPL"], c["symbols"]
        Select(ui.el("select", ui.field("Exchange", data))).select_by_value("NSE")
        time.sleep(0.3)
        return f"NASDAQ -> {ui.config()['symbols']}"
    s.check("Exchange select switches market and default symbol", exchange)

    def symbols():
        data = ui.section("Data")
        for chip_btn in ui.els(".chip button", data):
            ui.click(chip_btn)
        assert ui.config()["symbols"] == []
        inp = ui.el(".chips input", data)
        ui.click(inp); inp.send_keys("reliance", Keys.ENTER); time.sleep(0.2)
        try_btns = ui.els(".quick-syms button", data)
        ui.click(try_btns[0]); ui.click(ui.els(".quick-syms button", data)[0])
        syms = ui.config()["symbols"]
        assert len(syms) == 3 and syms[0] == "RELIANCE", syms
        inp = ui.el(".chips input", data)
        ui.click(inp); inp.send_keys(Keys.BACKSPACE); time.sleep(0.2)
        assert len(ui.config()["symbols"]) == 2
        return f"typed + suggestions -> {syms}, backspace removes last"
    s.check("Symbol picker: remove, type + Enter, 'Try' chips, Backspace", symbols)

    def search():
        data = ui.section("Data")
        inp = ui.el(".chips input", data)
        ui.click(inp); inp.send_keys("infos")
        try:
            ui.wait("document.querySelectorAll('.suggest-item').length > 0", 12, "search suggestions")
        except AssertionError:
            inp.send_keys(Keys.CONTROL, "a", Keys.BACKSPACE)
            return "no suggestions returned (Yahoo search unavailable) - skipped"
        names = ui.js("return [...document.querySelectorAll('.suggest-item .sym')].map(e => e.textContent)")
        inp.send_keys(Keys.ENTER); time.sleep(0.3)
        added = ui.config()["symbols"][-1]
        assert "INFY" in added or "INFOSYS" in added.upper() or added in [n.replace(".NS", "") for n in names], added
        return f"suggested {names[:3]}, Enter added {added}"
    s.check("Live ticker search suggestions", search)

    def presets():
        data = ui.section("Data")
        today = date.today()
        ui.click_text("1Y", ".link-row button", data, exact=True)
        c = ui.config()
        assert abs((date.fromisoformat(c["start"]) - (today - timedelta(days=365))).days) <= 2, c["start"]
        ui.click_text("Max", ".link-row button", data, exact=True)
        assert ui.config()["start"] == "1990-01-01"
        for p in ("3Y", "5Y", "10Y", "YTD"):
            ui.click_text(p, ".link-row button", data, exact=True)
        assert ui.config()["start"] == f"{today.year}-01-01"
        return "1Y/3Y/5Y/10Y/YTD/Max"
    s.check("Date range presets", presets)

    def misc_data():
        data = ui.section("Data")
        Select(ui.el("select", ui.field("Timeframe", data))).select_by_value("1wk")
        assert ui.config()["interval"] == "1wk"
        Select(ui.el("select", ui.field("Timeframe", data))).select_by_value("1d")
        ui.type_into(ui.el("input", ui.field("Benchmark", data)), "^NSEBANK")
        assert ui.config()["benchmark"] == "^NSEBANK"
        ui.type_into(ui.el("input", ui.field("Benchmark", data)), "auto")
        tog = ui.by_text("Adjust for splits", "label.toggle", data)
        ui.click(tog); assert ui.config()["adjusted"] is False
        ui.click(tog); assert ui.config()["adjusted"] is True
    s.check("Timeframe, benchmark and adjustment toggle", misc_data)

    def strategy_params():
        st = ui.section("Strategy")
        sel = Select(ui.el("select", st))
        sel.select_by_value("RsiReversion")
        time.sleep(0.3)
        labels = [l.text for l in ui.els(".grid2 .field > label", st)]
        assert labels == ["period", "oversold", "overbought", "exit level"], labels
        ui.type_into(ui.el("input", ui.field("oversold", st)), 25)
        assert ui.config()["strategy"]["params"]["oversold"] == 25
        sel.select_by_value("SmaCross")
        return f"param form fields: {labels}"
    s.check("Strategy select builds the parameter form", strategy_params)

    def costs():
        sec = ui.section("Capital & costs")
        ui.type_into(ui.el("input", ui.field("Initial capital", sec)), 500000)
        assert ui.config()["capital"] == 500000
        sel = Select(ui.el("select", ui.field("Commission model", sec)))
        seen = []
        for opt in [o.get_attribute("value") for o in sel.options]:
            Select(ui.el("select", ui.field("Commission model", sec))).select_by_value(opt)
            time.sleep(0.15)
            seen.append(opt or "auto")
        Select(ui.el("select", ui.field("Commission model", sec))).select_by_value("")
        ui.click_text("Same bar close", ".seg button", sec)
        assert ui.config()["fill_on"] == "close"
        ui.click_text("Next bar open", ".seg button", sec)
        ui.type_into(ui.el("input", ui.field("Initial capital", sec)), 1000000)
        ui.section("Capital & costs", open_=False)
        return f"{len(seen)} commission models"
    s.check("Capital & costs controls", costs)

    def sizing():
        sec = ui.section("Sizing & risk")
        sel = lambda: Select(ui.el("select", ui.field("Position sizing", sec)))
        labels = []
        for mode in ("risk", "fixed_cash", "fixed_qty", "percent"):
            sel().select_by_value(mode); time.sleep(0.15)
            labels.append(ui.els(".grid2 .field > label", sec)[1].text)
        for lab, val in (("Stop loss", 5), ("Take profit", 12), ("Trailing", 0)):
            ui.type_into(ui.el("input", ui.field(lab, sec)), val)
        c = ui.config()
        assert c["stops"]["stop_loss_pct"] == 5 and c["stops"]["take_profit_pct"] == 12
        ui.type_into(ui.el("input", ui.field("Stop loss", sec)), 0)
        ui.type_into(ui.el("input", ui.field("Take profit", sec)), 0)
        ui.section("Sizing & risk", open_=False)
        return f"sizing labels {labels}"
    s.check("Sizing modes and stop inputs", sizing)

    def rules():
        sec = ui.section("Trading rules")
        for d, val in (("Short only", "short"), ("Both", "both"), ("Long only", "long")):
            ui.click_text(d, ".seg button", sec, exact=True)
            assert ui.config()["rules"]["direction"] == val
        ui.click_text("Fixed capital", ".seg button", sec)
        assert ui.config()["rules"]["sizing_base"] == "fixed"
        ui.click(ui.by_text("Square off", "label.toggle", sec))
        assert ui.config()["rules"]["square_off"] is True
        ui.type_into(ui.el("input", ui.field("Max new capital per day", sec)), 250000)
        ui.type_into(ui.el("input", ui.field("Max trades per day", sec)), 4)
        ui.type_into(ui.el("input", ui.field("Daily loss limit", sec)), 2)
        r = ui.config()["rules"]
        assert r["daily_capital_limit"] == 250000 and r["max_trades_per_day"] == 4 and r["daily_loss_limit_pct"] == 2
        summary = ui.el(".section-head .s", sec).text if ui.els(".section-head .s", sec) else ""
        ui.click_text("Reset rules", "button", sec)
        r = ui.config()["rules"]
        assert not r["square_off"] and r["daily_capital_limit"] == 0 and r["sizing_base"] == "compound"
        ui.section("Trading rules", open_=False)
        return "direction, capital mode, square-off, limits, reset"
    s.check("Trading rules controls and Reset", rules)

    def collapse_all():
        for t in ("Data", "Strategy", "Capital & costs", "Sizing & risk", "Trading rules"):
            ui.section(t, open_=False)
        assert all("open" not in x.get_attribute("class") for x in ui.els(".section"))
        for t in ("Data", "Strategy"):
            ui.section(t, open_=True)
    s.check("Every settings section collapses and expands", collapse_all)


def strategy_matrix(s: Suite):
    ui = s.ui
    print("\n[3] Every built-in strategy through the UI")
    ui.load("backtest", CANON)
    sel = lambda: Select(ui.el("select", ui.section("Strategy")))
    options = [(o.get_attribute("value"), o.text) for o in sel().options if not o.get_attribute("value").startswith("custom:")]
    table = []
    for sid, label in options:
        def run_one(sid=sid, label=label):
            sel().select_by_value(sid)
            time.sleep(0.3)
            res = ui.run_backtest()
            assert res["title"] == label, f"result title {res['title']!r} != {label!r}"
            assert res["kpis"].get("Total return"), "no KPI values"
            if res["trades"] == 0:
                assert res["warnings"] and res["warnings"][0].startswith("No trades"), "0 trades but no explanation"
            table.append((label, res["trades"], res["kpis"]["Total return"], res["kpis"]["Sharpe ratio"]))
            return f"{res['trades']} trades, {res['kpis']['Total return']}, Sharpe {res['kpis']['Sharpe ratio']}"
        s.check(f"Strategy: {label}", run_one)
    s.notes.append("| Strategy | Trades | Return | Sharpe |\n|---|---|---|---|\n" +
                   "\n".join(f"| {a} | {b} | {c} | {d} |" for a, b, c, d in table))


def results_tests(s: Suite):
    ui = s.ui
    print("\n[4] Results tabs and buttons")
    ui.load("backtest", CANON)
    s.check("Run SMA Crossover (baseline result)", lambda: ui.run_backtest()["kpis"])

    def overview():
        assert ui.canvases() >= 1
        cells = ui.js("return document.querySelectorAll('.heat .hc').length")
        rows = ui.js("return document.querySelectorAll('.metric-cols .metric-row').length")
        ui.click_text("Log", ".seg button", ui.el(".pane")); time.sleep(0.4)
        ui.click_text("Linear", ".seg button", ui.el(".pane"))
        assert cells > 100 and rows == 18, (cells, rows)
        return f"{cells} heatmap cells, {rows} key stats"
    s.check("Overview: equity chart, Linear/Log, heatmap, key stats", overview)

    def exports():
        before = set(ui.downloads())
        ui.click_text("JSON", ".result-actions button"); ui.click_text("CSV", ".result-actions button")
        ui.wait("true", 1)
        end = time.time() + 10
        while time.time() < end and len(set(ui.downloads()) - before) < 2:
            time.sleep(0.3)
        new = set(ui.downloads()) - before
        assert any(n.endswith(".json") for n in new) and any(n.endswith(".csv") for n in new), new
        j = json.loads(next(DOWNLOADS / n for n in new if n.endswith(".json")).read_text())
        csv_lines = next(DOWNLOADS / n for n in new if n.endswith(".csv")).read_text().splitlines()
        assert "metrics" in j and len(csv_lines) > 1000 and csv_lines[0].startswith("date,equity")
        return f"{sorted(new)}"
    s.check("Export JSON and equity CSV downloads", exports)

    def chart():
        ui.tab("Chart")
        ui.wait("document.querySelectorAll('.pane canvas').length > 0", 10, "price chart")
        pane = ui.el(".pane")
        ui.click(ui.by_text("Trades", "label.toggle", pane)); ui.click(ui.by_text("Volume", "label.toggle", pane))
        ui.click(ui.by_text("Trades", "label.toggle", pane)); ui.click(ui.by_text("Volume", "label.toggle", pane))
        sym = Select(ui.el(".card-actions select", pane))
        sym.select_by_index(1); time.sleep(0.6)
        title = ui.els(".pane .card-title")[1].text
        assert sym.first_selected_option.text in title, title
        rows = ui.els(".pane .tbl tbody tr")
        ui.click(rows[2]); time.sleep(0.4)
        assert "sel" in ui.els(".pane .tbl tbody tr")[2].get_attribute("class")
        return f"{title}, {len(rows)} trade rows, row click selects"
    s.check("Chart: toggles, symbol switch, trade row zoom", chart)

    def trades():
        ui.tab("Trades")
        pane = ui.el(".pane")
        count = lambda: int(ui.js("return document.querySelectorAll('.pane .tbl tbody tr').length"))
        total = count()
        ui.click_text("Winners", ".seg button", pane); w = count()
        ui.click_text("Losers", ".seg button", pane); l = count()
        ui.click_text("All", ".seg button", pane, exact=True)
        assert w + l == total, (w, l, total)
        segs = ui.els(".card-actions .seg", pane)
        ui.click_text("Short", ".seg button", segs[0]); sh = count()
        ui.click_text("All", ".seg button", segs[0], exact=True)
        Select(ui.el(".card-actions select", pane)).select_by_index(1); one = count()
        Select(ui.el(".card-actions select", pane)).select_by_index(0)
        assert one < total
        # sort by P&L descending
        ui.click(ui.by_text("P&L", ".pane .tbl th")); time.sleep(0.3)
        pnl = ui.js("return [...document.querySelectorAll('.pane .tbl tbody tr')].map(r => r.children[8].textContent)")
        vals = [float(p.replace("₹", "").replace(",", "").replace("−", "-")) for p in pnl[:20]]
        assert vals == sorted(vals, reverse=True), vals[:5]
        before = set(ui.downloads())
        ui.click_text("CSV", ".pane .card-actions button")
        end = time.time() + 8
        while time.time() < end and not (set(ui.downloads()) - before):
            time.sleep(0.3)
        assert set(ui.downloads()) - before, "trade CSV not downloaded"
        return f"{total} trades = {w} winners + {l} losers, {sh} shorts, sort + CSV ok"
    s.check("Trades: filters, sorting, CSV export", trades)

    def analysis():
        ui.tab("Analysis")
        ui.wait("document.querySelectorAll('.pane canvas').length >= 6", 10, "analysis charts")
        for opt in ("MAE", "MFE", "Duration"):
            ui.click_text(opt, ".seg button", ui.el(".pane"), exact=True)
        dd = ui.js("return document.querySelectorAll('.pane .tbl tbody tr').length")
        return f"{ui.canvases()} charts, {dd} drawdown rows"
    s.check("Analysis: charts and scatter axis toggle", analysis)

    def montecarlo():
        ui.tab("Monte Carlo")
        ui.wait("document.querySelectorAll('.pane canvas').length >= 3", 10, "monte carlo charts")
        tiles = lambda: ui.els(".pane .kpis")[1].text  # [0] is the result's KPI strip
        a = tiles()
        ui.click_text("Resample trades", ".seg button", ui.el(".pane")); time.sleep(0.6)
        b = tiles()
        assert a != b, "Monte Carlo tiles did not change"
        assert ui.canvases() >= 3
        return f"bootstrap median {a.splitlines()[1]} vs trade resampling median {b.splitlines()[1]}"
    s.check("Monte Carlo: both simulation methods", montecarlo)

    def details():
        ui.tab("Details")
        groups = [e.text for e in ui.els(".pane .metric-grid .card-title")]
        fills = ui.js("return document.querySelectorAll('.pane .charts-2 .tbl tbody tr').length")
        assert {"Returns", "Risk", "Trades", "Configuration"} <= set(groups), groups
        assert fills > 10
        return f"{len(groups)} groups, {fills} fills"
    s.check("Details: metric groups, configuration, fills", details)

    def shortcut():
        before = ui.result_id()
        ui.el("body").send_keys(Keys.CONTROL, Keys.ENTER)
        ui.wait(f"document.querySelector('[data-result-id]').dataset.resultId !== {json.dumps(before)}", 60, "Ctrl+Enter run")
    s.check("Ctrl+Enter runs the backtest", shortcut)

    def error_case():
        cfg = dict(CANON, symbols=["ZZZNOTATICKER"])
        ui.load("backtest", cfg)
        msg = ui.run_backtest(expect_error=True)
        assert "no data" in msg.lower(), msg
        return msg.replace("\n", " ")[:90]
    s.check("Unknown ticker shows a clear error", error_case)


def lab_tests(s: Suite):
    ui = s.ui
    print("\n[5] Strategy Lab: build and test a new strategy")
    ui.load("lab", CANON)

    def template():
        ui.wait("document.querySelector('.cm-content')", 10, "editor")
        ui.click_text("New", "button")
        ui.click_text("Validate", "button")
        ui.wait("document.querySelector('.alert')", 15, "validation")
        assert "Looks good" in ui.el(".alert").text
    s.check("Template validates", template)

    def syntax_error():
        ui.set_code(BROKEN_SYNTAX)
        ui.click_text("Validate", "button")
        ui.wait("document.querySelector('.alert.err')", 15, "error")
        txt = ui.el(".alert.err").text
        assert "line 3" in txt, txt
        return txt.split("\n")[0]
    s.check("Syntax error is reported with its line", syntax_error)

    def blocked_import():
        ui.set_code("import os\nclass A(Strategy):\n    pass\n")
        ui.click_text("Validate", "button")
        ui.wait("document.querySelector('.alert.err')", 15, "error")
        assert "not allowed" in ui.el(".alert.err").text
    s.check("Unsafe import is blocked", blocked_import)

    def write_new():
        ui.set_code(SQUEEZE)
        name = ui.el(".card-actions input")
        ui.type_into(name, "Squeeze Breakout")
        ui.click_text("Validate", "button")
        ui.wait("document.querySelector('.alert.info')", 15, "validation")
        pills = ui.js("return [...document.querySelectorAll('.alert.info .pill')].map(p => p.textContent)")
        assert len(pills) == 7, pills
        ui.click_text("Save", "button", exact=True)
        ui.wait("[...document.querySelectorAll('.metric-row b')].some(b => b.textContent === 'Squeeze Breakout')", 15, "saved strategy in list")
        return f"params: {', '.join(pills)}"
    s.check("Write, validate and save 'Squeeze Breakout'", write_new)

    def save_and_run():
        ui.click_text("Save & backtest", "button")
        ui.wait("document.querySelector('.topbar h1').textContent === 'Backtest' && document.querySelector('[data-result-id]')", 120, "backtest page with result")
        res = ui.summary()
        assert res["title"] == "Squeeze Breakout", res["title"]
        assert res["trades"] > 10, res
        ui.tab("Details")
        logs = ui.js("return [...document.querySelectorAll('.pane td.mono')].map(t => t.textContent)")
        assert logs and "breakout" in logs[0], logs[:2]
        ui.tab("Chart")
        ui.wait("document.querySelectorAll('.pane canvas').length > 0", 10, "price chart")
        return f"{res['trades']} trades, {res['kpis']['Total return']}, log: '{logs[0]}'"
    s.check("Save & backtest runs the new strategy end to end", save_and_run)

    def in_dropdown():
        opts = [o.text for o in Select(ui.el("select", ui.section("Strategy"))).options]
        assert "Squeeze Breakout" in opts
        grp = ui.js("return [...document.querySelectorAll('optgroup')].map(g => g.label)")
        assert grp[0] == "My strategies", grp
    s.check("New strategy appears under 'My strategies'", in_dropdown)

    def with_rules():
        sec = ui.section("Trading rules")
        ui.click_text("Both", ".seg button", sec, exact=True)
        res = ui.run_backtest()
        ui.tab("Trades")
        sides = set(ui.js("return [...document.querySelectorAll('.pane .tbl tbody tr')].map(r => r.children[2].textContent)"))
        ui.click_text("Long only", ".seg button", ui.section("Trading rules"), exact=True)
        assert sides == {"Long", "Short"}, sides
        return f"{res['trades']} trades long+short"
    s.check("New strategy honours Trading rules (can_short)", with_rules)

    def runtime_error():
        ui.nav("Strategy Lab")
        ui.click_text("New", "button")
        ui.set_code(CRASHY)
        ui.type_into(ui.el(".card-actions input"), "E2E Crashy")
        ui.click_text("Save & backtest", "button")
        ui.wait("document.querySelector('.alert.err')", 60, "runtime error")
        txt = ui.el(".alert.err").text
        assert "ZeroDivisionError in next() on line 8" in txt, txt
        return txt.split("\n")[1] if "\n" in txt else txt
    s.check("Runtime error points at the line and bar", runtime_error)

    def fork_and_delete():
        ui.click_text("SMA Crossover", ".quick-syms button")
        assert "class SmaCross" in ui.js("return localStorage.getItem('qf.labcode')")
        assert ui.el(".card-actions input").get_attribute("value") == "SMA Crossover (fork)"
        rows = [r for r in ui.els(".metric-row") if "E2E Crashy" in r.text]
        assert rows, "crashy strategy not listed"
        ui.click(ui.el(".btn-danger", rows[0]))
        ui.accept_dialog()
        ui.wait("![...document.querySelectorAll('.metric-row')].some(r => r.textContent.includes('E2E Crashy'))", 10, "deletion")
    s.check("Fork a built-in and delete a saved strategy", fork_and_delete)


def optimize_tests(s: Suite):
    ui = s.ui
    print("\n[6] Optimiser and walk-forward")
    # Make sure the strategy built in the Lab group exists (also when running this group alone).
    req = urllib.request.Request(f"{BASE}/api/strategies/custom", data=json.dumps({"name": "Squeeze Breakout", "code": SQUEEZE}).encode(),
                                 headers={"Content-Type": "application/json", "Origin": BASE})
    urllib.request.urlopen(req, timeout=30)
    ui.load("optimize", dict(CANON, strategy={"id": "custom:squeeze_breakout", "params": {}}))

    def optimise_custom():
        tbl = ui.el(".config .card .tbl")
        rows = {r.find_elements(By.CSS_SELECTOR, "td b")[0].text: r for r in tbl.find_elements(By.CSS_SELECTOR, "tbody tr")}
        for name, r in rows.items():
            cb = r.find_element(By.CSS_SELECTOR, "input[type=checkbox]")
            if cb.is_selected() != (name in ("bb_period", "squeeze_pct")):
                ui.click(cb)
        def set_range(name, lo, hi, step):
            ins = rows[name].find_elements(By.CSS_SELECTOR, "input[type=number]")
            for inp, v in zip(ins, (lo, hi, step)):
                ui.type_into(inp, v)
        set_range("bb_period", 15, 25, 5)
        set_range("squeeze_pct", 10, 30, 10)
        btn = ui.by_text("Optimise", ".config button")
        assert "9 combinations" in btn.text, btn.text
        ui.click(btn)
        ui.wait("document.querySelector('.pane .hero-title') || document.querySelector('.pane .alert.err')", 180, "optimisation")
        assert not ui.els(".pane .alert.err")
        best = ui.el(".pane .hero-title").text
        assert ui.canvases() >= 2
        return best
    s.check("Optimise the new strategy (3x3 grid)", optimise_custom)

    def apply_best():
        params = ui.js("return [...document.querySelectorAll('.pane .hero-meta .pill')].slice(0, 2).map(p => p.textContent)")
        ui.click_text("Apply & backtest", "button")
        ui.wait("document.querySelector('.topbar h1').textContent === 'Backtest'", 10, "backtest page")
        c = ui.config()["strategy"]["params"]
        for p in params:
            k, v = [x.strip() for x in p.split("=")]
            assert float(c[k]) == float(v), (k, c[k], v)
        res = ui.run_backtest()
        return f"applied {params}, {res['trades']} trades"
    s.check("Apply & backtest uses the best parameters", apply_best)

    def random_search():
        ui.load("optimize", CANON)
        ui.click_text("Random", ".config .seg button")
        ui.type_into(ui.el("input", ui.field("Iterations", ui.els(".config .card")[1])), 12)
        ui.click(ui.by_text("Optimise", ".config button"))
        ui.wait("document.querySelector('.pane .hero-title') || document.querySelector('.pane .alert')", 180, "random search")
        assert ui.els(".pane .hero-title"), ui.el(".pane .alert").text
        n = ui.js("return document.querySelectorAll('.pane .tbl tbody tr').length")
        ui.click(ui.els(".pane .tbl tbody tr")[3])
        ui.wait("document.querySelector('.topbar h1').textContent === 'Backtest'", 10, "row click applies")
        return f"{n} results, row click applies params"
    s.check("Random search + click a result row", random_search)

    def walkforward():
        ui.load("walkforward", CANON)
        ui.type_into(ui.el("input", ui.field("Folds")), 3)
        ui.click_text("Run walk-forward", "button")
        ui.wait("document.querySelector('.pane .kpis') || document.querySelector('.pane .alert.err')", 240, "walk-forward")
        assert not ui.els(".pane .alert.err"), ui.el(".pane .alert.err").text
        folds = ui.js("return document.querySelectorAll('.pane .tbl tbody tr').length")
        eff = ui.el(".pane .kpis").text.replace("\n", " ")
        assert folds == 3, folds
        ui.click(ui.by_text("Anchored", "label.toggle"))
        ui.click_text("Run walk-forward", "button")
        ui.wait("document.querySelector('.pane .kpis') && !document.querySelector('.pane .progress')", 240, "anchored walk-forward")
        return f"3 folds; {eff[:80]}"
    s.check("Walk-forward rolling and anchored", walkforward)


def data_tests(s: Suite):
    ui = s.ui
    print("\n[7] Data page")
    csv = OUT / "e2e_upload.csv"
    import random
    random.seed(4)
    px, lines = 100.0, ["Date,Open,High,Low,Close,Volume"]
    d0 = date(2019, 1, 1)
    for k in range(900):
        o = px; px *= 1 + random.gauss(0.0004, 0.015)
        lines.append(f"{(d0 + timedelta(days=k)).isoformat()},{o:.2f},{max(o, px) * 1.004:.2f},{min(o, px) * 0.996:.2f},{px:.2f},{random.randint(10000, 90000)}")
    csv.write_text("\n".join(lines))
    ui.load("data", CANON)

    def explorer():
        ui.click_text("Load", "button")
        ui.wait("document.querySelector('.kpis') || document.querySelector('.alert.err')", 60, "explorer")
        assert ui.canvases(".content") >= 1
        ui.click_text("TCS", ".quick-syms button", exact=True)
        ui.wait("document.querySelector('.card-title') && [...document.querySelectorAll('.card-title')].some(t => t.textContent === 'TCS.NS')", 60, "TCS loaded")
        ui.click_text("Backtest this", "button")
        ui.wait("document.querySelector('.topbar h1').textContent === 'Backtest'", 10, "jump to backtest")
        assert ui.config()["symbols"] == ["TCS"]
        ui.nav("Data")
    s.check("Explorer: load, popular chip, 'Backtest this'", explorer)

    def upload():
        inp = ui.el("input[type=file]")
        inp.send_keys(str(csv))
        ui.wait("[...document.querySelectorAll('.tbl td')].some(td => td.textContent === 'E2E_UPLOAD')", 20, "upload listed")
        row = [r for r in ui.els(".tbl tbody tr") if "E2E_UPLOAD" in r.text][0]
        assert "900" in row.text
        ui.click(ui.by_text("View", "button", row))
        ui.wait("[...document.querySelectorAll('.kpi-value')].length >= 6", 20, "view stats")
        row = [r for r in ui.els(".tbl tbody tr") if "E2E_UPLOAD" in r.text][0]
        ui.click(ui.by_text("Backtest", "button", row, exact=True))
        ui.wait("document.querySelector('.topbar h1').textContent === 'Backtest'", 10, "backtest page")
        c = ui.config()
        assert c["source"] == "csv" and c["symbols"] == ["E2E_UPLOAD"], c
        res = ui.run_backtest()
        return f"900 rows uploaded, backtest {res['trades']} trades {res['kpis']['Total return']}"
    s.check("CSV upload, view, backtest from upload", upload)

    def delete_upload():
        ui.nav("Data")
        ui.wait("[...document.querySelectorAll('.tbl td')].some(td => td.textContent === 'E2E_UPLOAD')", 10, "upload row")
        row = [r for r in ui.els(".tbl tbody tr") if "E2E_UPLOAD" in r.text][0]
        ui.click(ui.el(".btn-danger", row))
        ui.accept_dialog()
        ui.wait("![...document.querySelectorAll('.tbl td')].some(td => td.textContent === 'E2E_UPLOAD')", 10, "row gone")
    s.check("Delete an uploaded dataset", delete_upload)


def history_tests(s: Suite):
    ui = s.ui
    print("\n[8] History")
    ui.load("history", CANON)

    def card(title):
        return [c for c in ui.els(".card") if ui.els(".card-title", c) and ui.el(".card-title", c).text == title][0]
    rows = lambda: ui.els(".tbl tbody tr", card("Backtest history"))

    def listing():
        ui.wait("document.querySelectorAll('.tbl tbody tr').length > 0", 15, "runs")
        return f"{len(ui.els('.tbl tbody tr'))} saved runs"
    s.check("Runs are listed", listing)

    def star_rename():
        starred = lambda: ui.js("return document.querySelectorAll('.tbl tbody tr svg[fill=\"var(--warn)\"]').length")
        before = starred()
        ui.click(ui.el("td:nth-child(2) button", rows()[-1]))  # last row: never starred by earlier runs of this test
        ui.wait(f"document.querySelectorAll('.tbl tbody tr svg[fill=\"var(--warn)\"]').length !== {before}", 10, "star toggle")
        after = starred()
        assert after == before + 1, (before, after)
        ui.click(ui.el("td:nth-child(2) button", rows()[0]))  # starred runs sort first: un-star it again
        ui.wait(f"document.querySelectorAll('.tbl tbody tr svg[fill=\"var(--warn)\"]').length === {before}", 10, "un-star")
        name_cell = ui.el("td:nth-child(3) div", rows()[0])
        from selenium.webdriver.common.action_chains import ActionChains
        ActionChains(ui.d).double_click(name_cell).perform()
        ui.accept_dialog("E2E renamed run")
        ui.wait("[...document.querySelectorAll('.tbl td div')].some(d => d.textContent === 'E2E renamed run')", 10, "rename")
    s.check("Star and rename a run", star_rename)

    def compare():
        boxes = ui.els(".tbl tbody input[type=checkbox]")[:3]
        for b in boxes:
            ui.click(b)
        ui.click(ui.by_text("Compare", "button"))
        ui.wait("[...document.querySelectorAll('.card-title')].some(t => t.textContent === 'Run comparison')", 30, "comparison")
        cmp = card("Run comparison")
        cols = len(ui.els(".tbl thead th", cmp))
        metrics = len(ui.els(".tbl tbody tr", cmp))
        assert cols == 4 and metrics >= 10 and ui.els("canvas", cmp), (cols, metrics)
        ui.click(ui.el(".card-actions button", cmp))
        ui.wait("![...document.querySelectorAll('.card-title')].some(t => t.textContent === 'Run comparison')", 5, "compare closed")
        return f"3 runs x {metrics} metrics, chart rendered, closed"
    s.check("Compare three runs", compare)

    def open_delete():
        n = len(rows())
        ui.click(ui.by_text("Open", "button", rows()[0]))
        ui.wait("document.querySelector('.topbar h1').textContent === 'Backtest' && document.querySelector('[data-result-id]')", 20, "opened run")
        title = ui.summary()["title"]
        ui.nav("History")
        ui.wait("document.querySelectorAll('.tbl tbody tr').length > 0", 15, "runs")
        ui.click(ui.el(".btn-danger", rows()[-1]))
        ui.accept_dialog()
        end = time.time() + 10
        while time.time() < end and len(rows()) != n - 1:
            time.sleep(0.2)
        assert len(rows()) == n - 1, (len(rows()), n)
        return f"opened '{title}', deleted one ({n} -> {n - 1})"
    s.check("Open a run and delete a run", open_delete)


def intraday_rules_test(s: Suite):
    ui = s.ui
    print("\n[9] Intraday trading rules")
    cfg = dict(CANON, interval="15m", start=(date.today() - timedelta(days=50)).isoformat(),
               strategy={"id": "RsiReversion", "params": {"period": 7}},
               rules={"direction": "short", "sizing_base": "compound", "square_off": True, "square_off_time": "15:15",
                      "entry_start": "09:30", "entry_end": "14:30", "daily_capital_limit": 200000,
                      "daily_capital_mode": "amount", "max_trades_per_day": 3, "max_open_positions": 0,
                      "max_position_pct": 0, "daily_loss_limit_pct": 0, "daily_profit_target_pct": 0,
                      "max_drawdown_stop_pct": 0, "cooldown_bars": 0})
    ui.load("backtest", cfg)

    def run():
        res = ui.run_backtest()
        meta = ui.js("return [...document.querySelectorAll('.result-meta')].map(e => e.textContent)")
        assert any("Square off daily at 15:15" in m for m in meta), meta
        ui.tab("Trades")
        sides = set(ui.js("return [...document.querySelectorAll('.pane .tbl tbody tr')].map(r => r.children[2].textContent)"))
        activity = ui.js("return [...document.querySelectorAll('.pane .metric-row .k')].map(e => e.textContent)")
        assert sides <= {"Short"} and any("square-off" in a for a in activity), (sides, activity)
        return f"{res['trades']} short trades; activity: {activity[:3]}"
    s.check("15m short-only with square-off, entry window and capital limit", run)


def mobile_test(s: Suite):
    ui = s.ui
    print("\n[10] Phone width")
    ui.d.set_window_size(420, 900)
    ui.load("backtest", CANON)

    def mobile():
        assert ui.el(".sidebar").is_displayed()
        ui.nav("History")
        ui.wait("document.querySelector('.topbar h1').textContent === 'Run history'", 10, "history")
        ui.nav("Backtest")
        res = ui.run_backtest()
        overflow = ui.js("return document.documentElement.scrollWidth > window.innerWidth + 2")
        assert not overflow, "page scrolls horizontally"
        return f"nav ok, backtest ok ({res['trades']} trades), no horizontal overflow"
    s.check("Navigation and backtest at phone width", mobile)
    ui.d.set_window_size(1600, 1000)


# --------------------------------------------------------------------------- #
def start_server() -> subprocess.Popen:
    project = ROOT.parent
    env = dict(os.environ, QF_DATA_DIR=str(OUT / "data_store"), QF_CACHE_DIR=str(project / "data_store" / "cache"))
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.api.main:app", "--host", "127.0.0.1",
                             "--port", str(PORT), "--log-level", "warning"], cwd=project, env=env)
    for _ in range(60):
        try:
            if json.load(urllib.request.urlopen(f"{BASE}/api/health", timeout=1)).get("frontend_built"):
                return proc
        except Exception:
            time.sleep(0.5)
    proc.terminate()
    raise SystemExit("e2e server did not start (is the frontend built? run: cd frontend && npm run build)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--only", help="comma separated groups: shell,config,strategies,results,lab,optimize,data,history,intraday,mobile")
    args = ap.parse_args()
    shutil.rmtree(OUT, ignore_errors=True)
    DOWNLOADS.mkdir(parents=True)
    groups = {"shell": shell_tests, "config": config_tests, "strategies": strategy_matrix, "results": results_tests,
              "lab": lab_tests, "optimize": optimize_tests, "data": data_tests, "history": history_tests,
              "intraday": intraday_rules_test, "mobile": mobile_test}
    chosen = args.only.split(",") if args.only else list(groups)
    server = None if os.environ.get("QF_URL") else start_server()
    ui = UI(args.headed)
    suite = Suite(ui)
    t0 = time.time()
    try:
        for g in chosen:
            groups[g](suite)
    finally:
        try:
            ui.d.quit()
        except Exception:
            pass
        if server:
            server.terminate()
            server.wait(10)
    passed = sum(r[0] == "PASS" for r in suite.results)
    lines = [f"# QuantForge end-to-end report\n", f"{passed}/{len(suite.results)} checks passed in {time.time() - t0:.0f}s\n",
             "| Result | Check | Detail | Time |", "|---|---|---|---|"]
    lines += [f"| {r} | {n} | {d.replace('|', '/')} | {t:.1f}s |" for r, n, d, t in suite.results]
    lines += ["", *suite.notes]
    (OUT / "report.md").write_text("\n".join(lines))
    print(f"\n{passed}/{len(suite.results)} checks passed - report: {OUT / 'report.md'}")
    raise SystemExit(0 if passed == len(suite.results) else 1)


if __name__ == "__main__":
    main()
