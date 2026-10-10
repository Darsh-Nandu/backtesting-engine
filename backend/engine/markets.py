"""Exchange / market registry.

Each market knows how to turn a plain ticker (``RELIANCE``) into the Yahoo
Finance symbol (``RELIANCE.NS``), which currency it trades in, which index is
the natural benchmark and a few popular symbols for the UI.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict


@dataclass(frozen=True)
class Market:
    code: str
    name: str
    country: str
    currency: str
    symbol: str  # currency symbol
    suffix: str = ""
    prefix: str = ""
    benchmark: str = ""
    timezone: str = "UTC"
    cost_model: str = "percent"
    fractional: bool = False
    trading_days: int = 252
    popular: list[str] = field(default_factory=list)

    def to_yahoo(self, ticker: str) -> str:
        t = ticker.strip().upper()
        if not t:
            return t
        # Already fully qualified (e.g. user typed "RELIANCE.NS" or "^NSEI").
        if t.startswith("^") or (self.suffix and t.endswith(self.suffix.upper())):
            return t
        if self.code in ("CRYPTO",) and "-" in t:
            return t
        if self.code == "FOREX" and t.endswith("=X"):
            return t
        return f"{self.prefix}{t}{self.suffix}"

    def to_dict(self) -> dict:
        return asdict(self)


MARKETS: dict[str, Market] = {m.code: m for m in [
    Market("NSE", "National Stock Exchange of India", "India", "INR", "₹", ".NS", benchmark="^NSEI",
           timezone="Asia/Kolkata", cost_model="india_delivery",
           popular=["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN", "BHARTIARTL", "ITC",
                    "LT", "HINDUNILVR", "KOTAKBANK", "AXISBANK", "BAJFINANCE", "MARUTI", "TATAMOTORS",
                    "SUNPHARMA", "TITAN", "WIPRO", "ADANIENT", "NIFTYBEES"]),
    Market("BSE", "Bombay Stock Exchange", "India", "INR", "₹", ".BO", benchmark="^BSESN",
           timezone="Asia/Kolkata", cost_model="india_delivery",
           popular=["TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN", "ITC", "LT", "HINDUNILVR",
                    "BAJFINANCE", "MARUTI", "TITAN", "WIPRO"]),
    Market("NASDAQ", "NASDAQ", "United States", "USD", "$", benchmark="^IXIC", timezone="America/New_York",
           cost_model="us_equity",
           popular=["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "NFLX", "AMD",
                    "ADBE", "COST", "PEP", "INTC", "QQQ"]),
    Market("NYSE", "New York Stock Exchange", "United States", "USD", "$", benchmark="^GSPC",
           timezone="America/New_York", cost_model="us_equity",
           popular=["JPM", "V", "WMT", "XOM", "JNJ", "PG", "KO", "DIS", "BA", "GS", "CAT", "SPY", "BRK-B"]),
    Market("LSE", "London Stock Exchange", "United Kingdom", "GBP", "£", ".L", benchmark="^FTSE",
           timezone="Europe/London", cost_model="percent",
           popular=["HSBA", "BP", "SHEL", "AZN", "ULVR", "VOD", "BARC", "LLOY", "RIO", "GSK"]),
    Market("XETRA", "Deutsche Börse XETRA", "Germany", "EUR", "€", ".DE", benchmark="^GDAXI",
           timezone="Europe/Berlin", popular=["SAP", "SIE", "ALV", "BMW", "MBG", "DTE", "BAS", "ADS"]),
    Market("EURONEXT", "Euronext Paris", "France", "EUR", "€", ".PA", benchmark="^FCHI",
           timezone="Europe/Paris", popular=["MC", "OR", "TTE", "SAN", "AIR", "BNP", "RMS"]),
    Market("TSE", "Tokyo Stock Exchange", "Japan", "JPY", "¥", ".T", benchmark="^N225",
           timezone="Asia/Tokyo", popular=["7203", "6758", "9984", "8306", "6861", "9432"]),
    Market("HKEX", "Hong Kong Exchange", "Hong Kong", "HKD", "HK$", ".HK", benchmark="^HSI",
           timezone="Asia/Hong_Kong", popular=["0700", "9988", "0005", "1299", "0941", "3690"]),
    Market("TSX", "Toronto Stock Exchange", "Canada", "CAD", "C$", ".TO", benchmark="^GSPTSE",
           timezone="America/Toronto", popular=["RY", "TD", "SHOP", "ENB", "CNR", "BNS"]),
    Market("ASX", "Australian Securities Exchange", "Australia", "AUD", "A$", ".AX", benchmark="^AXJO",
           timezone="Australia/Sydney", popular=["BHP", "CBA", "CSL", "NAB", "WBC", "ANZ"]),
    Market("CRYPTO", "Cryptocurrency", "Global", "USD", "$", "-USD", benchmark="BTC-USD",
           cost_model="percent", fractional=True, trading_days=365,
           popular=["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX"]),
    Market("FOREX", "Foreign Exchange", "Global", "USD", "$", "=X", benchmark="",
           cost_model="percent", fractional=True, trading_days=260,
           popular=["EURUSD", "GBPUSD", "USDJPY", "USDINR", "AUDUSD", "USDCAD"]),
    Market("INDEX", "Indices", "Global", "USD", "", "", benchmark="",
           popular=["^NSEI", "^BSESN", "^NSEBANK", "^GSPC", "^IXIC", "^DJI", "^FTSE", "^N225"]),
    Market("CUSTOM", "Custom / Uploaded CSV", "-", "USD", "$", benchmark="", cost_model="percent",
           fractional=True, popular=[]),
]}


def get_market(code: str) -> Market:
    return MARKETS.get((code or "NASDAQ").upper(), MARKETS["NASDAQ"])
