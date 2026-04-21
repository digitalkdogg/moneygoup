#!/usr/bin/env python3
"""Find a company's brand color by inspecting website CSS and imagery.

Usage:
  python scripts/find_brand_color.py --ticker WMT --company "Walmart"
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urljoin, urlparse

import requests

DEFAULT_COLOR = "#777"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT = 12

HEX_PATTERN = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b")
RGB_PATTERN = re.compile(
    r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[^)]*)?\)"
)
HREF_PATTERN = re.compile(
    r"<link[^>]+rel=[\"'][^\"']*stylesheet[^\"']*[\"'][^>]*href=[\"']([^\"']+)[\"']",
    flags=re.IGNORECASE,
)
STYLE_BLOCK_PATTERN = re.compile(r"<style[^>]*>(.*?)</style>", flags=re.IGNORECASE | re.DOTALL)
LOGO_META_PATTERN = re.compile(
    r"<meta[^>]+(?:property|name)=[\"'](?:og:image|twitter:image)[\"'][^>]*content=[\"']([^\"']+)[\"']",
    flags=re.IGNORECASE,
)
IMG_PATTERN = re.compile(
    r"<img[^>]+(?:class|id|alt|src)=[^>]*(?:logo|brand)[^>]*src=[\"']([^\"']+)[\"']",
    flags=re.IGNORECASE,
)
ICON_PATTERN = re.compile(
    r"<link[^>]+rel=[\"'][^\"']*(?:icon|shortcut icon|apple-touch-icon)[^\"']*[\"'][^>]*href=[\"']([^\"']+)[\"']",
    flags=re.IGNORECASE,
)


@dataclass
class LookupResult:
    ticker: str
    company: str
    website: str | None
    color: str
    source: str


def load_database_env() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)

    try:
        from dotenv import load_dotenv
    except ImportError:
        return

    production_env = os.path.join(project_root, ".env.production")
    local_env = os.path.join(project_root, ".env.local")

    if os.path.exists(production_env):
        load_dotenv(production_env)
    if os.path.exists(local_env):
        load_dotenv(local_env)


def save_brand_color_to_db(ticker: str, company: str, color: str) -> bool:
    load_database_env()

    db_host = os.getenv("DB_HOST", "localhost")
    db_user = os.getenv("DB_USER")
    db_password = os.getenv("DB_PASSWORD")
    db_database = os.getenv("DB_DATABASE")

    if not db_user or not db_database:
        return False

    try:
        import mysql.connector

        conn = mysql.connector.connect(
            host=db_host,
            user=db_user,
            password=db_password,
            database=db_database,
        )
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO stock_brand (ticker, company_name, primary_color)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE
              company_name = VALUES(company_name),
              primary_color = VALUES(primary_color)
            """,
            (ticker, company, color),
        )
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Exception:
        return False


def build_domain_candidates(company_name: str, ticker: str = "") -> list[str]:
    # remove common suffixes including L.P. and L.P
    name = re.sub(r"\b(inc|corp|corporation|ltd|limited|s\.?a\.?|p\.?l\.?c\.?|company|lp|l\.p\.?|partners|holdings|group|pvt|public|ag|gmbh|nv|spa)\b.*$", "", company_name, flags=re.IGNORECASE).strip()
    
    candidates = []
    
    # Try full name slug first (usually better than ticker for brand domains)
    slug = re.sub(r"[^a-z0-9]", "", name.lower())
    if slug:
        candidates.extend([f"https://{slug}.com", f"https://www.{slug}.com"])
        
    # Try ticker-based domains if available
    if ticker:
        t_slug = ticker.lower()
        candidates.extend([f"https://{t_slug}.com", f"https://www.{t_slug}.com"])

    # Try just the first word (often the main brand domain)
    first_word = re.sub(r"[^a-z0-9]", "", name.split()[0].lower())
    if first_word and first_word != slug:
        candidates.extend([f"https://{first_word}.com", f"https://www.{first_word}.com"])

    if not candidates:
        full_slug = re.sub(r"[^a-z0-9]", "", company_name.lower())
        if full_slug:
            candidates.extend([f"https://{full_slug}.com", f"https://www.{full_slug}.com"])
            
    # Deduplicate while preserving order
    seen = set()
    return [x for x in candidates if not (x in seen or seen.add(x))]


def fetch_url(url: str, session: requests.Session) -> requests.Response | None:
    try:
        response = session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if response.ok and "text/html" in response.headers.get("Content-Type", ""):
            return response
    except requests.RequestException:
        return None
    return None


def normalize_hex(color: str) -> str:
    color = color.lower()
    if len(color) == 4:
        return "#" + "".join(ch * 2 for ch in color[1:])
    return color


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def parse_rgb_match(match: tuple[str, str, str]) -> tuple[int, int, int] | None:
    try:
        r, g, b = (int(v) for v in match)
        if 0 <= r <= 255 and 0 <= g <= 255 and 0 <= b <= 255:
            return r, g, b
    except ValueError:
        return None
    return None


def is_useful_brand_color(hex_color: str) -> bool:
    r = int(hex_color[1:3], 16)
    g = int(hex_color[3:5], 16)
    b = int(hex_color[5:7], 16)

    if max(r, g, b) < 30 or min(r, g, b) > 240:
        return False

    if abs(r - g) < 20 and abs(g - b) < 20 and abs(r - b) < 20:
        return False

    return True


def extract_colors_from_css(css_text: str) -> list[str]:
    colors: list[str] = [normalize_hex(m.group()) for m in HEX_PATTERN.finditer(css_text)]
    for rgb_match in RGB_PATTERN.findall(css_text):
        rgb = parse_rgb_match(rgb_match)
        if rgb:
            colors.append(rgb_to_hex(rgb))
    return [c for c in colors if is_useful_brand_color(c)]


def extract_css_urls_and_inline_styles(html: str, base_url: str) -> tuple[list[str], list[str]]:
    urls = [urljoin(base_url, href) for href in HREF_PATTERN.findall(html)]
    inline_styles = [m.group(1) for m in STYLE_BLOCK_PATTERN.finditer(html)]
    return urls, inline_styles


def best_color(colors: Iterable[str]) -> str | None:
    counts = Counter(colors)
    if not counts:
        return None
    return counts.most_common(1)[0][0]


def fetch_css_color(html: str, base_url: str, session: requests.Session) -> str | None:
    css_urls, inline_styles = extract_css_urls_and_inline_styles(html, base_url)
    color_hits: list[str] = []

    for style in inline_styles:
        color_hits.extend(extract_colors_from_css(style))

    for css_url in css_urls[:12]:
        try:
            response = session.get(css_url, timeout=REQUEST_TIMEOUT)
            if response.ok and "text/css" in response.headers.get("Content-Type", ""):
                color_hits.extend(extract_colors_from_css(response.text))
        except requests.RequestException:
            continue

    return best_color(color_hits)


def fetch_binary_image(url: str, session: requests.Session) -> bytes | None:
    try:
        response = session.get(url, timeout=REQUEST_TIMEOUT)
        if response.ok:
            return response.content
    except requests.RequestException:
        return None
    return None


def dominant_color_from_image(image_bytes: bytes) -> str | None:
    try:
        from PIL import Image
        import warnings

        with Image.open(io.BytesIO(image_bytes)) as image:
            image = image.convert("RGBA")
            image.thumbnail((200, 200))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=DeprecationWarning)
                pixels = list(image.getdata())
    except Exception:
        return None

    filtered: list[tuple[int, int, int]] = []
    for r, g, b, a in pixels:
        if a < 100:
            continue
        hex_color = rgb_to_hex((r, g, b))
        if is_useful_brand_color(hex_color):
            filtered.append((r, g, b))

    if not filtered:
        return None

    return rgb_to_hex(Counter(filtered).most_common(1)[0][0])


def extract_logo_url(html: str, base_url: str) -> str | None:
    for pattern in (LOGO_META_PATTERN, IMG_PATTERN):
        match = pattern.search(html)
        if match:
            return urljoin(base_url, match.group(1))
    return None


def extract_favicon_urls(html: str, base_url: str) -> list[str]:
    urls = [urljoin(base_url, href) for href in ICON_PATTERN.findall(html)]
    parsed = urlparse(base_url)
    if parsed.scheme and parsed.netloc:
        urls.append(f"{parsed.scheme}://{parsed.netloc}/favicon.ico")
    # preserve order while deduplicating
    seen = set()
    deduped: list[str] = []
    for url in urls:
        if url not in seen:
            deduped.append(url)
            seen.add(url)
    return deduped


def find_brand_color(ticker: str, company: str) -> LookupResult:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    reachable_url = None
    candidates = build_domain_candidates(company, ticker)
    
    # FAST PING: Find the first reachable URL
    for candidate_url in candidates:
        try:
            # Short 3-second timeout for the "ping"
            response = session.head(candidate_url, timeout=3, allow_redirects=True)
            if response.ok:
                reachable_url = response.url
                break
        except requests.RequestException:
            continue
            
    if not reachable_url:
        return LookupResult(ticker=ticker, company=company, website=None, color=DEFAULT_COLOR, source="default")

    # Proceed with analysis for the FIRST reachable URL only
    page = fetch_url(reachable_url, session)
    if not page:
         return LookupResult(ticker=ticker, company=company, website=reachable_url, color=DEFAULT_COLOR, source="default")

    final_url = page.url
    html = page.text

    # STEP 1: LOGO ANALYSIS
    logo_url = extract_logo_url(html, final_url)
    if logo_url:
        logo_bytes = fetch_binary_image(logo_url, session)
        if logo_bytes:
            logo_color = dominant_color_from_image(logo_bytes)
            if logo_color:
                return LookupResult(
                    ticker=ticker,
                    company=company,
                    website=final_url,
                    color=logo_color,
                    source="logo",
                )

    # STEP 2: FAVICON ANALYSIS
    for favicon_url in extract_favicon_urls(html, final_url):
        icon_bytes = fetch_binary_image(favicon_url, session)
        if not icon_bytes:
            continue
        favicon_color = dominant_color_from_image(icon_bytes)
        if favicon_color:
            return LookupResult(
                ticker=ticker,
                company=company,
                website=final_url,
                color=favicon_color,
                source="favicon",
            )

    # STEP 3: SCREENSHOT ANALYSIS (The "Nuclear Option")
    screenshot_color = fetch_screenshot_color(final_url)
    if screenshot_color:
        return LookupResult(
            ticker=ticker,
            company=company,
            website=final_url,
            color=screenshot_color,
            source="screenshot",
        )

    # OPTIONAL STEP 4: CSS FALLBACK
    css_color = fetch_css_color(html, final_url, session)
    if css_color:
        return LookupResult(ticker=ticker, company=company, website=final_url, color=css_color, source="css")

    return LookupResult(ticker=ticker, company=company, website=final_url, color=DEFAULT_COLOR, source="default")


def fetch_screenshot_color(url: str) -> str | None:
    """Take a screenshot of the page and extract the dominant brand color."""
    try:
        from playwright.sync_api import sync_playwright
        import contextlib

        with sync_playwright() as p:
            # Silence potential browser launch errors (missing dependencies)
            with contextlib.redirect_stderr(io.StringIO()):
                try:
                    browser = p.chromium.launch(headless=True)
                except Exception:
                    return None
            
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            
            # Navigate and wait for network to be idle
            page.goto(url, wait_until="networkidle", timeout=15000)
            
            # Take a screenshot of the top half (likely to contain brand colors)
            screenshot_bytes = page.screenshot(full_page=False)
            browser.close()
            
            if screenshot_bytes:
                # Use a more restrictive filter for screenshots to avoid white/black backgrounds
                return dominant_color_from_screenshot(screenshot_bytes)
    except Exception:
        # Silently fail if screenshotting doesn't work (fall back to CSS)
        return None
    return None


def dominant_color_from_screenshot(image_bytes: bytes) -> str | None:
    """Analyze a full screenshot, focusing on non-neutral dominant colors."""
    try:
        from PIL import Image
        import warnings

        with Image.open(io.BytesIO(image_bytes)) as image:
            image = image.convert("RGBA")
            # Downsample heavily for speed and to group similar colors
            image.thumbnail((400, 400))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=DeprecationWarning)
                pixels = list(image.getdata())
    except Exception:
        return None

    filtered: list[tuple[int, int, int]] = []
    for r, g, b, a in pixels:
        if a < 255: continue # Ignore transparency
        
        hex_color = rgb_to_hex((r, g, b))
        
        # STRICTOR FILTERING FOR SCREENSHOTS
        # We want to ignore common UI colors like white, black, and light greys
        brightness = (r * 299 + g * 587 + b * 114) / 1000
        if brightness > 240 or brightness < 30: continue
        
        # Check saturation (distance from grey)
        if abs(r - g) < 25 and abs(g - b) < 25 and abs(r - b) < 25:
            continue
            
        filtered.append((r, g, b))

    if not filtered:
        return None

    # Count frequencies
    counts = Counter(filtered)
    if not counts:
        return None
        
    # Return the most common non-neutral color
    return rgb_to_hex(counts.most_common(1)[0][0])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Find company brand color from website/CSS/logo/favicon")
    parser.add_argument("--ticker", required=True, help="Ticker symbol, e.g. WMT")
    parser.add_argument("--company", required=True, help="Company name, e.g. Walmart")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = find_brand_color(ticker=args.ticker, company=args.company)
    db_saved = save_brand_color_to_db(result.ticker, result.company, result.color)
    print(
        json.dumps(
            {
                "ticker": result.ticker,
                "company": result.company,
                "website": result.website,
                "brand_color": result.color,
                "source": result.source,
                "saved_to_db": db_saved,
            }
        )
    )


if __name__ == "__main__":
    main()
