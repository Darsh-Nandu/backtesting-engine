"""Trading-rule constraints enforced by the broker."""
import numpy as np
import pandas as pd
import pytest

from backend.engine.core import Backtester, EngineConfig, TradingRules
from backend.engine.costs import CostModel
from backend.engine.data import load_synthetic
from backend.engine.library import LIBRARY
from backend.engine.strategy import Strategy

ZERO = dict(cost=CostModel(kind="none"), slippage_pct=0.0, fractional=True)


class AlwaysLong(Strategy):
    """Wants to be long on every bar (lets the rules do the limiting)."""
    def next(self):
        if self.position.is_flat:
            self.buy()


def daily(closes, opens=None, start="2021-01-04"):
    closes = np.asarray(closes, float)
    opens = np.asarray(opens if opens is not None else closes, float)
    idx = pd.date_range(start, periods=len(closes), freq="B")
    return pd.DataFrame({"open": opens, "high": np.maximum(opens, closes) * 1.001,
                         "low": np.minimum(opens, closes) * 0.999, "close": closes, "volume": 1e6}, index=idx)


def intraday(days=3, start="2021-01-04 09:15", step="15min", bars_per_day=25):
    idx = []
    for d in pd.bdate_range(start[:10], periods=days):
        idx += list(pd.date_range(d + pd.Timedelta(start[11:] + ":00"), periods=bars_per_day, freq=step))
    idx = pd.DatetimeIndex(idx)
    px = 100 + np.cumsum(np.random.default_rng(1).normal(0, 0.2, len(idx)))
    return pd.DataFrame({"open": px, "high": px + 0.1, "low": px - 0.1, "close": px, "volume": 1e5}, index=idx)


def run(frames, cls, **rules):
    cfg = EngineConfig(**ZERO, rules=TradingRules(**rules))
    return Backtester(frames, cls, {}, cfg).run()


def test_short_only_and_long_only():
    df = load_synthetic("DIR", "2016-01-01", "2022-01-01")
    short = run({"X": df}, LIBRARY["SmaCross"], direction="short")
    assert short["trades"] and all(t["side"] == "Short" for t in short["trades"])
    long_ = run({"X": df}, LIBRARY["SmaCross"], direction="long")
    assert long_["trades"] and all(t["side"] == "Long" for t in long_["trades"])
    both = run({"X": df}, LIBRARY["SmaCross"], direction="both")
    assert {t["side"] for t in both["trades"]} == {"Long", "Short"}


def test_daily_square_off_on_daily_bars_enters_open_exits_close():
    df = daily(np.linspace(100, 120, 15), opens=np.linspace(99.5, 119.5, 15))
    res = run({"X": df}, AlwaysLong, square_off=True)
    assert len(res["trades"]) >= 10
    for t in res["trades"]:
        if t["exit_reason"] == "square_off":
            assert t["bars_held"] == 0
            assert t["entry_price"] == pytest.approx(df["open"].iloc[t["entry_bar"]])
            assert t["exit_price"] == pytest.approx(df["close"].iloc[t["exit_bar"]])
    assert res["rule_events"]["square_off"] >= 10


def test_intraday_square_off_time_and_entry_window():
    df = intraday(days=4)
    res = run({"X": df}, AlwaysLong, square_off=True, square_off_time="14:30", entry_start="09:45", entry_end="14:00")
    days = df.index.normalize()
    for f in res["fills"]:
        t = f["time"]
        if f["side"] == "BUY":
            assert "09:45" <= t.strftime("%H:%M") <= "14:00"
    # Never hold overnight: every trade opens and closes on the same day, by the cut-off.
    for t in res["trades"]:
        assert days[t["entry_bar"]] == days[t["exit_bar"]]
        assert df.index[t["exit_bar"]].strftime("%H:%M") <= "14:30"
    assert res["rule_events"].get("square_off") == 4


def test_daily_capital_limit_amount():
    class BuyEveryBar(Strategy):
        def next(self):
            self.buy(size=100)  # 100 units ≈ ₹10,000 at 100, above the ₹7,500 daily budget

    df = daily(np.full(8, 100.0))
    res = run({"X": df}, BuyEveryBar, daily_capital_limit=7_500)
    from collections import defaultdict
    spent = defaultdict(float)
    for f in res["fills"]:
        if f["side"] == "BUY":
            spent[f["time"].date()] += f["qty"] * f["price"]
    assert spent and max(spent.values()) <= 7_500 + 1e-6
    assert res["rule_events"]["capped_daily_capital"] > 0


class Pyramid(Strategy):
    def next(self):
        self.buy(size=100)


def test_max_trades_per_day():
    df = intraday(days=2)
    res = Backtester({"X": df}, Pyramid, {}, EngineConfig(**ZERO, pyramiding=100,
                     rules=TradingRules(max_trades_per_day=3))).run()
    per_day = pd.Series([f["time"].date() for f in res["fills"] if f["side"] == "BUY"]).value_counts()
    assert per_day.max() == 3


def test_max_open_positions():
    frames = {s: load_synthetic(s, "2018-01-01", "2020-01-01") for s in ("A", "B", "C")}
    res = run(frames, AlwaysLong, max_open_positions=1)
    held = {}
    events = sorted([(t["entry_bar"], 1) for t in res["trades"]] + [(t["exit_bar"], -1) for t in res["trades"]],
                    key=lambda e: (e[0], e[1]))
    open_n = 0
    for _, d in events:
        open_n += d
        assert open_n <= 1
    assert res["rule_events"]["blocked_max_open_positions"] > 0


def test_max_position_pct():
    df = daily(np.full(5, 100.0))
    res = run({"X": df}, AlwaysLong, max_position_pct=25)
    buy = next(f for f in res["fills"] if f["side"] == "BUY")
    assert buy["qty"] * buy["price"] == pytest.approx(25_000, rel=1e-6)


def test_daily_loss_limit_flattens_and_halts_for_the_day():
    # Intraday: price falls 3% shortly after entry on day 1.
    df = intraday(days=2)
    df.loc[df.index[5]:df.index[24], ["open", "high", "low", "close"]] *= 0.97
    res = run({"X": df}, AlwaysLong, daily_loss_limit_pct=2)
    hits = [t for t in res["trades"] if t["exit_reason"] == "daily_loss_limit"]
    assert hits
    day1 = df.index[0].date()
    later_buys = [f for f in res["fills"] if f["side"] == "BUY" and f["time"].date() == day1 and f["bar"] > hits[0]["exit_bar"]]
    assert later_buys == []


def test_drawdown_kill_switch_stops_trading():
    df = load_synthetic("KILL", "2015-01-01", "2022-01-01")
    res = run({"X": df}, LIBRARY["SmaCross"], max_drawdown_stop_pct=10)
    stop = [t for t in res["trades"] if t["exit_reason"] == "max_drawdown_stop"]
    assert len(stop) <= 1
    if stop:
        assert all(f["bar"] <= stop[0]["exit_bar"] for f in res["fills"])


def test_cooldown_bars():
    class Flip(Strategy):
        def next(self):
            if self.position.is_flat:
                self.buy()
            else:
                self.close()

    df = daily(np.linspace(100, 110, 30))
    res = run({"X": df}, Flip, cooldown_bars=5)
    trades = res["trades"]
    for a, b in zip(trades, trades[1:]):
        assert b["entry_bar"] - a["exit_bar"] >= 5


def test_fixed_sizing_base_does_not_reinvest_profits():
    df = daily(np.r_[np.full(3, 100.0), np.full(3, 200.0), np.full(4, 200.0)])

    class TwoTrades(Strategy):
        def next(self):
            if self.bar in (0, 6):
                self.buy()
            elif self.bar == 4:
                self.close()

    fixed = run({"X": df}, TwoTrades, sizing_base="fixed")
    comp = run({"X": df}, TwoTrades, sizing_base="compound")
    second_fixed = [f for f in fixed["fills"] if f["side"] == "BUY"][1]
    second_comp = [f for f in comp["fills"] if f["side"] == "BUY"][1]
    assert second_fixed["qty"] * second_fixed["price"] == pytest.approx(100_000, rel=1e-6)
    assert second_comp["qty"] * second_comp["price"] == pytest.approx(200_000, rel=1e-6)


def test_square_off_closes_symbols_missing_the_last_bar():
    a = intraday(days=3)
    b = a.drop(index=[t for t in a.index if t.strftime("%H:%M") >= "14:45"])  # B stops trading early each day
    res = run({"A": a, "B": b}, AlwaysLong, square_off=True)
    days = a.index.normalize()
    assert res["trades"]
    for t in res["trades"]:
        assert days[t["entry_bar"]] == days[t["exit_bar"]]


def test_direction_blocks_are_counted_and_explained():
    from backend.engine.runner import explain_no_trades
    df = load_synthetic("EXPLAIN", "2016-01-01", "2020-01-01")
    cfg = EngineConfig(**ZERO, rules=TradingRules(direction="short"))
    res = Backtester({"X": df}, LIBRARY["BuyAndHold"], {}, cfg).run()
    assert res["trades"] == [] and res["rule_events"]["blocked_long_signal"] >= 1
    msg = explain_no_trades(LIBRARY["BuyAndHold"], cfg, res)
    assert "Short only" in msg


def test_explains_insufficient_history():
    from backend.engine.runner import explain_no_trades
    df = load_synthetic("SHORTHIST", "2020-01-01", "2020-03-01")
    cfg = EngineConfig(**ZERO)
    res = Backtester({"X": df}, LIBRARY["SmaCross"], {"fast": 50, "slow": 200}, cfg).run()
    msg = explain_no_trades(LIBRARY["SmaCross"], cfg, res)
    assert "SMA 200" in msg and "enough history" in msg


def test_vol_target_trend_shorts_when_allowed():
    df = load_synthetic("VTT", "2015-01-01", "2023-01-01")
    short = run({"X": df}, LIBRARY["VolatilityTargetTrend"], direction="short")
    long_ = run({"X": df}, LIBRARY["VolatilityTargetTrend"], direction="long")
    assert short["trades"] and all(t["side"] == "Short" for t in short["trades"])
    assert long_["trades"] and all(t["side"] == "Long" for t in long_["trades"])
