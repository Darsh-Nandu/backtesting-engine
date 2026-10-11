import math

import numpy as np
import pandas as pd
import pytest

from backend.engine.core import Backtester, EngineConfig
from backend.engine.costs import CostModel
from backend.engine.data import load_synthetic, normalize_ohlcv
from backend.engine.indicators import crossover, rsi, sma, supertrend
from backend.engine.library import LIBRARY, BuyAndHold
from backend.engine.metrics import compute_metrics
from backend.engine.optimize import build_grid
from backend.engine.sandbox import StrategyCodeError, load_strategy
from backend.engine.strategy import Strategy

ZERO = dict(cost=CostModel(kind="none"), slippage_pct=0.0, fractional=True)


def frame(closes, opens=None, highs=None, lows=None, start="2020-01-01"):
    closes = np.asarray(closes, float)
    opens = np.asarray(opens if opens is not None else closes, float)
    highs = np.asarray(highs if highs is not None else np.maximum(opens, closes), float)
    lows = np.asarray(lows if lows is not None else np.minimum(opens, closes), float)
    idx = pd.date_range(start, periods=len(closes), freq="B")
    return pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "volume": 1e6}, index=idx)


def test_buy_and_hold_matches_price_return_without_costs():
    df = load_synthetic("BH", "2018-01-01", "2022-12-31")
    res = Backtester({"X": df}, BuyAndHold, {}, EngineConfig(**ZERO, close_at_end=False)).run()
    # Bought at bar 1 open (signal on bar 0 close), marked at last close.
    expected = 100_000 * df["close"].iloc[-1] / df["open"].iloc[1]
    assert res["equity"].iloc[-1] == pytest.approx(expected, rel=1e-9)


def test_signal_fills_next_bar_open_no_lookahead():
    class BuyOnBar2(Strategy):
        def next(self):
            if self.bar == 2:
                self.buy()

    df = frame([10, 11, 12, 13, 14], opens=[10, 10.5, 11.5, 12.5, 13.5])
    res = Backtester({"X": df}, BuyOnBar2, {}, EngineConfig(**ZERO)).run()
    fill = res["fills"][0]
    assert fill["bar"] == 3 and fill["price"] == 12.5


def test_fill_on_close_mode():
    class BuyOnBar2(Strategy):
        def next(self):
            if self.bar == 2:
                self.buy()

    df = frame([10, 11, 12, 13, 14], opens=[10, 10.5, 11.5, 12.5, 13.5])
    res = Backtester({"X": df}, BuyOnBar2, {}, EngineConfig(**ZERO, fill_on="close")).run()
    assert res["fills"][0]["bar"] == 2 and res["fills"][0]["price"] == 12


def test_line_blocks_future_access():
    seen = {}

    class Peek(Strategy):
        def next(self):
            if self.bar == 1:
                with pytest.raises(IndexError):
                    _ = self.data.close[3]
                seen["len"] = len(self.data.close.values)

    Backtester({"X": frame([1, 2, 3, 4, 5])}, Peek, {}, EngineConfig(**ZERO)).run()
    assert seen["len"] == 2


def test_stop_loss_exits_at_stop_price():
    class Entry(Strategy):
        def next(self):
            if self.bar == 0:
                self.buy(sl=95)

    # Enter at 100 (bar 1 open); bar 3 trades down through 95 without gapping.
    df = frame([100, 100, 99, 90, 90], opens=[100, 100, 100, 98, 90], lows=[100, 99, 98, 89, 90])
    res = Backtester({"X": df}, Entry, {}, EngineConfig(**ZERO)).run()
    t = res["trades"][0]
    assert t["exit_reason"] == "stop_loss" and t["exit_price"] == 95 and t["exit_bar"] == 3


def test_stop_loss_gap_fills_at_open():
    class Entry(Strategy):
        def next(self):
            if self.bar == 0:
                self.buy(sl=95)

    df = frame([100, 100, 90, 90], opens=[100, 100, 88, 90])
    res = Backtester({"X": df}, Entry, {}, EngineConfig(**ZERO)).run()
    assert res["trades"][0]["exit_price"] == 88


def test_short_trade_profit():
    class ShortIt(Strategy):
        def next(self):
            if self.bar == 0:
                self.sell(size=10)
            elif self.bar == 2:
                self.close()

    df = frame([100, 100, 80, 80, 80])
    res = Backtester({"X": df}, ShortIt, {}, EngineConfig(**ZERO, allow_short=True)).run()
    t = res["trades"][0]
    assert t["side"] == "Short" and t["pnl"] == pytest.approx(200)
    assert res["equity"].iloc[-1] == pytest.approx(100_200)


def test_sell_without_short_permission_only_flattens():
    class S(Strategy):
        def next(self):
            self.sell()

    res = Backtester({"X": frame([1, 2, 3, 4])}, S, {}, EngineConfig(**ZERO)).run()
    assert res["fills"] == []


def test_pyramiding_limit():
    class AlwaysBuy(Strategy):
        def next(self):
            self.buy(size=5)  # 5 units (sizes in (0, 1] mean a fraction of equity)

    res = Backtester({"X": frame(np.linspace(10, 20, 30))}, AlwaysBuy, {}, EngineConfig(**ZERO, pyramiding=3)).run()
    assert sum(f["side"] == "BUY" for f in res["fills"]) == 3


def test_cash_account_never_goes_negative():
    df = load_synthetic("CASH", "2015-01-01", "2020-01-01")
    cfg = EngineConfig(cost=CostModel(kind="percent", rate=0.002), slippage_pct=0.001)
    res = Backtester({"X": df}, LIBRARY["SmaCross"], {}, cfg).run()
    assert res["cash"].min() > -1e-6


def test_india_delivery_costs():
    c = CostModel(kind="india_delivery", rate=0.0)
    buy = c("buy", 100, 1000)    # ₹1,00,000 turnover
    sell = c("sell", 100, 1000)
    # STT 100 + stamp 15 + exch 2.97 + SEBI 0.10 + GST on (exch+SEBI)
    assert buy == pytest.approx(100 + 15 + 2.97 + 0.1 + 0.18 * 3.07, abs=0.01)
    assert sell == pytest.approx(100 + 2.97 + 0.1 + 0.18 * 3.07, abs=0.01)


def test_all_library_strategies_run():
    a = load_synthetic("LIB_A", "2016-01-01", "2021-01-01")
    b = load_synthetic("LIB_B", "2016-06-01", "2021-01-01")
    for name, cls in LIBRARY.items():
        frames = {"A": a, "B": b}
        res = Backtester(frames, cls, {}, EngineConfig(allow_short=True)).run()
        assert np.isfinite(res["equity"]).all(), name
        assert res["equity"].iloc[-1] > 0, name


def test_metrics_basic():
    idx = pd.date_range("2020-01-01", periods=253, freq="B")
    eq = pd.Series(100 * 1.0004 ** np.arange(253), index=idx)
    m = compute_metrics(eq, [], 252)
    assert m["max_drawdown_pct"] == 0
    assert m["total_return_pct"] == pytest.approx((1.0004 ** 252 - 1) * 100, rel=1e-3)


def test_indicators_are_causal():
    x = np.cumsum(np.random.default_rng(0).normal(size=300)) + 100
    full = rsi(x, 14)
    part = rsi(x[:200], 14)
    np.testing.assert_allclose(full[:200], part, equal_nan=True)
    full_st, _ = supertrend(x + 1, x - 1, x, 10, 3)
    part_st, _ = supertrend(x[:200] + 1, x[:200] - 1, x[:200], 10, 3)
    np.testing.assert_allclose(full_st[:200], part_st, equal_nan=True)
    assert not np.isnan(sma(x, 20)[-1])
    assert crossover([1, 3], [2, 2]) and not crossover([3, 1], [2, 2])


def test_sandbox_loads_and_blocks():
    cls = load_strategy("class A(Strategy):\n    params = {'n': 5}\n    def next(self):\n        pass\n")
    assert cls.params == {"n": 5}
    with pytest.raises(StrategyCodeError):
        load_strategy("import os\nclass A(Strategy): pass")
    with pytest.raises(StrategyCodeError):
        load_strategy("x = open('/etc/passwd')")
    with pytest.raises(StrategyCodeError) as e:
        load_strategy("class A(Strategy):\n    def next(self)\n        pass")
    assert e.value.line == 2


def test_csv_normalisation_flexible_columns():
    raw = pd.DataFrame({
        "Date": ["01-02-2024", "02-02-2024", "05-02-2024"],
        "Open Price": [10, 11, 12], "High Price": [11, 12, 13], "Low Price": [9, 10, 11],
        "Close Price": [10.5, 11.5, 12.5], "Total Traded Quantity": [100, 200, 300],
    })
    df = normalize_ohlcv(raw)
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert df["volume"].sum() == 600 and len(df) == 3


def test_grid_builder():
    grid = build_grid(LIBRARY["SmaCross"], {"fast": {"min": 5, "max": 20, "step": 5}, "slow": [50, 100]})
    assert len(grid) == 8
    rnd = build_grid(LIBRARY["SmaCross"], {"fast": {"min": 1, "max": 100, "step": 1}}, method="random", n_iter=10)
    assert len(rnd) == 10 and len({g["fast"] for g in rnd}) == 10


def test_multi_asset_union_calendar():
    a = frame(np.linspace(10, 20, 20), start="2021-01-01")
    b = frame(np.linspace(5, 6, 15), start="2021-01-08")
    res = Backtester({"A": a, "B": b}, BuyAndHold, {}, EngineConfig(**ZERO)).run()
    assert len(res["index"]) == len(a.index.union(b.index))
    assert {f["symbol"] for f in res["fills"]} == {"A", "B"}
    assert math.isfinite(res["equity"].iloc[-1])


def test_yahoo_outage_falls_back_to_stale_cache(tmp_path, monkeypatch):
    import os
    from backend.engine import data as datamod
    monkeypatch.setattr(datamod, "CACHE_DIR", tmp_path)
    cached = load_synthetic("STALE", "2018-01-01", "2020-12-31")
    path = datamod._cache_path("STALE.NS", "1d", True)
    cached.to_csv(path)
    old = path.stat().st_mtime - 2 * datamod.CACHE_TTL_SECONDS
    os.utime(path, (old, old))                       # cache has expired

    def down(*a, **k):
        raise datamod.DataError("Yahoo Finance returned no data for 'STALE.NS'.")
    monkeypatch.setattr(datamod, "_download_yahoo", down)
    df = datamod.load_yahoo("STALE.NS", "2019-01-01", None)
    assert len(df) > 400 and df.attrs["stale_until"] == "2020-12-31"

    path.unlink()                                    # no cache at all: the error still surfaces
    with pytest.raises(datamod.DataError):
        datamod.load_yahoo("STALE.NS", "2019-01-01", None)


def test_yahoo_session_reset_is_safe():
    from backend.engine.data import _reset_yahoo_session
    _reset_yahoo_session()
    _reset_yahoo_session()


def test_buy_and_hold_ignores_default_stops_but_others_use_them():
    df = load_synthetic("BHSTOP", "2015-01-01", "2022-12-31")
    cfg = lambda: EngineConfig(**ZERO, stop_loss_pct=10, take_profit_pct=25, max_bars_in_trade=20)
    bh = Backtester({"X": df}, BuyAndHold, {}, cfg()).run()
    assert len(bh["trades"]) == 1 and bh["trades"][0]["exit_reason"] == "end_of_data"
    expected = 100_000 * df["close"].iloc[-1] / df["open"].iloc[1]
    assert bh["equity"].iloc[-1] == pytest.approx(expected, rel=1e-9)
    sma = Backtester({"X": df}, LIBRARY["SmaCross"], {}, cfg()).run()
    assert {"stop_loss", "take_profit", "time_exit"} & {t["exit_reason"] for t in sma["trades"]}


def test_explicit_stop_still_applies_without_default_exits():
    class OwnStop(Strategy):
        uses_default_exits = False
        def next(self):
            if self.bar == 0:
                self.buy(sl=95)
    df = frame([100, 100, 99, 90, 90], opens=[100, 100, 100, 98, 90], lows=[100, 99, 98, 89, 90])
    res = Backtester({"X": df}, OwnStop, {}, EngineConfig(**ZERO, stop_loss_pct=50)).run()
    assert res["trades"][0]["exit_reason"] == "stop_loss" and res["trades"][0]["exit_price"] == 95


def test_yahoo_download_has_a_time_budget(monkeypatch, tmp_path):
    import sys, time as _t, types
    from backend.engine import data as datamod

    class SlowTicker:
        def __init__(self, sym): pass
        def history(self, **kw):
            _t.sleep(5)          # simulates yfinance stuck on a rejected session
    monkeypatch.setitem(sys.modules, "yfinance", types.SimpleNamespace(Ticker=SlowTicker))
    monkeypatch.setattr(datamod, "DOWNLOAD_BUDGET_SECONDS", 1.5)
    monkeypatch.setattr(datamod, "CACHE_DIR", tmp_path)
    t0 = _t.monotonic()
    with pytest.raises(datamod.DataError, match="did not respond in time"):
        datamod.load_yahoo("SLOW.NS", "2020-01-01", None)
    assert _t.monotonic() - t0 < 3
