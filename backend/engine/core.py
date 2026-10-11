"""Event-driven, multi-asset backtesting core.

Bar life-cycle (for every bar ``i`` of the unified calendar)::

    1. fill pending orders        - market @ open, limit/stop vs. bar range
    2. bracket exits              - stop-loss / take-profit / trailing / time
    3. mark-to-market at close    - equity, exposure
    4. daily square-off           - if the rules ask for it on this bar
    5. strategy.next()            - may submit new orders
    6. (fill_on="close") fill new market orders at this bar's close
    7. daily loss/profit stops and the drawdown kill switch

Orders submitted on bar ``i`` therefore execute at bar ``i+1``'s open by
default, which avoids the most common source of look-ahead bias.

Trading rules (:class:`TradingRules`) are enforced by the broker for every
strategy: allowed direction, daily capital/trade limits, position caps, entry
time windows, daily square-off, daily loss/profit stops, a drawdown kill switch,
re-entry cooldowns and whether profits are reinvested.
"""
from __future__ import annotations

import math
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .costs import CostModel
from .sandbox import StrategyCodeError
from .strategy import Clock, DataView, Strategy


def _strategy_error(e: Exception, where: str, st: Strategy, when=None) -> StrategyCodeError:
    """Turn an exception raised inside strategy code into a readable message pointing at the user's line."""
    line, tb = None, e.__traceback__
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "<strategy>":
            line = tb.tb_lineno
        tb = tb.tb_next
    at = f" on line {line}" if line else ""
    bar = f" at bar {when:%Y-%m-%d %H:%M}".replace(" 00:00", "") if when is not None else ""
    return StrategyCodeError(f"{type(e).__name__} in {where}{at}{bar} ({st.data.symbol}): {e}", line)


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
@dataclass
class TradingRules:
    """Portfolio-level constraints enforced on top of any strategy. 0 / "" = off."""
    direction: str = ""                  # "both" | "long" | "short"  ("" → from EngineConfig.allow_short)
    sizing_base: str = "compound"        # "compound": size from current equity · "fixed": from initial capital
    square_off: bool = False             # flatten everything at the end of each trading day
    square_off_time: str = ""            # "HH:MM" intraday cut-off; empty = last bar of the day
    entry_start: str = ""                # "HH:MM" no new entries before (intraday data only)
    entry_end: str = ""                  # "HH:MM" no new entries after (intraday data only)
    daily_capital_limit: float = 0.0     # max new exposure opened per day
    daily_capital_mode: str = "amount"   # "amount" (currency) | "pct" (of equity at the start of the day)
    max_trades_per_day: int = 0          # max entry fills per day
    max_open_positions: int = 0          # max symbols held at once
    max_position_pct: float = 0.0        # max exposure per symbol, % of equity
    daily_loss_limit_pct: float = 0.0    # flatten and stop for the day after losing this much
    daily_profit_target_pct: float = 0.0 # flatten and stop for the day after making this much
    max_drawdown_stop_pct: float = 0.0   # flatten and stop trading for good at this drawdown
    cooldown_bars: int = 0               # bars to wait after closing a symbol before re-entering it

    def active(self) -> list[str]:
        out = []
        if self.direction == "long":
            out.append("Long only")
        elif self.direction == "short":
            out.append("Short only")
        if self.sizing_base == "fixed":
            out.append("Size from initial capital")
        if self.square_off:
            out.append(f"Square off daily{' at ' + self.square_off_time if self.square_off_time else ''}")
        if self.entry_start or self.entry_end:
            out.append(f"Entries {self.entry_start or 'open'}-{self.entry_end or 'close'}")
        if self.daily_capital_limit:
            amt = (f"{self.daily_capital_limit:g}% of equity" if self.daily_capital_mode == "pct"
                   else f"{self.daily_capital_limit:,.0f}")
            out.append(f"New capital ≤ {amt}/day")
        if self.max_trades_per_day:
            out.append(f"≤ {self.max_trades_per_day} trades/day")
        if self.max_open_positions:
            out.append(f"≤ {self.max_open_positions} open positions")
        if self.max_position_pct:
            out.append(f"Position ≤ {self.max_position_pct:g}% of equity")
        if self.daily_loss_limit_pct:
            out.append(f"Daily loss stop {self.daily_loss_limit_pct:g}%")
        if self.daily_profit_target_pct:
            out.append(f"Daily profit target {self.daily_profit_target_pct:g}%")
        if self.max_drawdown_stop_pct:
            out.append(f"Drawdown kill switch {self.max_drawdown_stop_pct:g}%")
        if self.cooldown_bars:
            out.append(f"Cooldown {self.cooldown_bars} bars")
        return out


def _minutes(hhmm: str) -> int | None:
    try:
        h, m = hhmm.strip().split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


@dataclass
class EngineConfig:
    initial_capital: float = 100_000.0
    cost: CostModel = field(default_factory=CostModel)
    slippage_pct: float = 0.0005          # adverse slippage on market/stop fills (0.05%)
    fill_on: str = "next_open"            # "next_open" | "close"
    allow_short: bool = False
    leverage: float = 1.0
    fractional: bool = False
    lot_size: float = 1.0
    sizing_mode: str = "percent"          # percent | fixed_qty | fixed_cash | risk
    sizing_value: float = 100.0           # % of allocation | units | cash | % equity at risk
    pyramiding: int = 1                   # max same-direction entries per position
    stop_loss_pct: float = 0.0            # default bracket, 0 = disabled
    take_profit_pct: float = 0.0
    trailing_pct: float = 0.0
    max_bars_in_trade: int = 0
    max_volume_pct: float = 0.0           # cap fill at % of bar volume (0 = off)
    close_at_end: bool = True
    risk_free_rate: float = 0.0           # annual, for Sharpe/Sortino
    periods_per_year: float = 252.0
    rules: TradingRules = field(default_factory=TradingRules)

    def __post_init__(self):
        r = self.rules
        if r.direction not in ("both", "long", "short"):
            r.direction = "both" if self.allow_short else "long"
        self.allow_short = r.direction != "long"

    @property
    def allow_long(self) -> bool:
        return self.rules.direction != "short"


# --------------------------------------------------------------------------- #
# Broker objects
# --------------------------------------------------------------------------- #
@dataclass
class Order:
    id: int
    symbol: str
    side: int                     # +1 buy, -1 sell, 0 resolved at fill (close/target)
    intent: str                   # entry | close | target_pct | target_qty
    size: float | None = None
    limit: float | None = None
    stop: float | None = None
    sl: float | None = None
    tp: float | None = None
    trail: float | None = None
    tag: str = ""
    created_bar: int = 0
    valid_until: int | None = None
    owner: Any = None

    @property
    def kind(self) -> str:
        if self.limit is not None and self.stop is not None:
            return "stop_limit"
        if self.limit is not None:
            return "limit"
        if self.stop is not None:
            return "stop"
        return "market"


@dataclass
class Position:
    symbol: str
    qty: float = 0.0
    avg_price: float = 0.0
    entry_bar: int = 0
    entry_time: Any = None
    entry_fees: float = 0.0       # fees not yet allocated to closed trades
    entries: int = 0
    sl: float | None = None
    tp: float | None = None
    trail: float | None = None    # percent
    peak: float = 0.0             # best price since entry (for trailing / MFE)
    trough: float = 0.0           # worst price since entry (MAE)
    tag: str = ""
    default_exits: bool = True    # whether the global default stops / time exit apply


class Broker:
    def __init__(self, engine: "Backtester"):
        self.e = engine
        self.cfg = engine.cfg
        self.cash = engine.cfg.initial_capital
        self.positions: dict[str, Position] = {s: Position(s) for s in engine.symbols}
        self.orders: list[Order] = []
        self.trades: list[dict] = []
        self.fills: list[dict] = []
        self.total_fees = 0.0
        self._oid = 0
        self.equity = self.cash
        # Trading-rule state
        self.rules = engine.cfg.rules
        self.rule_stats: Counter = Counter()
        self.day_key = None
        self.day_start_equity = self.cash
        self.day_notional = 0.0
        self.day_entries = 0
        self.halted_today = False
        self.halted_forever = False
        self.peak_equity = self.cash
        self.last_exit_bar: dict[str, int] = {}
        self._entry_start = _minutes(self.rules.entry_start) if self.rules.entry_start else None
        self._entry_end = _minutes(self.rules.entry_end) if self.rules.entry_end else None
        self._sq_time = _minutes(self.rules.square_off_time) if self.rules.square_off_time else None

    # ------------------------------------------------------------------ #
    # Trading rules
    # ------------------------------------------------------------------ #
    def new_bar(self, i: int):
        """Reset the per-day counters when a new trading day starts."""
        d = self.e.day[i]
        if d != self.day_key:
            self.day_key = d
            self.day_start_equity = self.equity
            self.day_notional = 0.0
            self.day_entries = 0
            self.halted_today = False

    def _sizing_base(self) -> float:
        return self.cfg.initial_capital if self.rules.sizing_base == "fixed" else self.equity

    def _square_off_due(self, i: int) -> bool:
        e = self.e
        return bool(self.rules.square_off and (e.last_of_day[i] or (
            e.intraday and self._sq_time is not None and e.minute[i] >= self._sq_time)))

    def _rule_block(self, symbol: str, i: int, at_close: bool = False) -> str | None:
        """Why a fill that *adds* exposure must be rejected on bar ``i`` (None = allowed)."""
        r = self.rules
        if at_close and self._square_off_due(i):
            return "blocked_after_square_off"   # would be carried overnight
        if self.halted_forever:
            return "blocked_drawdown_stop"
        if self.halted_today:
            return "blocked_daily_stop"
        if self.e.intraday:
            m = self.e.minute[i]
            if self._entry_start is not None and m < self._entry_start:
                return "blocked_entry_window"
            if self._entry_end is not None and m > self._entry_end:
                return "blocked_entry_window"
            if r.square_off and self._sq_time is not None and m >= self._sq_time:
                return "blocked_after_square_off"
        if r.max_trades_per_day and self.day_entries >= r.max_trades_per_day:
            return "blocked_max_trades_per_day"
        if r.max_open_positions and self.positions[symbol].qty == 0:
            open_n = sum(1 for p in self.positions.values() if p.qty)
            if open_n >= r.max_open_positions:
                return "blocked_max_open_positions"
        if r.cooldown_bars and symbol in self.last_exit_bar and i - self.last_exit_bar[symbol] < r.cooldown_bars:
            return "blocked_cooldown"
        return None

    def flatten(self, i: int, reason: str, cancel_orders: bool = True):
        # Rule exits must happen even if a symbol has no bar right now: use its last known price.
        for s, p in self.positions.items():
            if p.qty and self.e.price(s, i) > 0:
                self._fill(s, -p.qty, self.e.price(s, i), i, "exit", reason, None)
        if cancel_orders:
            self.orders = []

    def check_risk_limits(self, i: int) -> bool:
        """Daily loss/profit stops and the drawdown kill switch (evaluated at the bar close)."""
        r = self.rules
        eq = self.equity
        self.peak_equity = max(self.peak_equity, eq)
        hit = None
        if r.max_drawdown_stop_pct and not self.halted_forever and eq <= self.peak_equity * (1 - r.max_drawdown_stop_pct / 100):
            hit, self.halted_forever = "max_drawdown_stop", True
        elif not self.halted_today and self.day_start_equity > 0:
            day_ret = eq / self.day_start_equity - 1
            if r.daily_loss_limit_pct and day_ret <= -r.daily_loss_limit_pct / 100:
                hit = "daily_loss_limit"
            elif r.daily_profit_target_pct and day_ret >= r.daily_profit_target_pct / 100:
                hit = "daily_profit_target"
            if hit:
                self.halted_today = True
        if hit:
            self.rule_stats[hit] += 1
            self.flatten(i, hit)
            return True
        return False

    def square_off(self, i: int) -> bool:
        if self._square_off_due(i) and any(p.qty for p in self.positions.values()):
            self.rule_stats["square_off"] += 1
            # Orders placed today stay queued: they are tomorrow's entries (at the next open).
            self.flatten(i, "square_off", cancel_orders=False)
            return True
        return False

    # ------------------------------------------------------------------ #
    def submit(self, symbol, side, intent, size=None, limit=None, stop=None, sl=None, tp=None, trail=None,
               tag="", valid_bars=None, owner=None):
        if symbol not in self.positions:
            raise ValueError(f"Unknown symbol {symbol}")
        pos = self.positions[symbol]
        i = self.e.clock.i
        if intent == "entry":
            same_dir = pos.qty * side > 0
            if same_dir and pos.entries >= self.cfg.pyramiding:
                return None
            if side < 0 and pos.qty <= 0 and not self.cfg.allow_short:
                self.rule_stats["blocked_short_signal"] += 1
                return None  # nothing to sell and shorting disabled
            if side > 0 and pos.qty >= 0 and not self.cfg.allow_long:
                self.rule_stats["blocked_long_signal"] += 1
                return None  # short-only: buys may only cover shorts
            if (self.halted_today or self.halted_forever) and not pos.qty * side < 0:
                self.rule_stats["blocked_daily_stop" if self.halted_today else "blocked_drawdown_stop"] += 1
                return None
            # De-duplicate: one pending market entry per direction.
            for o in self.orders:
                if o.symbol == symbol and o.intent == "entry" and o.side == side and o.kind == "market" \
                        and limit is None and stop is None:
                    return None
        elif intent == "close":
            if pos.qty == 0 and not any(o.symbol == symbol and o.intent == "entry" for o in self.orders):
                return None
            # A close cancels pending entries for that symbol.
            self.orders = [o for o in self.orders if not (o.symbol == symbol and o.intent in ("entry", "close"))]
        elif intent in ("target_pct", "target_qty"):
            self.orders = [o for o in self.orders if not (o.symbol == symbol and o.intent.startswith("target"))]
        self._oid += 1
        o = Order(self._oid, symbol, side, intent, size, limit, stop, sl, tp, trail, tag, i,
                  (i + valid_bars) if valid_bars else None, owner)
        self.orders.append(o)
        return o

    def cancel(self, symbol=None):
        self.orders = [o for o in self.orders if symbol is not None and o.symbol != symbol]

    # ------------------------------------------------------------------ #
    # Sizing
    # ------------------------------------------------------------------ #
    def _round_qty(self, q: float) -> float:
        lot = self.cfg.lot_size if self.cfg.lot_size > 0 else 1.0
        if self.cfg.fractional and lot == 1.0:
            return math.floor(abs(q) * 1e6) / 1e6 * (1 if q >= 0 else -1)
        return math.floor(abs(q) / lot + 1e-9) * lot * (1 if q >= 0 else -1)

    def _entry_qty(self, o: Order, price: float) -> float:
        cfg = self.cfg
        n_alloc = self.e.n_alloc
        base = self._sizing_base()
        alloc = base * cfg.leverage / n_alloc
        if o.size is not None:
            if 0 < o.size <= 1:
                return o.size * alloc / price
            return float(o.size)
        mode, v = cfg.sizing_mode, cfg.sizing_value
        if mode == "fixed_qty":
            return v
        if mode == "fixed_cash":
            return v / price
        if mode == "risk":
            stop = o.sl
            if stop is None and cfg.stop_loss_pct > 0:
                stop = price * (1 - o.side * cfg.stop_loss_pct / 100)
            if stop is not None and abs(price - stop) > 0:
                q = base * (v / 100) / abs(price - stop)
                return min(q, alloc / price)
            return alloc / price
        return (v / 100) * alloc / price

    # ------------------------------------------------------------------ #
    # Order processing
    # ------------------------------------------------------------------ #
    def process(self, i: int, at_close: bool = False):
        """Try to fill pending orders on bar ``i``."""
        if not self.orders:
            return
        done: set[int] = set()
        for o in list(self.orders):
            if o.id in done or o not in self.orders:
                continue  # filled or cancelled earlier in this loop
            if o.valid_until is not None and i > o.valid_until:
                done.add(o.id)
                continue
            if at_close and (o.kind != "market" or o.created_bar != i):
                continue
            if not at_close and o.created_bar == i and self.cfg.fill_on == "next_open":
                continue
            px = self._match(o, i, at_close)
            if px is None or not self.e.tradable(o.symbol, i):
                continue
            self._execute(o, px, i, at_close)
            done.add(o.id)
        self.orders = [o for o in self.orders if o.id not in done]

    def _match(self, o: Order, i: int, at_close: bool) -> float | None:
        d = self.e.arr[o.symbol]
        op, hi, lo, cl = d["open"][i], d["high"][i], d["low"][i], d["close"][i]
        if np.isnan(cl):
            return None
        if at_close:
            return cl
        side = o.side if o.side != 0 else (1 if self._resolve_delta(o, op) > 0 else -1)
        k = o.kind
        if k == "market":
            return op
        if k == "limit":
            if side > 0 and lo <= o.limit:
                return min(op, o.limit)
            if side < 0 and hi >= o.limit:
                return max(op, o.limit)
            return None
        if k == "stop":
            if side > 0 and hi >= o.stop:
                return max(op, o.stop)
            if side < 0 and lo <= o.stop:
                return min(op, o.stop)
            return None
        if k == "stop_limit":
            triggered = (side > 0 and hi >= o.stop) or (side < 0 and lo <= o.stop)
            if not triggered:
                return None
            o.stop = None  # becomes a plain limit order
            return self._match(o, i, at_close)
        return None

    def _resolve_delta(self, o: Order, price: float) -> float:
        pos = self.positions[o.symbol]
        if o.intent == "close":
            return -pos.qty
        if o.intent == "target_qty":
            return float(o.size) - pos.qty
        if o.intent == "target_pct":
            target = float(o.size) * self._sizing_base() * self.cfg.leverage / price
            return target - pos.qty
        return 0.0

    def _execute(self, o: Order, px: float, i: int, at_close: bool = False):
        cfg = self.cfg
        pos = self.positions[o.symbol]
        if o.intent == "entry":
            # Flip: close the opposite position first.
            if pos.qty * o.side < 0:
                self._fill(o.symbol, -pos.qty, px, i, o.kind, "signal", o)
                pos = self.positions[o.symbol]
            if (o.side < 0 and not cfg.allow_short) or (o.side > 0 and not cfg.allow_long):
                self._drop(o)
                return
            if pos.qty * o.side > 0 and pos.entries >= cfg.pyramiding:
                self._drop(o)
                return
            blocked = self._rule_block(o.symbol, i, at_close)
            if blocked:
                self.rule_stats[blocked] += 1
                self._drop(o)
                return
            slip_px = self._slip(px, o.side, o.kind)
            qty = self._round_qty(self._entry_qty(o, slip_px)) * o.side
            qty = self._cap_qty(o.symbol, qty, slip_px, i)
            if qty != 0:
                self._fill(o.symbol, qty, px, i, o.kind, o.tag or "entry", o)
        else:
            delta = self._resolve_delta(o, px)
            if o.intent != "close":
                delta = self._round_qty(delta)
                new = pos.qty + delta
                if new < 0 and not cfg.allow_short:
                    new = max(new, 0.0)
                    if pos.qty <= 0:
                        self.rule_stats["blocked_short_signal"] += 1
                if new > 0 and not cfg.allow_long:
                    new = min(new, 0.0)
                    if pos.qty >= 0:
                        self.rule_stats["blocked_long_signal"] += 1
                if abs(new) > abs(pos.qty) or new * pos.qty < 0:
                    blocked = self._rule_block(o.symbol, i, at_close)
                    if blocked:  # rules allow reducing, never adding
                        self.rule_stats[blocked] += 1
                        new = pos.qty if new * pos.qty > 0 else 0.0
                delta = self._cap_qty(o.symbol, new - pos.qty, px, i)
            if abs(delta) > 1e-12:
                reason = "signal" if o.intent == "close" else (o.tag or "rebalance")
                self._fill(o.symbol, delta, px, i, o.kind, reason, o)
        self._drop(o)

    def _drop(self, o):
        if o in self.orders:
            self.orders.remove(o)

    def _slip(self, px, side, kind):
        if kind in ("market", "stop", "exit"):
            return px * (1 + side * self.cfg.slippage_pct)
        return px

    def _cap_qty(self, symbol, qty, px, i):
        """Apply volume participation and buying-power limits to an order that adds exposure."""
        cfg = self.cfg
        pos = self.positions[symbol]
        if cfg.max_volume_pct > 0:
            vol = self.e.arr[symbol]["volume"][i]
            if vol > 0:
                cap = self._round_qty(vol * cfg.max_volume_pct / 100)
                qty = max(min(qty, cap), -cap)
        adding = abs(pos.qty + qty) > abs(pos.qty)
        if not adding:
            return qty
        qty = self._rule_cap(symbol, qty, px)
        if abs(pos.qty + qty) <= abs(pos.qty) and pos.qty * qty >= 0:
            return qty
        # Buying power: gross exposure after fill must stay within equity × leverage.
        gross_other = sum(abs(p.qty) * self.e.price(s) for s, p in self.positions.items() if s != symbol and p.qty)
        cap_gross = max(self.equity, 0) * cfg.leverage
        new_abs_qty = abs(pos.qty + qty)
        room = max(cap_gross - gross_other, 0)
        # Leave headroom for the actual commission of an order this size (plus slippage).
        q_guess = room / px if px > 0 else 0.0
        fee_rate = cfg.cost("buy", q_guess, px) / (q_guess * px) if q_guess > 0 else 0.0
        fee_buffer = 1 + max(cfg.slippage_pct, 0) + fee_rate + 1e-9
        max_abs = room / (px * fee_buffer)
        if new_abs_qty > max_abs:
            sgn = 1 if qty > 0 else -1
            if pos.qty * qty >= 0:  # pure add
                qty = self._round_qty(max(max_abs - abs(pos.qty), 0)) * sgn
            else:  # flip: close the old side fully, open the new side within limits
                qty = -pos.qty + self._round_qty(max_abs) * sgn
        if not cfg.leverage > 1 and not cfg.allow_short and qty > 0:
            # cash account: can't spend more cash than we have
            max_cash_qty = self._round_qty(max(self.cash, 0) / (px * fee_buffer))
            qty = min(qty, max_cash_qty)
        return qty

    def _rule_cap(self, symbol: str, qty: float, px: float) -> float:
        """Shrink an exposure-adding order to respect position-size and daily-capital rules."""
        r = self.rules
        pos = self.positions[symbol]
        sgn = 1 if qty > 0 else -1
        keep_close = -pos.qty if pos.qty * qty < 0 else 0.0     # part of a flip that just closes
        add = abs(qty) - abs(keep_close)                          # new exposure requested (units)
        start = 0.0 if keep_close else abs(pos.qty)
        limit = math.inf
        if r.max_position_pct:
            limit = max(self.equity, 0) * r.max_position_pct / 100 / px - start
            if limit < add:
                self.rule_stats["capped_max_position"] += 1
        if r.daily_capital_limit:
            budget = (r.daily_capital_limit / 100 * self.day_start_equity if r.daily_capital_mode == "pct"
                      else r.daily_capital_limit)
            room = max(budget - self.day_notional, 0) / px
            if room < add:
                self.rule_stats["capped_daily_capital"] += 1
            limit = min(limit, room)
        if limit < add:
            add = self._round_qty(max(limit, 0.0))
        return keep_close + add * sgn

    # ------------------------------------------------------------------ #
    def _fill(self, symbol: str, qty: float, raw_px: float, i: int, kind: str, reason: str, order: Order | None):
        if qty == 0:
            return
        side = 1 if qty > 0 else -1
        px = self._slip(raw_px, side, kind)
        fee = self.cfg.cost("buy" if side > 0 else "sell", abs(qty), px)
        self.cash -= qty * px + fee
        self.total_fees += fee
        pos = self.positions[symbol]
        t = self.e.index[i]
        self.fills.append({"time": t, "symbol": symbol, "side": "BUY" if side > 0 else "SELL", "qty": abs(qty),
                           "price": px, "fee": fee, "reason": reason, "kind": kind, "bar": i})

        remaining = qty
        # Reduce / close the existing position.
        if pos.qty * qty < 0:
            close_qty = min(abs(qty), abs(pos.qty)) * (1 if qty > 0 else -1)
            frac = abs(close_qty) / abs(pos.qty)
            alloc_entry_fee = pos.entry_fees * frac
            close_fee = fee * abs(close_qty) / abs(qty)
            direction = 1 if pos.qty > 0 else -1
            gross = (px - pos.avg_price) * abs(close_qty) * direction
            pnl = gross - alloc_entry_fee - close_fee
            cost_basis = pos.avg_price * abs(close_qty)
            hi, lo = pos.peak, pos.trough
            if direction > 0:
                mfe, mae = (hi / pos.avg_price - 1) * 100, (lo / pos.avg_price - 1) * 100
            else:
                mfe, mae = (1 - lo / pos.avg_price) * 100, (1 - hi / pos.avg_price) * 100
            trade = {
                "id": len(self.trades) + 1, "symbol": symbol, "side": "Long" if direction > 0 else "Short",
                "entry_time": pos.entry_time, "exit_time": t, "entry_bar": pos.entry_bar, "exit_bar": i,
                "entry_price": pos.avg_price, "exit_price": px, "qty": abs(close_qty),
                "pnl": pnl, "gross_pnl": gross, "fees": alloc_entry_fee + close_fee,
                "return_pct": pnl / cost_basis * 100 if cost_basis else 0.0,
                "bars_held": i - pos.entry_bar, "mfe_pct": mfe, "mae_pct": min(mae, 0.0),
                "exit_reason": reason, "entry_tag": pos.tag,
            }
            self.trades.append(trade)
            if order is not None and order.owner is not None:
                try:
                    order.owner.on_trade(trade)
                except Exception:
                    pass
            pos.entry_fees -= alloc_entry_fee
            pos.qty += close_qty
            remaining = qty - close_qty
            if abs(pos.qty) < 1e-12:
                self.positions[symbol] = pos = Position(symbol)
                self.last_exit_bar[symbol] = i
        # Open / add.
        if abs(remaining) > 1e-12:
            open_fee = fee * abs(remaining) / abs(qty)
            if pos.qty == 0:
                pos.entry_bar, pos.entry_time, pos.entries = i, t, 0
                pos.peak = pos.trough = px
                pos.tag = order.tag if order else ""
                pos.sl = pos.tp = pos.trail = None
            new_qty = pos.qty + remaining
            pos.avg_price = (pos.avg_price * abs(pos.qty) + px * abs(remaining)) / abs(new_qty)
            pos.qty = new_qty
            pos.entry_fees += open_fee
            pos.entries += 1
            self.day_notional += abs(remaining) * px
            self.day_entries += 1
            self._attach_bracket(pos, order, px)

    def _attach_bracket(self, pos: Position, o: Order | None, px: float):
        cfg = self.cfg
        d = 1 if pos.qty > 0 else -1
        sl = o.sl if o and o.sl is not None else None
        tp = o.tp if o and o.tp is not None else None
        trail = o.trail if o and o.trail is not None else None
        defaults = not (o is not None and o.owner is not None and not getattr(o.owner, "uses_default_exits", True))
        pos.default_exits = defaults
        if defaults and sl is None and cfg.stop_loss_pct > 0:
            sl = pos.avg_price * (1 - d * cfg.stop_loss_pct / 100)
        if defaults and tp is None and cfg.take_profit_pct > 0:
            tp = pos.avg_price * (1 + d * cfg.take_profit_pct / 100)
        if defaults and trail is None and cfg.trailing_pct > 0:
            trail = cfg.trailing_pct
        if sl is not None:
            pos.sl = sl
        if tp is not None:
            pos.tp = tp
        if trail is not None:
            pos.trail = trail

    # ------------------------------------------------------------------ #
    def check_exits(self, i: int):
        cfg = self.cfg
        for s, pos in self.positions.items():
            if pos.qty == 0 or not self.e.tradable(s, i):
                continue
            d = self.e.arr[s]
            op, hi, lo = d["open"][i], d["high"][i], d["low"][i]
            long = pos.qty > 0
            stop = pos.sl
            reason = "stop_loss"
            if pos.trail:
                tstop = pos.peak * (1 - pos.trail / 100) if long else pos.trough * (1 + pos.trail / 100)
                if stop is None or (long and tstop > stop) or (not long and tstop < stop):
                    stop, reason = tstop, "trailing_stop"
            exit_px, why = None, None
            if stop is not None:
                if long and lo <= stop:
                    exit_px, why = min(op, stop), reason
                elif not long and hi >= stop:
                    exit_px, why = max(op, stop), reason
            if exit_px is None and pos.tp is not None:
                if long and hi >= pos.tp:
                    exit_px, why = max(op, pos.tp), "take_profit"
                elif not long and lo <= pos.tp:
                    exit_px, why = min(op, pos.tp), "take_profit"
            if exit_px is None and cfg.max_bars_in_trade and pos.default_exits and i - pos.entry_bar >= cfg.max_bars_in_trade:
                exit_px, why = d["close"][i], "time_exit"
            # Update excursion trackers *after* the exit test (no look-ahead into the trail level).
            pos.peak = max(pos.peak, hi)
            pos.trough = min(pos.trough, lo)
            if exit_px is not None:
                kind = "limit" if why == "take_profit" else "exit"
                self._fill(s, -pos.qty, exit_px, i, kind, why, None)
                self.orders = [o for o in self.orders if not (o.symbol == s and o.intent == "close")]

    def mark(self, i: int):
        value = 0.0
        gross = 0.0
        for s, p in self.positions.items():
            if p.qty:
                px = self.e.price(s, i)
                value += p.qty * px
                gross += abs(p.qty) * px
        self.equity = self.cash + value
        return self.equity, gross


# --------------------------------------------------------------------------- #
# Backtester
# --------------------------------------------------------------------------- #
class Backtester:
    def __init__(self, frames: dict[str, pd.DataFrame], strategy_cls: type[Strategy], params: dict | None = None,
                 config: EngineConfig | None = None):
        if not frames:
            raise ValueError("No data supplied")
        self.cfg = config or EngineConfig()
        self.strategy_cls = strategy_cls
        self.params = params or {}
        self.symbols = list(frames)
        self.clock = Clock()
        self._logs: list[dict] = []

        # Unified calendar across all symbols (handles different holidays).
        index = frames[self.symbols[0]].index
        for s in self.symbols[1:]:
            index = index.union(frames[s].index)
        self.index = index
        self.frames, self.arr, self.valid = {}, {}, {}
        for s, f in frames.items():
            raw = f.reindex(index)
            has = raw["close"].notna().to_numpy()
            filled = raw.copy()
            filled["close"] = filled["close"].ffill()
            for c in ("open", "high", "low"):
                filled[c] = filled[c].fillna(filled["close"])
            filled["volume"] = filled["volume"].fillna(0.0)
            self.frames[s] = filled
            self.arr[s] = {c: filled[c].to_numpy(float) for c in ("open", "high", "low", "close", "volume")}
            self.valid[s] = has
        self.n_alloc = len(self.symbols) if strategy_cls.per_asset else 1
        # Calendar helpers for daily rules.
        norm = index.normalize()
        self.day = norm.asi8
        self.last_of_day = np.r_[self.day[1:] != self.day[:-1], True]
        self.intraday = bool((index != norm).any())
        self.minute = np.asarray(index.hour * 60 + index.minute)
        self.broker = Broker(self)

    # ------------------------------------------------------------------ #
    def price(self, symbol: str, i: int | None = None) -> float:
        i = self.clock.i if i is None else i
        v = self.arr[symbol]["close"][i]
        return 0.0 if np.isnan(v) else float(v)

    def tradable(self, symbol: str, i: int) -> bool:
        return bool(self.valid[symbol][i])

    def log(self, symbol: str, msg: str):
        if len(self._logs) < 5000:
            self._logs.append({"time": str(self.index[self.clock.i]), "symbol": symbol, "msg": msg})

    # ------------------------------------------------------------------ #
    def run(self) -> dict:
        t0 = time.perf_counter()
        views = {s: DataView(s, self.frames[s], self.clock) for s in self.symbols}
        if self.strategy_cls.per_asset:
            strats = [(s, self.strategy_cls(self, views[s], views, self.params)) for s in self.symbols]
        else:
            strats = [(self.symbols[0], self.strategy_cls(self, views[self.symbols[0]], views, self.params))]
        self.clock.i = len(self.index) - 1  # init() sees full arrays via I(); Line access is bounded anyway
        for _, st in strats:
            try:
                st.init()
            except Exception as e:
                raise _strategy_error(e, "init()", st) from e
        self.clock.i = 0
        first_valid = {s: int(np.argmax(self.valid[s])) for s in self.symbols}

        n = len(self.index)
        equity = np.empty(n)
        cash = np.empty(n)
        exposure = np.empty(n)
        b = self.broker
        for i in range(n):
            self.clock.i = i
            b.new_bar(i)
            b.process(i)
            b.check_exits(i)
            eq, gross = b.mark(i)
            if b.square_off(i):
                eq, gross = b.mark(i)
            for s, st in strats:
                if i < max(st._warmup, first_valid[s]):
                    continue
                if st.per_asset and not self.valid[s][i]:
                    continue
                try:
                    st.next()
                except Exception as e:
                    raise _strategy_error(e, "next()", st, self.index[i]) from e
            if self.cfg.fill_on == "close":
                b.process(i, at_close=True)
                eq, gross = b.mark(i)
            if b.check_risk_limits(i):
                eq, gross = b.mark(i)
            if eq <= 0:
                # Account blown: liquidate and stop trading.
                for s, p in b.positions.items():
                    if p.qty:
                        b._fill(s, -p.qty, self.price(s, i), i, "exit", "margin_call", None)
                eq, gross = b.mark(i)
                equity[i:], cash[i:], exposure[i:] = eq, b.cash, 0.0
                break
            equity[i], cash[i] = eq, b.cash
            exposure[i] = gross / eq if eq > 0 else 0.0
        else:
            if self.cfg.close_at_end:
                i = n - 1
                for s, p in b.positions.items():
                    if p.qty:
                        b._fill(s, -p.qty, self.price(s, i), i, "close", "end_of_data", None)
                eq, _ = b.mark(i)
                equity[i], cash[i] = eq, b.cash

        open_positions = [
            {"symbol": s, "qty": p.qty, "avg_price": p.avg_price, "last": self.price(s, n - 1),
             "pnl": (self.price(s, n - 1) - p.avg_price) * p.qty}
            for s, p in b.positions.items() if p.qty
        ]
        indicators = [ind for _, st in strats for ind in st._indicators]
        return {
            "index": self.index,
            "equity": pd.Series(equity, index=self.index),
            "cash": pd.Series(cash, index=self.index),
            "exposure": pd.Series(exposure, index=self.index),
            "trades": b.trades,
            "fills": b.fills,
            "fees": b.total_fees,
            "rule_events": dict(b.rule_stats),
            "warmup": max((st._warmup for _, st in strats), default=0),
            "starved_indicators": sorted({n for _, st in strats for n in st._starved}),
            "rules_active": self.cfg.rules.active(),
            "open_positions": open_positions,
            "indicators": indicators,
            "logs": self._logs,
            "elapsed": time.perf_counter() - t0,
            "frames": self.frames,
        }
