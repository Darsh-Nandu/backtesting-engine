"""Strategy API.

Write a strategy by subclassing :class:`Strategy`::

    class SmaCross(Strategy):
        name = "SMA Crossover"
        params = {"fast": 20, "slow": 50}

        def init(self):
            self.fast = self.I(sma, self.data.close, self.p.fast, name=f"SMA {self.p.fast}")
            self.slow = self.I(sma, self.data.close, self.p.slow, name=f"SMA {self.p.slow}")

        def next(self):
            if crossover(self.fast, self.slow):
                self.buy()
            elif crossunder(self.fast, self.slow):
                self.sell()

``init`` runs once with the *full* history available for vectorised
indicator computation (indicators must be causal - all built-ins are).
``next`` runs on every bar and only ever sees data up to the current bar:
``self.data.close[-1]`` is the latest close, ``[-2]`` the previous one.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Callable

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    from .core import Backtester


class Clock:
    __slots__ = ("i",)

    def __init__(self):
        self.i = 0


class Line:
    """A look-ahead-safe view over a numpy array driven by the engine clock."""

    __slots__ = ("_a", "_c", "name")

    def __init__(self, arr: np.ndarray, clock: Clock, name: str = ""):
        self._a = arr
        self._c = clock
        self.name = name

    # --- indexing ------------------------------------------------------- #
    def __getitem__(self, k):
        i = self._c.i
        if isinstance(k, slice):
            return self._a[: i + 1][k]
        if k < 0:
            j = i + 1 + k
            if j < 0:
                raise IndexError("Line index out of range")
            return self._a[j]
        if k > i:
            raise IndexError("Look-ahead access is not allowed")
        return self._a[k]

    def __len__(self):
        return self._c.i + 1

    def __array__(self, dtype=None, copy=None):
        a = self._a[: self._c.i + 1]
        return a.astype(dtype) if dtype else a

    @property
    def values(self) -> np.ndarray:
        return self._a[: self._c.i + 1]

    @property
    def now(self) -> float:
        return float(self._a[self._c.i])

    def __float__(self):
        return self.now

    def __repr__(self):
        return f"Line({self.name or '?'}={self.now:.4f} @bar {self._c.i})"

    # --- comparisons/arithmetic on the current value -------------------- #
    def _v(self, o):
        return o.now if isinstance(o, Line) else o

    def __gt__(self, o): return self.now > self._v(o)
    def __ge__(self, o): return self.now >= self._v(o)
    def __lt__(self, o): return self.now < self._v(o)
    def __le__(self, o): return self.now <= self._v(o)
    def __add__(self, o): return self.now + self._v(o)
    def __radd__(self, o): return self._v(o) + self.now
    def __sub__(self, o): return self.now - self._v(o)
    def __rsub__(self, o): return self._v(o) - self.now
    def __mul__(self, o): return self.now * self._v(o)
    def __rmul__(self, o): return self._v(o) * self.now
    def __truediv__(self, o): return self.now / self._v(o)
    def __rtruediv__(self, o): return self._v(o) / self.now
    def __neg__(self): return -self.now


class DataView:
    """OHLCV for one symbol, exposed as :class:`Line` objects."""

    def __init__(self, symbol: str, frame, clock: Clock):
        self.symbol = symbol
        self._clock = clock
        self._frame = frame
        self.index = frame.index
        self.open = Line(frame["open"].to_numpy(float), clock, "open")
        self.high = Line(frame["high"].to_numpy(float), clock, "high")
        self.low = Line(frame["low"].to_numpy(float), clock, "low")
        self.close = Line(frame["close"].to_numpy(float), clock, "close")
        self.volume = Line(frame["volume"].to_numpy(float), clock, "volume")

    @property
    def i(self) -> int:
        return self._clock.i

    @property
    def time(self):
        return self.index[self._clock.i]

    @property
    def df(self):
        """Pandas frame of all bars up to (and including) the current one."""
        return self._frame.iloc[: self._clock.i + 1]

    def __len__(self):
        return self._clock.i + 1


class PositionView:
    """Read-only snapshot of a strategy's position in one symbol."""

    def __init__(self, engine: "Backtester", symbol: str):
        self._e, self._s = engine, symbol

    @property
    def _p(self):
        return self._e.broker.positions.get(self._s)

    @property
    def qty(self) -> float:
        p = self._p
        return p.qty if p else 0.0

    size = qty

    @property
    def avg_price(self) -> float:
        p = self._p
        return p.avg_price if p else 0.0

    @property
    def is_long(self) -> bool:
        return self.qty > 0

    @property
    def is_short(self) -> bool:
        return self.qty < 0

    @property
    def is_flat(self) -> bool:
        return self.qty == 0

    @property
    def pnl(self) -> float:
        p = self._p
        if not p or p.qty == 0:
            return 0.0
        return (self._e.price(self._s) - p.avg_price) * p.qty

    @property
    def pnl_pct(self) -> float:
        p = self._p
        if not p or p.qty == 0:
            return 0.0
        return (self._e.price(self._s) / p.avg_price - 1) * (1 if p.qty > 0 else -1) * 100

    @property
    def bars_held(self) -> int:
        p = self._p
        return (self._e.clock.i - p.entry_bar) if p and p.qty else 0

    def __bool__(self):
        return self.qty != 0

    def __repr__(self):
        return f"Position({self._s} qty={self.qty:g} avg={self.avg_price:.4f})"


class Strategy:
    """Base class for all strategies."""

    name: str = "Unnamed strategy"
    description: str = ""
    category: str = "Custom"
    params: dict[str, Any] = {}
    # Optional UI hints / optimisation ranges: {"fast": {"min": 5, "max": 100, "step": 5}}
    param_space: dict[str, dict] = {}
    # True: one instance per symbol. False: one instance trades the whole universe.
    per_asset: bool = True
    # True for strategies that only ever buy (the UI warns when combined with "Short only").
    long_only: bool = False

    def __init__(self, engine: "Backtester", data: DataView, universe: dict[str, DataView], params: dict):
        self._engine = engine
        self.data = data
        self.datas = universe
        self.symbols = list(universe)
        merged = {**type(self).params, **(params or {})}
        self.p = SimpleNamespace(**merged)
        self.position = PositionView(engine, data.symbol)
        self._indicators: list[dict] = []
        self._warmup = 0
        self._starved: list[str] = []   # indicators that never got enough data to produce a value

    # ------------------------------------------------------------------ #
    # Hooks
    # ------------------------------------------------------------------ #
    def init(self):  # pragma: no cover - overridden
        pass

    def next(self):  # pragma: no cover - overridden
        pass

    def on_trade(self, trade: dict):  # optional callback when a trade closes
        pass

    # ------------------------------------------------------------------ #
    # Indicators
    # ------------------------------------------------------------------ #
    def I(self, func: Callable | np.ndarray, *args, name: str | None = None, overlay: bool | None = None,
          color: str | None = None, plot: bool = True, names: list[str] | None = None, **kwargs):
        """Declare an indicator; returns a :class:`Line` (or a tuple of them).

        ``func`` may be a callable (called with full-history arrays) or a
        pre-computed array. ``Line`` arguments are expanded to full arrays.
        """
        if callable(func):
            full_args = [a._a if isinstance(a, Line) else a for a in args]
            full_kwargs = {k: (v._a if isinstance(v, Line) else v) for k, v in kwargs.items()}
            out = func(*full_args, **full_kwargs)
            base = name or getattr(func, "__name__", "indicator").upper()
        else:
            out = func
            base = name or "indicator"
        outs = out if isinstance(out, tuple) else (out,)
        n = len(self.data.index)
        lines = []
        for k, arr in enumerate(outs):
            arr = np.asarray(arr, dtype=float)
            if arr.shape[0] != n:
                raise ValueError(f"Indicator {base} has length {arr.shape[0]}, expected {n}")
            label = (names[k] if names and k < len(names) else
                     base if len(outs) == 1 else f"{base} [{k + 1}]")
            valid = np.flatnonzero(~np.isnan(arr))
            first = int(valid[0]) if valid.size else n
            # Warm-up: don't call next() until every indicator has a value.
            # Indicators that never become valid (all NaN) are ignored.
            if valid.size:
                self._warmup = max(self._warmup, first)
            elif label not in self._starved:
                self._starved.append(label)
            if plot:
                ov = overlay
                if ov is None:
                    close = self.data.close._a
                    with np.errstate(all="ignore"):
                        ratio = np.nanmedian(arr / close) if valid.size else 0
                    ov = bool(0.6 < ratio < 1.6)
                self._indicators.append({"name": label, "values": arr, "overlay": ov, "color": color,
                                         "symbol": self.data.symbol})
            lines.append(Line(arr, self._engine.clock, label))
        return tuple(lines) if len(lines) > 1 else lines[0]

    # ------------------------------------------------------------------ #
    # Orders
    # ------------------------------------------------------------------ #
    def buy(self, size: float | None = None, symbol: str | None = None, limit: float | None = None,
            stop: float | None = None, sl: float | None = None, tp: float | None = None,
            trail: float | None = None, tag: str = "", valid_bars: int | None = None):
        """Go / add long. Closes an open short first.

        ``size``: ``None`` → engine sizing rule, ``0 < size <= 1`` → fraction
        of the allocated equity, ``size > 1`` → number of units.
        ``sl``/``tp``: absolute prices. ``trail``: trailing stop in percent.
        """
        return self._engine.broker.submit(symbol or self.data.symbol, +1, "entry", size=size, limit=limit,
                                          stop=stop, sl=sl, tp=tp, trail=trail, tag=tag, valid_bars=valid_bars,
                                          owner=self)

    def sell(self, size: float | None = None, symbol: str | None = None, limit: float | None = None,
             stop: float | None = None, sl: float | None = None, tp: float | None = None,
             trail: float | None = None, tag: str = "", valid_bars: int | None = None):
        """Close a long; go / add short when short selling is enabled."""
        return self._engine.broker.submit(symbol or self.data.symbol, -1, "entry", size=size, limit=limit,
                                          stop=stop, sl=sl, tp=tp, trail=trail, tag=tag, valid_bars=valid_bars,
                                          owner=self)

    def close(self, symbol: str | None = None, tag: str = "signal"):
        """Flatten the position at the next fill."""
        return self._engine.broker.submit(symbol or self.data.symbol, 0, "close", tag=tag, owner=self)

    def order_target_percent(self, weight: float, symbol: str | None = None, tag: str = ""):
        """Rebalance a symbol to ``weight`` × total equity (negative = short)."""
        return self._engine.broker.submit(symbol or self.data.symbol, 0, "target_pct", size=weight, tag=tag,
                                          owner=self)

    def order_target_qty(self, qty: float, symbol: str | None = None, tag: str = ""):
        return self._engine.broker.submit(symbol or self.data.symbol, 0, "target_qty", size=qty, tag=tag,
                                          owner=self)

    def cancel_orders(self, symbol: str | None = None):
        self._engine.broker.cancel(symbol or self.data.symbol)

    def set_stops(self, sl: float | None = None, tp: float | None = None, symbol: str | None = None):
        """Move the stop-loss / take-profit of the open position."""
        p = self._engine.broker.positions.get(symbol or self.data.symbol)
        if p and p.qty:
            if sl is not None:
                p.sl = sl
            if tp is not None:
                p.tp = tp

    # ------------------------------------------------------------------ #
    # Account helpers
    # ------------------------------------------------------------------ #
    def get_position(self, symbol: str) -> PositionView:
        return PositionView(self._engine, symbol)

    @property
    def can_long(self) -> bool:
        """Whether the trading rules allow opening long positions."""
        return self._engine.cfg.allow_long

    @property
    def can_short(self) -> bool:
        """Whether the trading rules allow opening short positions."""
        return self._engine.cfg.allow_short

    @property
    def equity(self) -> float:
        return self._engine.broker.equity

    @property
    def cash(self) -> float:
        return self._engine.broker.cash

    @property
    def bar(self) -> int:
        return self._engine.clock.i

    @property
    def time(self):
        return self.data.time

    def log(self, *msg):
        self._engine.log(self.data.symbol, " ".join(str(m) for m in msg))
