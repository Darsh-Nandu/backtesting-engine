class SqueezeBreakout(Strategy):
    """Bollinger squeeze breakout with volume confirmation.

    1. Wait for a volatility squeeze: Bollinger bandwidth in its lowest
       `squeeze_pct` percent over the last `squeeze_lookback` bars.
    2. Within 10 bars of a squeeze, buy a close above the upper band on
       above-average volume (short a close below the lower band if allowed).
    3. Protect with an ATR stop-loss and a trailing stop; exit at the mid band.
    """
    name = "Squeeze Breakout"
    params = {"bb_period": 20, "bb_std": 2.0, "squeeze_lookback": 120, "squeeze_pct": 20,
              "vol_mult": 1.3, "atr_mult": 2.0, "trail_pct": 8.0}

    def init(self):
        d = self.data
        self.up, self.mid, self.lo = self.I(bollinger, d.close, self.p.bb_period, self.p.bb_std,
                                            names=["BB upper", "BB mid", "BB lower"])

        def bandwidth(close, n, k):
            upper, middle, lower = bollinger(close, n, k)
            return (upper - lower) / middle * 100

        def pct_rank(x, n):
            return pd.Series(x).rolling(n).rank(pct=True).to_numpy() * 100

        self.bw = self.I(bandwidth, d.close, self.p.bb_period, self.p.bb_std, name="Bandwidth %", overlay=False)
        self.bw_rank = self.I(pct_rank, self.bw, self.p.squeeze_lookback, name="Squeeze rank", plot=False)
        self.avg_vol = self.I(sma, d.volume, 20, name="Avg volume", plot=False)
        self.atr = self.I(atr, d.high, d.low, d.close, 14, name="ATR", plot=False)
        self.window = 0  # bars left in which a breakout counts

    def next(self):
        price = self.data.close[-1]
        if self.bw_rank[-1] <= self.p.squeeze_pct:
            self.window = 10
        else:
            self.window = max(self.window - 1, 0)

        if self.position.is_flat and self.window > 0:
            loud = self.data.volume[-1] > self.p.vol_mult * self.avg_vol[-1]
            if price > self.up[-1] and loud and self.can_long:
                self.buy(sl=price - self.p.atr_mult * self.atr[-1], trail=self.p.trail_pct, tag="squeeze_up")
                self.log(f"long breakout at {price:.2f} (bandwidth rank {self.bw_rank[-1]:.0f})")
            elif price < self.lo[-1] and loud and self.can_short:
                self.sell(sl=price + self.p.atr_mult * self.atr[-1], trail=self.p.trail_pct, tag="squeeze_down")
                self.log(f"short breakdown at {price:.2f}")
        elif self.position.is_long and price < self.mid[-1]:
            self.close()
        elif self.position.is_short and price > self.mid[-1]:
            self.close()
