#!/usr/bin/env python3
"""
backtest_comparison.py — Pick 10 random stocks, classify them, run the backtest
over the last 100 calendar days (weekly steps), then generate an HTML comparison
report at doc/backtest_comparison.html.

Usage:
    python3 scripts/backtest_comparison.py
    python3 scripts/backtest_comparison.py --tickers AAPL MSFT NVDA ...  (override random selection)
    python3 scripts/backtest_comparison.py --step-days 14                (bi-weekly instead of weekly)
    python3 scripts/backtest_comparison.py --skip-backtest               (just re-generate report from DB)
"""
import os
import sys
import random
import subprocess
import json
import argparse
from datetime import date, timedelta, datetime
from collections import defaultdict

import yfinance as yf
import mysql.connector
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))

load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'), override=True)

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
DB_PORT     = int(os.getenv('DB_PORT', 3306))

TODAY      = date.today()
START_DATE = (TODAY - timedelta(days=130)).isoformat()   # ~100 trading days
END_DATE   = (TODAY - timedelta(days=1)).isoformat()

TECH_SECTORS = {
    'Technology', 'Communication Services', 'Electronic Technology', 'Software',
    'Semiconductors', 'Consumer Electronics',
}

SECTOR_PE = {
    'Technology': 28, 'Healthcare': 22, 'Financials': 12,
    'Financial Services': 12, 'Consumer Cyclical': 20,
    'Consumer Defensive': 18, 'Industrials': 18, 'Energy': 15,
    'Utilities': 17, 'Real Estate': 25, 'Basic Materials': 16,
    'Communication Services': 22,
}

TAG_COLORS = {
    'small cap':           '#6366f1',
    'mid cap':             '#8b5cf6',
    'large cap':           '#0ea5e9',
    'risky':               '#ef4444',
    'under valued':        '#22c55e',
    'over valued':         '#f97316',
    'high growth potential': '#f59e0b',
    'tech':                '#06b6d4',
    'non tech':            '#64748b',
}

CHART_COLORS = [
    '#0ea5e9', '#22c55e', '#f97316', '#a855f7', '#ef4444',
    '#f59e0b', '#06b6d4', '#ec4899', '#84cc16', '#6366f1',
]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_db_connection():
    return mysql.connector.connect(
        host=DB_HOST, user=DB_USER, password=DB_PASSWORD,
        database=DB_DATABASE, port=DB_PORT
    )


def pick_random_stocks(conn, n=10):
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT symbol FROM stocks
        WHERE symbol IS NOT NULL
          AND LENGTH(symbol) BETWEEN 1 AND 5
          AND symbol REGEXP '^[A-Z]+$'
        ORDER BY RAND()
        LIMIT 200
    """)
    candidates = [r[0] for r in cur.fetchall()]
    cur.close()
    if len(candidates) < n:
        return candidates
    return random.sample(candidates, n)


def pick_diverse_stocks(conn, n=10, pool_size=60):
    """Pick n stocks with a rough small/mid/large cap mix.
    Pulls pool_size random candidates, classifies via yfinance, then samples ~n/3 per bucket."""
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT symbol FROM stocks
        WHERE symbol IS NOT NULL
          AND LENGTH(symbol) BETWEEN 1 AND 5
          AND symbol REGEXP '^[A-Z]+$'
        ORDER BY RAND()
        LIMIT %s
    """, (pool_size,))
    pool = [r[0] for r in cur.fetchall()]
    cur.close()
    random.shuffle(pool)

    per_bucket = max(1, n // 3)  # 3 → target 3/3/4
    extra = n - per_bucket * 3
    targets = {'small': per_bucket, 'mid': per_bucket, 'large': per_bucket + extra}
    buckets = {'small': [], 'mid': [], 'large': []}

    for ticker in pool:
        if sum(len(v) for v in buckets.values()) >= n:
            break
        try:
            info = yf.Ticker(ticker).info
            mc = info.get('marketCap') or 0
        except Exception:
            continue
        if mc <= 0:
            continue
        bucket = 'small' if mc < 2e9 else ('mid' if mc < 10e9 else 'large')
        if len(buckets[bucket]) < targets[bucket]:
            buckets[bucket].append(ticker)
            print(f"  [pool] {ticker}: {fmt_market_cap(mc)} → {bucket} ({len(buckets[bucket])}/{targets[bucket]})")

    result = buckets['small'] + buckets['mid'] + buckets['large']
    # Backfill if any bucket came up short
    if len(result) < n:
        extras = [t for t in pool if t not in result][: n - len(result)]
        result.extend(extras)
    return result[:n]


# ---------------------------------------------------------------------------
# Stock classification
# ---------------------------------------------------------------------------

def classify_stock(ticker):
    """Return {'tags': [...], 'data': {...}} using Yahoo Finance info."""
    try:
        info = yf.Ticker(ticker).info
    except Exception:
        return {'tags': ['unknown'], 'data': {'company_name': ticker, 'sector': 'Unknown'}}

    tags = []
    sector = info.get('sector', '') or ''
    market_cap = info.get('marketCap') or 0
    beta = info.get('beta')
    pe = info.get('trailingPE')
    rev_growth = info.get('revenueGrowth')
    fwd_pe = info.get('forwardPE')

    # ---- size ---------------------------------------------------------------
    if market_cap:
        if market_cap < 2e9:
            tags.append('small cap')
        elif market_cap < 10e9:
            tags.append('mid cap')
        else:
            tags.append('large cap')

    # ---- risk ---------------------------------------------------------------
    if beta is not None and beta > 1.5:
        tags.append('risky')

    # ---- valuation ----------------------------------------------------------
    sector_pe = SECTOR_PE.get(sector, 20)
    if pe and pe > 0:
        if pe < sector_pe * 0.7:
            tags.append('under valued')
        elif pe > sector_pe * 1.5:
            tags.append('over valued')
    elif fwd_pe and fwd_pe > 0:
        if fwd_pe < sector_pe * 0.7:
            tags.append('under valued')
        elif fwd_pe > sector_pe * 1.5:
            tags.append('over valued')

    # ---- growth potential ---------------------------------------------------
    if rev_growth is not None and rev_growth > 0.20:
        tags.append('high growth potential')

    # ---- tech / non-tech ----------------------------------------------------
    if sector in TECH_SECTORS:
        tags.append('tech')
    else:
        tags.append('non tech')

    return {
        'tags': tags or ['unknown'],
        'data': {
            'company_name': info.get('longName') or info.get('shortName') or ticker,
            'sector': sector or 'Unknown',
            'market_cap': market_cap,
            'beta': beta,
            'pe_ratio': pe,
            'fwd_pe': fwd_pe,
            'rev_growth': rev_growth,
            'current_price': info.get('regularMarketPrice') or info.get('currentPrice'),
        }
    }


# ---------------------------------------------------------------------------
# Backtest runner
# ---------------------------------------------------------------------------

def run_backtest(tickers, start_date, end_date, step_days):
    cmd = [
        sys.executable,
        os.path.join(SCRIPT_DIR, 'backtest_predictions.py'),
        *tickers,
        '--start-date', start_date,
        '--end-date',   end_date,
        '--step-days',  str(step_days),
        '--overwrite',
    ]
    print(f"\n[backtest] Running: {' '.join(cmd)}\n")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    return result.returncode == 0


# ---------------------------------------------------------------------------
# DB result query
# ---------------------------------------------------------------------------

def fetch_backtest_results(conn, tickers, from_date, to_date):
    cur = conn.cursor(dictionary=True)
    ph = ','.join(['%s'] * len(tickers))
    cur.execute(f"""
        SELECT
            symbol,
            DATE(predicted_at)          AS pred_date,
            price_at_prediction,
            predicted_change_pct_1w,    confidence_score_1w,
            accuracy_pct_1w,            direction_correct_1w,   resolved_1w,
            predicted_change_pct_1m,    confidence_score_1m,
            accuracy_pct_1m,            direction_correct_1m,   resolved_1m,
            predicted_change_pct_3m,    confidence_score_3m,
            accuracy_pct_3m,            direction_correct_3m,   resolved_3m,
            predicted_change_pct_6m,    confidence_score_6m,
            accuracy_pct_6m,            direction_correct_6m,   resolved_6m
        FROM prediction_records
        WHERE symbol IN ({ph})
          AND predicted_at >= %s
          AND predicted_at <= %s
        ORDER BY symbol, predicted_at
    """, (*tickers, from_date + ' 00:00:00', to_date + ' 23:59:59'))
    rows = cur.fetchall()
    cur.close()

    by_ticker = defaultdict(list)
    for row in rows:
        by_ticker[row['symbol']].append(row)
    return by_ticker


def fetch_price_history(ticker, start_date, end_date):
    try:
        hist = yf.Ticker(ticker).history(start=start_date, end=end_date, auto_adjust=True)
        if hist.empty:
            return []
        return [
            {'date': d.strftime('%Y-%m-%d'), 'close': round(float(r['Close']), 4)}
            for d, r in hist.iterrows()
        ]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Accuracy helpers
# ---------------------------------------------------------------------------

def print_comparison_table(stocks_data, results_by_ticker):
    """Print a plain-text comparison table (grouped by cap size)."""
    def cap_of(ticker):
        tags = stocks_data[ticker]['tags']
        for t in ('small cap', 'mid cap', 'large cap'):
            if t in tags:
                return t
        return 'unknown'

    order = {'small cap': 0, 'mid cap': 1, 'large cap': 2, 'unknown': 3}
    tickers_sorted = sorted(stocks_data.keys(), key=lambda t: (order[cap_of(t)], t))

    print("\n" + "=" * 118)
    print("COMPARISON TABLE — 3-month backtest")
    print("=" * 118)
    hdr = (f"{'Ticker':<7} {'Cap':<10} {'MktCap':>8} {'Beta':>5} {'P/E':>6} {'Sector':<22} "
           f"{'Runs':>4} | {'1w Acc':>7} {'1w Dir':>7} | {'1m Acc':>7} {'1m Dir':>7} | {'3m Acc':>7} {'3m Dir':>7}")
    print(hdr)
    print("-" * 118)

    current_bucket = None
    for ticker in tickers_sorted:
        bucket = cap_of(ticker)
        if bucket != current_bucket:
            if current_bucket is not None:
                print("-" * 118)
            current_bucket = bucket

        d = stocks_data[ticker]['data']
        rows = results_by_ticker.get(ticker, [])
        s1w = accuracy_summary(rows, '1w')
        s1m = accuracy_summary(rows, '1m')
        s3m = accuracy_summary(rows, '3m')

        def fmt_acc(s):
            if s['n'] == 0 or s['price_acc'] is None:
                return '   --  ', '   --  '
            price = f"{s['price_acc']:>6.1f}%"
            dir_str = f"{s['dir_acc']:>6.1f}%" if s['dir_acc'] is not None else '  neut '
            return price, dir_str

        p1w, d1w = fmt_acc(s1w)
        p1m, d1m = fmt_acc(s1m)
        p3m, d3m = fmt_acc(s3m)

        mc = fmt_market_cap(d.get('market_cap'))
        beta = f"{d.get('beta'):.2f}" if d.get('beta') is not None else '  --'
        pe = f"{d.get('pe_ratio'):.1f}" if d.get('pe_ratio') is not None else '   --'
        sector = (d.get('sector') or 'Unknown')[:22]

        print(f"{ticker:<7} {bucket:<10} {mc:>8} {beta:>5} {pe:>6} {sector:<22} "
              f"{len(rows):>4} | {p1w} {d1w} | {p1m} {d1m} | {p3m} {d3m}")
    print("=" * 118)
    print("Legend: Acc = price proximity accuracy · Dir = directional accuracy (neut = all neutral, excluded)")
    print("        Cap thresholds: small <$2B · mid $2-10B · large >$10B\n")


def accuracy_summary(rows, horizon):
    resolved = [r for r in rows if r.get(f'resolved_{horizon}')]
    if not resolved:
        return {'n': 0, 'price_acc': None, 'dir_acc': None, 'avg_conf': None}
    price_accs = [r[f'accuracy_pct_{horizon}'] for r in resolved if r[f'accuracy_pct_{horizon}'] is not None]
    dir_vals   = [r[f'direction_correct_{horizon}'] for r in resolved if r[f'direction_correct_{horizon}'] is not None]
    confs      = [r[f'confidence_score_{horizon}'] for r in rows if r[f'confidence_score_{horizon}'] is not None]
    return {
        'n':         len(resolved),
        'price_acc': round(sum(price_accs) / len(price_accs), 1) if price_accs else None,
        'dir_acc':   round(100 * sum(dir_vals) / len(dir_vals), 1) if dir_vals else None,
        'avg_conf':  round(sum(confs) / len(confs), 1) if confs else None,
    }


# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------

def fmt_market_cap(v):
    if not v:
        return '—'
    if v >= 1e12:
        return f'${v/1e12:.1f}T'
    if v >= 1e9:
        return f'${v/1e9:.1f}B'
    if v >= 1e6:
        return f'${v/1e6:.1f}M'
    return f'${v:,.0f}'


def fmt_pct(v, suffix='%'):
    if v is None:
        return '—'
    return f'{v:+.1f}{suffix}' if isinstance(v, float) else f'{v}{suffix}'


def fmt_num(v, decimals=2):
    if v is None:
        return '—'
    return f'{v:.{decimals}f}'


def acc_cell(v, is_dir=False):
    if v is None:
        return '<td class="na">—</td>'
    threshold = 50 if is_dir else 85
    color = '#22c55e' if v >= threshold else ('#f97316' if v >= threshold * 0.8 else '#ef4444')
    return f'<td style="color:{color};font-weight:600">{v:.1f}%</td>'


def build_tag_html(tags):
    parts = []
    for tag in tags:
        color = TAG_COLORS.get(tag, '#94a3b8')
        parts.append(
            f'<span class="tag" style="background:{color}">{tag}</span>'
        )
    return ' '.join(parts)


def normalized_prices(history):
    """Normalize a list of {'date', 'close'} to index=100 at the first point."""
    if not history:
        return []
    base = history[0]['close']
    if base == 0:
        return []
    return [{'date': r['date'], 'value': round(r['close'] / base * 100, 4)} for r in history]


def generate_html(stocks_data, results_by_ticker, price_histories,
                  start_date, end_date, step_days, output_path):
    tickers = list(stocks_data.keys())
    horizons = ['1w', '1m', '3m', '6m']

    # ----- normalized price series for Chart.js -----
    chart_labels_set = set()
    norm_series = {}
    for ticker in tickers:
        norm = normalized_prices(price_histories.get(ticker, []))
        norm_series[ticker] = norm
        chart_labels_set.update(r['date'] for r in norm)

    all_labels = sorted(chart_labels_set)

    datasets_js = []
    for i, ticker in enumerate(tickers):
        color = CHART_COLORS[i % len(CHART_COLORS)]
        norm = norm_series[ticker]
        lookup = {r['date']: r['value'] for r in norm}
        values_js = [lookup.get(d) for d in all_labels]
        # Replace None with null in JS
        vals_str = json.dumps(values_js).replace('null', 'null')
        datasets_js.append(f"""{{
            label: {json.dumps(ticker)},
            data: {vals_str},
            borderColor: {json.dumps(color)},
            backgroundColor: {json.dumps(color + '22')},
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
            spanGaps: true
        }}""")

    datasets_str = ',\n'.join(datasets_js)
    labels_str   = json.dumps(all_labels)

    # ----- accuracy rows -----
    acc_rows_html = ''
    for ticker in tickers:
        rows = results_by_ticker.get(ticker, [])
        n_total = len(rows)
        company = stocks_data[ticker]['data'].get('company_name', ticker)
        tags_html = build_tag_html(stocks_data[ticker]['tags'])
        color = CHART_COLORS[tickers.index(ticker) % len(CHART_COLORS)]

        cells = ''
        for h in horizons:
            s = accuracy_summary(rows, h)
            if s['n'] == 0:
                cells += '<td class="na" colspan="3">no data</td>'
            else:
                cells += acc_cell(s['price_acc'])
                cells += acc_cell(s['dir_acc'], is_dir=True)
                cells += f'<td class="conf">{s["avg_conf"] or "—"}</td>'

        acc_rows_html += f"""
        <tr>
            <td>
                <span class="ticker-dot" style="background:{color}"></span>
                <strong>{ticker}</strong>
                <div class="company-name">{company}</div>
                <div class="tags-inline">{tags_html}</div>
            </td>
            <td class="dim">{n_total}</td>
            {cells}
        </tr>"""

    # ----- classification cards -----
    cards_html = ''
    for i, ticker in enumerate(tickers):
        d = stocks_data[ticker]
        info = d['data']
        tags_html = build_tag_html(d['tags'])
        color = CHART_COLORS[i % len(CHART_COLORS)]
        mc = fmt_market_cap(info.get('market_cap'))
        beta_str = fmt_num(info.get('beta'))
        pe_str = fmt_num(info.get('pe_ratio'))
        rg_str = fmt_pct(info.get('rev_growth') * 100 if info.get('rev_growth') is not None else None)
        price_str = f"${info.get('current_price', 0):.2f}" if info.get('current_price') else '—'

        cards_html += f"""
        <div class="card">
            <div class="card-header" style="border-left:4px solid {color}">
                <span class="card-ticker">{ticker}</span>
                <span class="card-price">{price_str}</span>
            </div>
            <div class="card-company">{info.get('company_name', ticker)}</div>
            <div class="card-sector">{info.get('sector', 'Unknown')}</div>
            <div class="card-tags">{tags_html}</div>
            <table class="card-metrics">
                <tr><td>Market Cap</td><td>{mc}</td></tr>
                <tr><td>Beta</td><td>{beta_str}</td></tr>
                <tr><td>P/E (TTM)</td><td>{pe_str}</td></tr>
                <tr><td>Revenue Growth</td><td>{rg_str}</td></tr>
            </table>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Backtest Comparison — 10 Random Stocks</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 100vh;
  }}
  .topbar {{
    background: #166534;
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }}
  .topbar h1 {{ font-size: 1.2rem; font-weight: 700; color: #fff; }}
  .topbar .meta {{ font-size: 0.78rem; color: #bbf7d0; }}
  .container {{ max-width: 1400px; margin: 0 auto; padding: 24px; }}
  h2 {{ font-size: 1rem; font-weight: 700; color: #94a3b8; text-transform: uppercase;
        letter-spacing: .08em; margin-bottom: 16px; }}
  /* ---- classification cards ---- */
  .cards {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; margin-bottom: 36px; }}
  .card {{
    background: #1e293b;
    border-radius: 10px;
    padding: 14px;
    border: 1px solid #334155;
  }}
  .card-header {{ display: flex; justify-content: space-between; align-items: baseline;
                  padding-bottom: 4px; padding-left: 8px; margin-bottom: 4px; }}
  .card-ticker {{ font-size: 1.1rem; font-weight: 800; color: #f1f5f9; }}
  .card-price  {{ font-size: 0.95rem; color: #94a3b8; }}
  .card-company {{ font-size: 0.75rem; color: #64748b; margin-bottom: 2px; line-height: 1.3; }}
  .card-sector  {{ font-size: 0.7rem; color: #475569; margin-bottom: 10px; }}
  .card-tags {{ display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; }}
  .tag {{
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 700;
    color: #fff;
    padding: 2px 7px;
    border-radius: 99px;
    text-transform: uppercase;
    letter-spacing: .04em;
  }}
  .card-metrics {{ width: 100%; border-collapse: collapse; font-size: 0.76rem; }}
  .card-metrics td {{ padding: 3px 0; color: #94a3b8; }}
  .card-metrics td:last-child {{ text-align: right; color: #e2e8f0; font-weight: 600; }}
  /* ---- chart ---- */
  .chart-wrap {{
    background: #1e293b;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 36px;
    border: 1px solid #334155;
  }}
  .chart-wrap canvas {{ max-height: 380px; }}
  /* ---- accuracy table ---- */
  .tbl-wrap {{
    background: #1e293b;
    border-radius: 12px;
    padding: 20px;
    border: 1px solid #334155;
    overflow-x: auto;
  }}
  table.acc-tbl {{
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }}
  .acc-tbl th {{
    background: #0f172a;
    color: #64748b;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.68rem;
    letter-spacing: .06em;
    padding: 10px 12px;
    text-align: center;
    white-space: nowrap;
  }}
  .acc-tbl th:first-child, .acc-tbl td:first-child {{ text-align: left; }}
  .acc-tbl td {{
    padding: 10px 12px;
    border-top: 1px solid #1e293b;
    text-align: center;
    vertical-align: top;
  }}
  .acc-tbl tr:hover td {{ background: #1e293b44; }}
  td.na {{ color: #475569; font-size: 0.75rem; }}
  td.conf {{ color: #94a3b8; }}
  td.dim {{ color: #475569; }}
  .ticker-dot {{
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }}
  .company-name {{ font-size: 0.7rem; color: #64748b; margin-top: 1px; }}
  .tags-inline {{ margin-top: 5px; display: flex; flex-wrap: wrap; gap: 3px; }}
  .tags-inline .tag {{ font-size: 0.58rem; }}
  .horizon-group {{ background: #0f172a; }}
  .sub-th {{ font-size: 0.62rem !important; color: #475569 !important; letter-spacing: 0 !important; }}
  .legend-row {{ display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; font-size: 0.8rem; }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; color: #94a3b8; }}
  .legend-dot {{ width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }}
</style>
</head>
<body>
<div class="topbar">
  <h1>Backtest Comparison — 10 Random Stocks</h1>
  <div class="meta">
    Period: {start_date} → {end_date} &nbsp;|&nbsp; Step: every {step_days} days &nbsp;|&nbsp;
    Generated: {date.today().isoformat()}
  </div>
</div>
<div class="container">

  <h2>Stock Classification</h2>
  <div class="cards">
    {cards_html}
  </div>

  <h2>Normalized Price Performance (indexed to 100 at start)</h2>
  <div class="chart-wrap">
    <div class="legend-row">
      {"".join(
          f'<div class="legend-item"><div class="legend-dot" style="background:{CHART_COLORS[i % len(CHART_COLORS)]}"></div>{t}</div>'
          for i, t in enumerate(tickers)
      )}
    </div>
    <canvas id="priceChart"></canvas>
  </div>

  <h2>Backtest Accuracy Summary</h2>
  <p style="font-size:0.78rem;color:#475569;margin-bottom:14px;">
    Price Acc = proximity accuracy (how close the predicted price was to actual).
    Dir Acc = directional accuracy (up/down correct, neutral predictions excluded).
    Conf = average confidence score. Only resolved horizons included in accuracy.
  </p>
  <div class="tbl-wrap">
    <table class="acc-tbl">
      <thead>
        <tr>
          <th rowspan="2">Stock</th>
          <th rowspan="2" class="dim">Runs</th>
          <th colspan="3" class="horizon-group">1 Week</th>
          <th colspan="3" class="horizon-group">1 Month</th>
          <th colspan="3" class="horizon-group">3 Months</th>
          <th colspan="3" class="horizon-group">6 Months</th>
        </tr>
        <tr>
          <th class="sub-th">Price%</th><th class="sub-th">Dir%</th><th class="sub-th">Conf</th>
          <th class="sub-th">Price%</th><th class="sub-th">Dir%</th><th class="sub-th">Conf</th>
          <th class="sub-th">Price%</th><th class="sub-th">Dir%</th><th class="sub-th">Conf</th>
          <th class="sub-th">Price%</th><th class="sub-th">Dir%</th><th class="sub-th">Conf</th>
        </tr>
      </thead>
      <tbody>
        {acc_rows_html}
      </tbody>
    </table>
  </div>

</div>

<script>
const ctx = document.getElementById('priceChart').getContext('2d');
new Chart(ctx, {{
  type: 'line',
  data: {{
    labels: {labels_str},
    datasets: [{datasets_str}]
  }},
  options: {{
    responsive: true,
    interaction: {{ mode: 'index', intersect: false }},
    plugins: {{
      legend: {{
        labels: {{
          color: '#94a3b8',
          font: {{ size: 12 }},
          boxWidth: 12,
          padding: 16,
        }}
      }},
      tooltip: {{
        backgroundColor: '#0f172a',
        titleColor: '#e2e8f0',
        bodyColor: '#94a3b8',
        borderColor: '#334155',
        borderWidth: 1,
        callbacks: {{
          label: ctx => {{
            const v = ctx.parsed.y;
            if (v == null) return null;
            const pct = (v - 100).toFixed(2);
            const sign = pct >= 0 ? '+' : '';
            return ` ${{ctx.dataset.label}}: ${{v.toFixed(2)}} (${{sign}}${{pct}}%)`;
          }}
        }}
      }}
    }},
    scales: {{
      x: {{
        ticks: {{ color: '#475569', maxTicksLimit: 16, maxRotation: 30 }},
        grid: {{ color: '#1e293b' }}
      }},
      y: {{
        ticks: {{
          color: '#475569',
          callback: v => v.toFixed(0)
        }},
        grid: {{ color: '#1e293b' }},
        title: {{ display: true, text: 'Indexed (start = 100)', color: '#475569', font: {{ size: 11 }} }}
      }}
    }}
  }}
}});
</script>
</body>
</html>"""

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w') as f:
        f.write(html)
    print(f"\n[report] Written → {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Run backtest comparison for 10 random stocks.')
    parser.add_argument('--tickers', nargs='+', help='Override random stock selection')
    parser.add_argument('--step-days', type=int, default=7, help='Days between backtest runs (default: 7)')
    parser.add_argument('--days', type=int, default=None,
                        help='Calendar days back to start (overrides --start-date). e.g. --days 90 for 3 months')
    parser.add_argument('--diverse-caps', action='store_true',
                        help='Ensure a mix of small/mid/large cap stocks (default: pure random)')
    parser.add_argument('--diverse-count', type=int, default=10,
                        help='Number of tickers to pick when using --diverse-caps (default: 10)')
    parser.add_argument('--skip-backtest', action='store_true',
                        help='Skip running the backtest; just pull existing DB data and re-generate the report')
    parser.add_argument('--start-date', default=START_DATE, help=f'Backtest start (default: {START_DATE})')
    parser.add_argument('--end-date',   default=END_DATE,   help=f'Backtest end   (default: {END_DATE})')
    args = parser.parse_args()

    # --days overrides --start-date
    if args.days is not None:
        args.start_date = (TODAY - timedelta(days=args.days)).isoformat()
        print(f"[period] --days {args.days} → start_date={args.start_date}")

    conn = get_db_connection()

    # 1. Stock selection
    if args.tickers:
        tickers = [t.upper() for t in args.tickers]
        print(f"[selection] Using provided tickers: {tickers}")
    elif args.diverse_caps:
        print(f"[selection] Building diverse cap mix (small/mid/large), n={args.diverse_count}...")
        tickers = pick_diverse_stocks(conn, args.diverse_count)
        print(f"[selection] Cap-diverse selection: {tickers}")
    else:
        tickers = pick_random_stocks(conn, 10)
        print(f"[selection] Randomly selected: {tickers}")

    # 2. Classify
    stocks_data = {}
    for ticker in tickers:
        print(f"[classify]  {ticker} ...", end=' ', flush=True)
        stocks_data[ticker] = classify_stock(ticker)
        tags = stocks_data[ticker]['tags']
        name = stocks_data[ticker]['data'].get('company_name', '?')
        print(f"{name} → {tags}")

    # 3. Backtest
    if not args.skip_backtest:
        ok = run_backtest(tickers, args.start_date, args.end_date, args.step_days)
        if not ok:
            print("[warning] Backtest process exited non-zero — results may be partial.")
    else:
        print("[skip-backtest] Skipping model run, using existing DB rows.")

    # 4. Fetch DB results — reconnect so we see rows committed by the subprocess
    conn.close()
    conn = get_db_connection()
    results_by_ticker = fetch_backtest_results(conn, tickers, args.start_date, args.end_date)
    print(f"\n[db] Fetched rows per ticker: { {t: len(results_by_ticker[t]) for t in tickers} }")

    # 5. Price histories for chart
    print("[prices] Fetching price history for chart...")
    price_histories = {}
    for ticker in tickers:
        price_histories[ticker] = fetch_price_history(ticker, args.start_date, args.end_date)

    # 6. Print text comparison table
    print_comparison_table(stocks_data, results_by_ticker)

    # 7. Generate HTML
    output_path = os.path.join(PROJECT_ROOT, 'doc', 'backtest_comparison.html')
    generate_html(
        stocks_data, results_by_ticker, price_histories,
        args.start_date, args.end_date, args.step_days, output_path
    )

    conn.close()
    print(f"\nDone. Open: file://{output_path}")


if __name__ == '__main__':
    main()
