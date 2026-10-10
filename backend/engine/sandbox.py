"""Load user-written strategies from source code.

The code runs in a namespace pre-populated with the Strategy API, all
indicators, ``np``, ``pd`` and ``math``. Imports are limited to a small
allow-list of numerical modules and dangerous builtins are removed.

NOTE: this is a guard-rail against accidents, **not** a security boundary.
The server binds to localhost by default - never expose the API publicly
while custom code execution is enabled.
"""
from __future__ import annotations

import builtins
import math

import numpy as np
import pandas as pd

from . import indicators
from .strategy import Strategy

ALLOWED_MODULES = {"math", "numpy", "pandas", "statistics", "itertools", "functools", "collections",
                   "datetime", "random", "dataclasses", "typing", "enum", "operator", "bisect", "heapq"}
_BLOCKED = {"open", "exec", "eval", "compile", "input", "breakpoint", "exit", "quit", "help", "globals",
            "vars", "memoryview", "__loader__", "__spec__"}


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED_MODULES and not root.startswith("backend"):
        raise ImportError(f"Import of '{name}' is not allowed in strategy code. "
                          f"Allowed: {', '.join(sorted(ALLOWED_MODULES))}")
    return builtins.__import__(name, globals, locals, fromlist, level)


def _namespace() -> dict:
    safe_builtins = {k: getattr(builtins, k) for k in dir(builtins) if k not in _BLOCKED and not k.startswith("_")}
    safe_builtins["__import__"] = _safe_import
    safe_builtins["__build_class__"] = builtins.__build_class__
    safe_builtins["__name__"] = "user_strategy"
    ns = {"__builtins__": safe_builtins, "__name__": "user_strategy", "Strategy": Strategy, "np": np, "pd": pd,
          "math": math}
    for k in indicators.__all__:
        ns[k] = getattr(indicators, k)
    ns["_rng"] = lambda lo, hi, step, kind="int": {"min": lo, "max": hi, "step": step, "type": kind}
    return ns


class StrategyCodeError(Exception):
    def __init__(self, msg: str, line: int | None = None):
        super().__init__(msg)
        self.line = line


def load_strategy(code: str) -> type[Strategy]:
    ns = _namespace()
    try:
        compiled = compile(code, "<strategy>", "exec")
    except SyntaxError as e:
        raise StrategyCodeError(f"SyntaxError: {e.msg} (line {e.lineno})", e.lineno) from e
    try:
        exec(compiled, ns)
    except Exception as e:
        line = None
        tb = e.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == "<strategy>":
                line = tb.tb_lineno
            tb = tb.tb_next
        raise StrategyCodeError(f"{type(e).__name__}: {e}" + (f" (line {line})" if line else ""), line) from e
    found = [v for v in ns.values() if isinstance(v, type) and issubclass(v, Strategy) and v is not Strategy]
    if not found:
        raise StrategyCodeError("No Strategy subclass found. Define `class MyStrategy(Strategy): ...`")
    cls = found[-1]
    if not cls.name or cls.name == Strategy.name:
        cls.name = cls.__name__
    return cls


TEMPLATE = '''class MyStrategy(Strategy):
    """RSI + trend filter with ATR stops - edit me!

    init()  runs once: declare indicators with self.I(func, *args).
    next()  runs every bar: self.data.close[-1] is the latest close.
    Orders: self.buy(), self.sell(), self.close(),
            self.order_target_percent(w), with optional sl=/tp=/trail=.
    """
    name = "My RSI Trend Strategy"
    params = {"rsi_period": 14, "rsi_entry": 35, "rsi_exit": 65, "trend": 200, "atr_mult": 2.5}

    def init(self):
        d = self.data
        self.rsi = self.I(rsi, d.close, self.p.rsi_period, name="RSI", overlay=False)
        self.trend = self.I(ema, d.close, self.p.trend, name=f"EMA {self.p.trend}")
        self.atr = self.I(atr, d.high, d.low, d.close, 14, name="ATR", plot=False)

    def next(self):
        price = self.data.close[-1]
        uptrend = price > self.trend[-1]

        if self.position.is_flat and uptrend and self.rsi[-1] < self.p.rsi_entry:
            stop = price - self.p.atr_mult * self.atr[-1]
            self.buy(sl=stop, tag="rsi_dip")

        elif self.position.is_long and (self.rsi[-1] > self.p.rsi_exit or not uptrend):
            self.close()
'''
