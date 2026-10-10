"""Built-in strategy library."""
from __future__ import annotations

import numpy as np

from .indicators import (adx, atr, bollinger, crossover, crossunder, donchian, ema, keltner, macd, roc, rsi,
                         sma, stochastic, supertrend, zscore)
from .strategy import Strategy


def _rng(lo, hi, step, kind="int"):
    return {"min": lo, "max": hi, "step": step, "type": kind}


class BuyAndHold(Strategy):
    name = "Buy & Hold"
    category = "Baseline"
    long_only = True
    description = "Buys on the first bar and holds until the end. The baseline every strategy should beat."
    params = {}

    def next(self):
        if self.position.is_flat and not getattr(self, "_done", False):
            self.buy()
            self._done = True


class SmaCross(Strategy):
    name = "SMA Crossover"
    category = "Trend following"
    description = "Long when the fast simple moving average crosses above the slow one; exit (or short) on the reverse cross."
    params = {"fast": 20, "slow": 50}
    param_space = {"fast": _rng(5, 100, 5), "slow": _rng(20, 250, 10)}

    def init(self):
        self.fast = self.I(sma, self.data.close, self.p.fast, name=f"SMA {self.p.fast}", color="#38bdf8")
        self.slow = self.I(sma, self.data.close, self.p.slow, name=f"SMA {self.p.slow}", color="#f59e0b")

    def next(self):
        if crossover(self.fast, self.slow):
            self.buy()
        elif crossunder(self.fast, self.slow):
            self.sell()


class EmaTrend(Strategy):
    name = "EMA Cross + Trend Filter"
    category = "Trend following"
    description = "EMA crossover that only trades in the direction of a long-term EMA trend filter."
    params = {"fast": 12, "slow": 26, "trend": 200}
    param_space = {"fast": _rng(5, 50, 1), "slow": _rng(10, 100, 2), "trend": _rng(50, 300, 25)}

    def init(self):
        c = self.data.close
        self.fast = self.I(ema, c, self.p.fast, name=f"EMA {self.p.fast}", color="#38bdf8")
        self.slow = self.I(ema, c, self.p.slow, name=f"EMA {self.p.slow}", color="#f59e0b")
        self.trend = self.I(ema, c, self.p.trend, name=f"EMA {self.p.trend}", color="#a78bfa")

    def next(self):
        c = self.data.close[-1]
        if crossover(self.fast, self.slow) and c > self.trend[-1]:
            self.buy()
        elif crossunder(self.fast, self.slow):
            if self.position.is_long:
                self.close()
            if c < self.trend[-1]:
                self.sell()


class RsiReversion(Strategy):
    name = "RSI Mean Reversion"
    category = "Mean reversion"
    description = "Buys when RSI is oversold, exits when RSI recovers above the exit level. Shorts overbought when enabled."
    params = {"period": 14, "oversold": 30, "overbought": 70, "exit_level": 50}
    param_space = {"period": _rng(2, 30, 1), "oversold": _rng(10, 40, 5), "overbought": _rng(60, 90, 5),
                   "exit_level": _rng(40, 60, 5)}

    def init(self):
        self.rsi = self.I(rsi, self.data.close, self.p.period, name=f"RSI {self.p.period}", overlay=False,
                          color="#c084fc")

    def next(self):
        r = self.rsi[-1]
        if self.position.is_flat:
            if r < self.p.oversold:
                self.buy()
            elif r > self.p.overbought:
                self.sell()
        elif self.position.is_long and r > self.p.exit_level:
            self.close()
        elif self.position.is_short and r < self.p.exit_level:
            self.close()


class BollingerReversion(Strategy):
    name = "Bollinger Band Reversion"
    category = "Mean reversion"
    description = "Buys a close below the lower band and exits at the middle band (mirror for shorts)."
    params = {"period": 20, "std": 2.0}
    param_space = {"period": _rng(10, 50, 5), "std": _rng(1.0, 3.0, 0.25, "float")}

    def init(self):
        self.up, self.mid, self.lo = self.I(bollinger, self.data.close, self.p.period, self.p.std,
                                            names=["BB upper", "BB mid", "BB lower"], color="#64748b")

    def next(self):
        c = self.data.close[-1]
        if self.position.is_flat:
            if c < self.lo[-1]:
                self.buy()
            elif c > self.up[-1]:
                self.sell()
        elif self.position.is_long and c >= self.mid[-1]:
            self.close()
        elif self.position.is_short and c <= self.mid[-1]:
            self.close()


class MacdCross(Strategy):
    name = "MACD Signal Cross"
    category = "Momentum"
    description = "Long when the MACD line crosses above its signal line, exit/short on the opposite cross."
    params = {"fast": 12, "slow": 26, "signal": 9}
    param_space = {"fast": _rng(6, 20, 2), "slow": _rng(20, 40, 2), "signal": _rng(5, 15, 1)}

    def init(self):
        self.macd, self.sig, self.hist = self.I(macd, self.data.close, self.p.fast, self.p.slow, self.p.signal,
                                                names=["MACD", "Signal", "Histogram"], overlay=False)

    def next(self):
        if crossover(self.macd, self.sig):
            self.buy()
        elif crossunder(self.macd, self.sig):
            self.sell()


class DonchianBreakout(Strategy):
    name = "Donchian Breakout (Turtle)"
    category = "Breakout"
    description = "Turtle-style: enter on an N-bar high breakout, exit on an M-bar low, with an ATR-based initial stop."
    params = {"entry": 20, "exit": 10, "atr_period": 20, "atr_mult": 2.0}
    param_space = {"entry": _rng(10, 60, 5), "exit": _rng(5, 30, 5), "atr_mult": _rng(1.0, 4.0, 0.5, "float")}

    def init(self):
        d = self.data
        # Shift by one bar so the breakout level excludes the current bar.
        up, _, _ = donchian(d.high._a, d.low._a, self.p.entry)
        _, _, lo = donchian(d.high._a, d.low._a, self.p.exit)
        self.upper = self.I(np.r_[np.nan, up[:-1]], name=f"Donchian high {self.p.entry}", color="#22c55e")
        self.lower = self.I(np.r_[np.nan, lo[:-1]], name=f"Donchian low {self.p.exit}", color="#ef4444")
        self.atr = self.I(atr, d.high, d.low, d.close, self.p.atr_period, name="ATR", plot=False)

    def next(self):
        c = self.data.close[-1]
        if self.position.is_flat:
            if c > self.upper[-1]:
                self.buy(sl=c - self.p.atr_mult * self.atr[-1])
            elif c < self.lower[-1]:
                self.sell(sl=c + self.p.atr_mult * self.atr[-1])
        elif self.position.is_long and c < self.lower[-1]:
            self.close()
        elif self.position.is_short and c > self.upper[-1]:
            self.close()


class SupertrendStrategy(Strategy):
    name = "Supertrend"
    category = "Trend following"
    description = "Follows the ATR-based Supertrend indicator: long in up-trends, flat/short in down-trends."
    params = {"period": 10, "multiplier": 3.0}
    param_space = {"period": _rng(5, 30, 1), "multiplier": _rng(1.0, 5.0, 0.5, "float")}

    def init(self):
        d = self.data
        line, direction = supertrend(d.high._a, d.low._a, d.close._a, self.p.period, self.p.multiplier)
        self.line = self.I(line, name="Supertrend", color="#f472b6")
        self.dir = self.I(np.where(direction == 0, np.nan, direction), name="dir", plot=False)

    def next(self):
        if self.dir[-1] > 0 and self.dir[-2] <= 0:
            self.buy()
        elif self.dir[-1] < 0 and self.dir[-2] >= 0:
            self.sell()


class TimeSeriesMomentum(Strategy):
    name = "Time-Series Momentum"
    category = "Momentum"
    description = "Holds the asset while its N-bar rate of change is above a threshold; goes flat (or short) otherwise."
    params = {"lookback": 126, "threshold": 0.0}
    param_space = {"lookback": _rng(20, 252, 21), "threshold": _rng(-5.0, 10.0, 2.5, "float")}

    def init(self):
        self.roc = self.I(roc, self.data.close, self.p.lookback, name=f"ROC {self.p.lookback}", overlay=False)

    def next(self):
        r = self.roc[-1]
        if r > self.p.threshold and not self.position.is_long:
            self.buy()
        elif r < -abs(self.p.threshold) and not self.position.is_short:
            self.sell()
        elif r <= self.p.threshold and self.position.is_long:
            self.close()


class ZScoreReversion(Strategy):
    name = "Z-Score Mean Reversion"
    category = "Mean reversion"
    description = "Statistical mean reversion: fades moves beyond ±entry standard deviations, exits near the mean."
    params = {"period": 20, "entry_z": 2.0, "exit_z": 0.5}
    param_space = {"period": _rng(10, 60, 5), "entry_z": _rng(1.0, 3.0, 0.25, "float"),
                   "exit_z": _rng(0.0, 1.0, 0.25, "float")}

    def init(self):
        self.z = self.I(zscore, self.data.close, self.p.period, name="Z-score", overlay=False, color="#2dd4bf")

    def next(self):
        z = self.z[-1]
        if self.position.is_flat:
            if z < -self.p.entry_z:
                self.buy()
            elif z > self.p.entry_z:
                self.sell()
        elif self.position.is_long and z > -self.p.exit_z:
            self.close()
        elif self.position.is_short and z < self.p.exit_z:
            self.close()


class StochasticStrategy(Strategy):
    name = "Stochastic Oscillator"
    category = "Momentum"
    description = "Buys when %K crosses above %D in the oversold zone, sells on a cross down in the overbought zone."
    params = {"k": 14, "d": 3, "oversold": 20, "overbought": 80}
    param_space = {"k": _rng(5, 30, 1), "d": _rng(2, 10, 1), "oversold": _rng(10, 30, 5), "overbought": _rng(70, 90, 5)}

    def init(self):
        d = self.data
        self.k, self.d = self.I(stochastic, d.high, d.low, d.close, self.p.k, self.p.d, names=["%K", "%D"],
                                overlay=False)

    def next(self):
        if crossover(self.k, self.d) and self.k[-1] < self.p.oversold + 10:
            self.buy()
        elif crossunder(self.k, self.d) and self.k[-1] > self.p.overbought - 10:
            self.sell()


class AdxTrend(Strategy):
    name = "ADX Directional Trend"
    category = "Trend following"
    description = "Trades +DI/-DI crossovers only when ADX confirms a strong trend."
    params = {"period": 14, "adx_min": 25}
    param_space = {"period": _rng(7, 28, 1), "adx_min": _rng(15, 40, 5)}

    def init(self):
        d = self.data
        self.adx, self.pdi, self.mdi = self.I(adx, d.high, d.low, d.close, self.p.period,
                                              names=["ADX", "+DI", "-DI"], overlay=False)

    def next(self):
        strong = self.adx[-1] > self.p.adx_min
        if crossover(self.pdi, self.mdi) and strong:
            self.buy()
        elif crossunder(self.pdi, self.mdi):
            if strong:
                self.sell()
            elif self.position.is_long:
                self.close()


class KeltnerBreakout(Strategy):
    name = "Keltner Channel Breakout"
    category = "Breakout"
    description = "Volatility breakout: long on a close above the upper Keltner channel, exit at the mid line."
    params = {"period": 20, "mult": 2.0}
    param_space = {"period": _rng(10, 50, 5), "mult": _rng(1.0, 3.5, 0.25, "float")}

    def init(self):
        d = self.data
        self.up, self.mid, self.lo = self.I(keltner, d.high, d.low, d.close, self.p.period, self.p.mult,
                                            names=["KC upper", "KC mid", "KC lower"], color="#0ea5e9")

    def next(self):
        c = self.data.close[-1]
        if self.position.is_flat:
            if c > self.up[-1]:
                self.buy()
            elif c < self.lo[-1]:
                self.sell()
        elif self.position.is_long and c < self.mid[-1]:
            self.close()
        elif self.position.is_short and c > self.mid[-1]:
            self.close()


class MomentumRotation(Strategy):
    name = "Momentum Rotation (Portfolio)"
    category = "Portfolio"
    description = ("Cross-sectional momentum: every rebalance period, ranks the universe by N-bar return and holds "
                   "the top K equally weighted. Optional absolute-momentum filter moves to cash. Needs 2+ symbols.")
    per_asset = False
    long_only = True
    params = {"lookback": 126, "top_k": 2, "rebalance_bars": 21, "absolute_filter": True}
    param_space = {"lookback": _rng(21, 252, 21), "top_k": _rng(1, 5, 1), "rebalance_bars": _rng(5, 63, 1)}

    def init(self):
        self.mom = {s: self.I(roc, d.close, self.p.lookback, name=f"ROC {s}", plot=False) for s, d in self.datas.items()}
        self._last = -10**9

    def next(self):
        if self.bar - self._last < self.p.rebalance_bars:
            return
        self._last = self.bar
        scores = {s: m[-1] for s, m in self.mom.items() if not np.isnan(m[-1])}
        ranked = sorted(scores, key=scores.get, reverse=True)[: int(self.p.top_k)]
        if self.p.absolute_filter:
            ranked = [s for s in ranked if scores[s] > 0]
        w = 0.98 / max(len(ranked), 1) if ranked else 0.0
        for s in self.symbols:
            if s not in ranked and self.get_position(s):
                self.order_target_percent(0, s, tag="rotate_out")
        for s in ranked:
            self.order_target_percent(w, s, tag="rotate_in")


class EqualWeightRebalance(Strategy):
    name = "Equal-Weight Rebalance (Portfolio)"
    category = "Portfolio"
    description = "Holds every symbol in the universe at equal weight and rebalances periodically - a diversified benchmark."
    per_asset = False
    long_only = True
    params = {"rebalance_bars": 63}
    param_space = {"rebalance_bars": _rng(5, 252, 5)}

    def init(self):
        self._last = -10**9

    def next(self):
        if self.bar - self._last < self.p.rebalance_bars:
            return
        self._last = self.bar
        live = [s for s, d in self.datas.items() if not np.isnan(d.close[-1])]
        for s in live:
            self.order_target_percent(0.98 / len(live), s, tag="rebalance")


class VolatilityTargetTrend(Strategy):
    name = "Volatility-Targeted Trend"
    category = "Risk managed"
    description = ("Long above the trend SMA (short below it when shorting is allowed), with position size scaled "
                   "so the expected annual volatility matches a target. Rebalances weekly.")
    per_asset = True
    params = {"trend": 100, "vol_lookback": 20, "target_vol": 15.0, "max_weight": 1.0, "rebalance_bars": 5}
    param_space = {"trend": _rng(50, 250, 25), "target_vol": _rng(5.0, 30.0, 2.5, "float")}

    def init(self):
        c = self.data.close
        self.trend = self.I(sma, c, self.p.trend, name=f"SMA {self.p.trend}", color="#a78bfa")
        rets = np.r_[np.nan, np.diff(np.log(c._a))]
        import pandas as pd
        vol = pd.Series(rets).rolling(self.p.vol_lookback).std().to_numpy() * np.sqrt(252) * 100
        self.vol = self.I(vol, name="Realised vol %", plot=False)
        self._last = -10**9

    def next(self):
        if self.bar - self._last < self.p.rebalance_bars:
            return
        self._last = self.bar
        n = len(self.symbols)
        if not self.vol[-1] > 0:
            return
        w = min(self.p.target_vol / self.vol[-1], self.p.max_weight) / n
        above = self.data.close[-1] > self.trend[-1]
        if above and self.can_long:
            self.order_target_percent(w, tag="vol_target")
        elif not above and self.can_short:
            self.order_target_percent(-w, tag="vol_target_short")
        elif self.position:
            self.order_target_percent(0, tag="trend_exit")


LIBRARY: dict[str, type[Strategy]] = {cls.__name__: cls for cls in [
    BuyAndHold, SmaCross, EmaTrend, MacdCross, SupertrendStrategy, AdxTrend, TimeSeriesMomentum,
    RsiReversion, BollingerReversion, ZScoreReversion, StochasticStrategy, DonchianBreakout, KeltnerBreakout,
    VolatilityTargetTrend, MomentumRotation, EqualWeightRebalance,
]}


def describe(cls: type[Strategy], key: str | None = None, source: str | None = None) -> dict:
    space = {}
    for k, v in cls.params.items():
        hint = dict(cls.param_space.get(k, {}))
        if not hint:
            if isinstance(v, bool):
                hint = {"type": "bool"}
            elif isinstance(v, int):
                hint = {"type": "int", "min": max(1, v // 4), "max": v * 3, "step": max(1, v // 10)}
            elif isinstance(v, float):
                hint = {"type": "float", "min": round(v / 4, 3), "max": round(v * 3, 3), "step": round(max(v / 10, 0.01), 3)}
            else:
                hint = {"type": "str"}
        hint.setdefault("type", "bool" if isinstance(v, bool) else "float" if isinstance(v, float) else "int")
        space[k] = {"default": v, **hint}
    return {"id": key or cls.__name__, "name": cls.name, "category": cls.category, "description": cls.description,
            "params": space, "per_asset": cls.per_asset, "long_only": bool(getattr(cls, "long_only", False)),
            "source": source}
