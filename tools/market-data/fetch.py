#!/usr/bin/env python3
"""
fetch.py — yfinance-backed market-data fetcher for the candidate-screener.

Reads --tickers (comma-separated) and --week-of (YYYY-MM-DD), emits a JSON
array on stdout matching the candidate-screener watchlist schema.

Per-ticker failures are non-fatal: a WARNING is printed to stderr and the
ticker is skipped. Exit 0 if at least one ticker succeeded, 1 if all failed.

Setup:
    pip install yfinance

Usage:
    python3 tools/market-data/fetch.py --tickers AAPL,PFE --week-of 2026-04-27
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

# ── Sector → hedge ETF mapping ─────────────────────────────────────
# Keys are normalized (lowercased, spaces stripped) yfinance sector strings.
HEDGE_BY_SECTOR: dict[str, str] = {
    "technology": "QQQ",
    "communicationservices": "QQQ",
    "energy": "XLE",
    "healthcare": "XLV",
    "financialservices": "XLF",
    "financial": "XLF",
    "consumercyclical": "XLY",
    "consumerdiscretionary": "XLY",
    "consumerdefensive": "XLP",
    "consumerstaples": "XLP",
    "industrials": "XLI",
}


def _warn(msg: str) -> None:
    print(f"WARNING: {msg}", file=sys.stderr)


# ── ATM-IV history sidecar log ────────────────────────────────────
# Append-only JSONL file. One line per (ticker, run) when an ATM IV was
# successfully fetched. After ~3 months of weekly runs, this lets us replace
# the realized-vol HV-rank proxy with a true IV rank computed against this
# ticker's own ATM-IV history.
#
# Path resolution:
#   - MARKET_DATA_IV_LOG env var, if set
#       * "off" (case-insensitive) disables logging entirely
#       * any other value is treated as a file path
#   - Otherwise: <repo-root>/tools/market-data/iv-history.jsonl
#
# Failures are logged to stderr but never raised — logging is best-effort
# and must not affect fetcher exit code.
def _resolve_iv_log_path() -> Path | None:
    env = os.environ.get("MARKET_DATA_IV_LOG")
    if env is not None:
        if env.strip().lower() == "off":
            return None
        return Path(env)
    return Path(__file__).resolve().parent / "iv-history.jsonl"


def _log_iv_history(
    ticker: str,
    expiry: str,
    spot: float,
    atm_iv: float,
    open_interest: int | None,
) -> None:
    log_path = _resolve_iv_log_path()
    if log_path is None:
        return
    record = {
        "run_date": date.today().isoformat(),
        "ticker": ticker,
        "expiry": expiry,
        "spot": round(float(spot), 2),
        "atm_iv": round(float(atm_iv), 4),
        "open_interest": int(open_interest) if open_interest is not None else None,
    }
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except OSError as exc:
        _warn(f"iv-history log write failed at {log_path}: {exc}")


def _normalize_sector(sector: str | None) -> str | None:
    if not sector:
        return None
    return sector.lower().replace(" ", "").replace("-", "")


def _hedge_for_sector(sector: str | None) -> str | None:
    norm = _normalize_sector(sector)
    if norm is None:
        return None
    return HEDGE_BY_SECTOR.get(norm)


def _to_date(value: Any) -> date | None:
    """Coerce a yfinance date-ish value (datetime/Timestamp/str) to date."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    # pandas Timestamp has .date()
    if hasattr(value, "date") and callable(value.date):
        try:
            return value.date()
        except Exception:
            pass
    if isinstance(value, str):
        try:
            return datetime.strptime(value[:10], "%Y-%m-%d").date()
        except ValueError:
            return None
    return None


def _nearest_atm_row(chain_df, spot: float):
    """Return the row of an option chain DataFrame whose strike is closest to spot."""
    if chain_df is None or len(chain_df) == 0:
        return None
    diffs = (chain_df["strike"] - spot).abs()
    return chain_df.iloc[int(diffs.idxmin() if hasattr(diffs, "idxmin") else diffs.argmin())]


def _next_expiry_after(expiries: tuple[str, ...], target: date) -> str | None:
    """Pick the earliest expiry on or after `target`. Falls back to the last
    expiry if none are after target."""
    if not expiries:
        return None
    parsed: list[tuple[date, str]] = []
    for e in expiries:
        d = _to_date(e)
        if d is not None:
            parsed.append((d, e))
    parsed.sort(key=lambda x: x[0])
    for d, e in parsed:
        if d >= target:
            return e
    return parsed[-1][1] if parsed else None


def _hv_rank_from_history(hist) -> float | None:
    """Compute realized-vol rank (0–100) as a proxy for IV rank.

    Uses a rolling 30-day annualized stdev of log returns over the last year.
    Reports the percentile rank of the most-recent value within that series.
    Returns None if insufficient history.
    """
    if hist is None or len(hist) < 60:
        return None
    closes = hist["Close"].dropna()
    if len(closes) < 60:
        return None
    log_returns = (closes / closes.shift(1)).apply(lambda x: math.log(x) if x and x > 0 else None)
    log_returns = log_returns.dropna()
    rv = log_returns.rolling(window=30).std() * math.sqrt(252)
    rv = rv.dropna()
    if len(rv) < 5:
        return None
    current = float(rv.iloc[-1])
    rv_min = float(rv.min())
    rv_max = float(rv.max())
    if rv_max <= rv_min:
        return None
    rank = (current - rv_min) / (rv_max - rv_min) * 100.0
    # Clamp to [0, 100]
    return max(0.0, min(100.0, rank))


def _daily_returns_30d(hist) -> list[float] | None:
    """Compute the trailing 30 daily log-returns from a price history frame.

    Returns None when fewer than 20 valid returns are available (matches the
    screener's lower bound on `dailyReturns30d`). Each entry is a fraction
    (e.g. 0.012 for +1.2%), rounded to 6 decimals for stable JSON output.
    Any individual return whose absolute value exceeds 0.5 (50% in a single
    day) is treated as suspect data and the whole series is rejected.
    """
    if hist is None or len(hist) < 30:
        return None
    closes = hist["Close"].dropna()
    if len(closes) < 30:
        return None
    log_returns: list[float] = []
    prev: float | None = None
    for val in closes:
        try:
            v = float(val)
        except (TypeError, ValueError):
            prev = None
            continue
        if prev is not None and prev > 0 and v > 0:
            r = math.log(v / prev)
            log_returns.append(round(r, 6))
        prev = v
    trailing = log_returns[-30:]
    if len(trailing) < 20:
        return None
    for r in trailing:
        if abs(r) > 0.5:
            return None
    return trailing


def _historical_earnings_moves(yf_ticker, hist) -> list[float] | None:
    """Find the last 8 earnings dates and compute next-day-close / prior-close - 1.

    Returns None if fewer than 4 usable returns can be computed (matches the
    screener's threshold for switching from registry-default to empirical).
    """
    if hist is None or len(hist) < 30:
        return None
    try:
        earnings_df = yf_ticker.get_earnings_dates(limit=24)
    except Exception:
        return None
    if earnings_df is None or len(earnings_df) == 0:
        return None
    today = date.today()
    past_dates: list[date] = []
    for ts in earnings_df.index:
        d = _to_date(ts)
        if d is not None and d < today:
            past_dates.append(d)
    past_dates.sort(reverse=True)
    past_dates = past_dates[:8]

    closes = hist["Close"].dropna()
    if len(closes) == 0:
        return None
    # Index closes by their date for quick lookup.
    by_date: dict[date, float] = {}
    for ts, val in closes.items():
        d = _to_date(ts)
        if d is not None:
            by_date[d] = float(val)
    sorted_trading_days = sorted(by_date.keys())

    def _next_trading_day(d: date) -> date | None:
        for td in sorted_trading_days:
            if td > d:
                return td
        return None

    def _prior_trading_day(d: date) -> date | None:
        prior = None
        for td in sorted_trading_days:
            if td < d:
                prior = td
            else:
                break
        return prior

    moves: list[float] = []
    for ed in past_dates:
        nxt = _next_trading_day(ed)
        prior = _prior_trading_day(ed)
        if nxt is None or prior is None:
            continue
        prior_close = by_date.get(prior)
        next_close = by_date.get(nxt)
        if prior_close is None or next_close is None or prior_close == 0:
            continue
        moves.append(round(next_close / prior_close - 1.0, 4))
    if len(moves) < 4:
        return None
    return moves


def _ivpre_for_expiry(yf_ticker, expiry: str, spot: float) -> tuple[float | None, int | None]:
    """Return (ivPre, openInterest) at the ATM strike of the given expiry."""
    try:
        chain = yf_ticker.option_chain(expiry)
    except Exception:
        return (None, None)
    # Pick whichever side (puts/calls) has a strike closest to spot.
    candidates = []
    for side_df in (chain.calls, chain.puts):
        if side_df is None or len(side_df) == 0:
            continue
        row = _nearest_atm_row(side_df, spot)
        if row is None:
            continue
        try:
            strike = float(row["strike"])
            iv = row.get("impliedVolatility", None)
            oi = row.get("openInterest", None)
            iv_f = float(iv) if iv is not None and not math.isnan(float(iv)) else None
            oi_i = int(oi) if oi is not None and not math.isnan(float(oi)) else None
            candidates.append((abs(strike - spot), iv_f, oi_i))
        except Exception:
            continue
    if not candidates:
        return (None, None)
    candidates.sort(key=lambda c: c[0])
    _, iv, oi = candidates[0]
    return (iv, oi)


def _fetch_hedge(yf_module, hedge_ticker: str) -> dict[str, float] | None:
    """Fetch hedgeSpot + hedgeIv for a hedge ETF. Returns None on failure."""
    try:
        t = yf_module.Ticker(hedge_ticker)
        info = t.info or {}
        spot = info.get("regularMarketPrice") or info.get("currentPrice")
        if spot is None:
            hist = t.history(period="5d")
            if hist is None or len(hist) == 0:
                return None
            spot = float(hist["Close"].dropna().iloc[-1])
        spot = float(spot)
        # Use the nearest expiry's ATM IV as a 30-day-IV proxy.
        expiries = t.options or ()
        iv_val: float | None = None
        if expiries:
            target = date.today() + timedelta(days=30)
            expiry = _next_expiry_after(expiries, target)
            if expiry:
                iv_val, _ = _ivpre_for_expiry(t, expiry, spot)
        if iv_val is None:
            # Fallback: 30d realized vol from history
            hist = t.history(period="3mo")
            if hist is not None and len(hist) >= 30:
                closes = hist["Close"].dropna()
                lr = (closes / closes.shift(1)).apply(
                    lambda x: math.log(x) if x and x > 0 else None
                ).dropna()
                if len(lr) >= 30:
                    iv_val = float(lr.iloc[-30:].std() * math.sqrt(252))
        if iv_val is None:
            return None
        return {"hedgeSpot": round(spot, 2), "hedgeIv": round(float(iv_val), 4)}
    except Exception as exc:
        _warn(f"hedge {hedge_ticker}: {exc}")
        return None


def _fetch_one(yf_module, ticker: str, week_of: date) -> dict[str, Any] | None:
    """Fetch one ticker's full watchlist entry. Returns None on failure."""
    try:
        t = yf_module.Ticker(ticker)
    except Exception as exc:
        _warn(f"{ticker}: failed to construct Ticker: {exc}")
        return None

    try:
        info = t.info or {}
    except Exception as exc:
        _warn(f"{ticker}: .info failed: {exc}")
        return None

    spot = info.get("regularMarketPrice") or info.get("currentPrice")
    if spot is None:
        _warn(f"{ticker}: no regularMarketPrice/currentPrice")
        return None
    try:
        spot = float(spot)
    except (TypeError, ValueError):
        _warn(f"{ticker}: non-numeric spot {spot!r}")
        return None

    sector = info.get("sector")
    if not sector:
        _warn(f"{ticker}: no sector in .info")
        return None

    # ── Catalyst: next earnings date from calendar ──────────────────
    catalyst_date: date | None = None
    try:
        cal = t.calendar
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            if isinstance(ed, list) and ed:
                catalyst_date = _to_date(ed[0])
            else:
                catalyst_date = _to_date(ed)
        elif cal is not None and hasattr(cal, "loc"):
            try:
                catalyst_date = _to_date(cal.loc["Earnings Date"].iloc[0])
            except Exception:
                catalyst_date = None
    except Exception as exc:
        _warn(f"{ticker}: calendar fetch failed: {exc}")

    if catalyst_date is None:
        _warn(f"{ticker}: no upcoming earnings date in calendar")
        return None

    quarter = (catalyst_date.month - 1) // 3 + 1
    catalyst_desc = f"Q{quarter} {catalyst_date.year} earnings"

    # ── Price history (used for HV rank + earnings moves) ───────────
    try:
        hist = t.history(period="2y")
    except Exception as exc:
        _warn(f"{ticker}: history fetch failed: {exc}")
        hist = None

    iv_rank = _hv_rank_from_history(hist) if hist is not None else None
    if iv_rank is None:
        _warn(f"{ticker}: insufficient history for HV rank")
        return None
    iv_rank = round(iv_rank, 1)

    # ── ivPre + openInterest at first post-event expiry ─────────────
    expiries = ()
    try:
        expiries = t.options or ()
    except Exception as exc:
        _warn(f"{ticker}: options expiries fetch failed: {exc}")

    iv_pre: float | None = None
    open_interest: int | None = None
    iv_pre_expiry: str | None = None
    if expiries:
        expiry = _next_expiry_after(expiries, catalyst_date)
        if expiry:
            iv_pre, open_interest = _ivpre_for_expiry(t, expiry, spot)
            iv_pre_expiry = expiry

    if open_interest is None:
        _warn(f"{ticker}: no openInterest available at ATM")
        return None

    # Log ATM IV to the history sidecar (best-effort, non-fatal).
    if iv_pre is not None and iv_pre_expiry is not None:
        _log_iv_history(ticker, iv_pre_expiry, spot, iv_pre, open_interest)

    # ── Historical earnings-day moves (optional) ────────────────────
    moves = _historical_earnings_moves(t, hist)

    # ── Trailing 30 daily log-returns (optional) ────────────────────
    daily_returns = _daily_returns_30d(hist)

    entry: dict[str, Any] = {
        "ticker": ticker,
        "sector": sector,
        "spot": round(spot, 2),
        "ivRank": iv_rank,
        "ivRankSource": "hv-proxy",
        "openInterest": int(open_interest),
        "catalyst": {
            "kind": "EARNINGS",
            "description": catalyst_desc,
            "date": catalyst_date.isoformat(),
        },
    }
    if iv_pre is not None:
        entry["ivPre"] = round(float(iv_pre), 4)
    if moves is not None:
        entry["historicalMoves"] = moves
    if daily_returns is not None:
        entry["dailyReturns30d"] = daily_returns

    # ── Hedge override (optional, sector-driven) ────────────────────
    hedge_ticker = _hedge_for_sector(sector)
    if hedge_ticker:
        hedge = _fetch_hedge(yf_module, hedge_ticker)
        if hedge is not None:
            entry["hedgeTicker"] = hedge_ticker
            entry["hedgeSpot"] = hedge["hedgeSpot"]
            entry["hedgeIv"] = hedge["hedgeIv"]

    return entry


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="yfinance market-data fetcher")
    parser.add_argument("--tickers", required=True, help="comma-separated ticker list")
    parser.add_argument("--week-of", required=True, help="YYYY-MM-DD")
    args = parser.parse_args(argv)

    try:
        week_of = datetime.strptime(args.week_of, "%Y-%m-%d").date()
    except ValueError:
        print(f"FETCH_ERROR: --week-of must be YYYY-MM-DD, got {args.week_of!r}", file=sys.stderr)
        return 1

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if not tickers:
        print("FETCH_ERROR: --tickers must contain at least one symbol", file=sys.stderr)
        return 1

    try:
        import yfinance as yf  # type: ignore
    except ImportError:
        # Sentinel string the TS wrapper detects to surface a friendly install hint.
        print("FETCH_ERROR: yfinance not installed (run: pip install yfinance)", file=sys.stderr)
        return 1

    results: list[dict[str, Any]] = []
    for ticker in tickers:
        entry = _fetch_one(yf, ticker, week_of)
        if entry is not None:
            results.append(entry)

    print(json.dumps(results, indent=2))

    if not results:
        print("FETCH_ERROR: all tickers failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
