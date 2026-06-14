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

import base64
import mimetypes

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
    logo_svg: str = ""
    logo_source: str = "fallback"


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



# ---------------------------------------------------------------------------
# SVG logo generation
# ---------------------------------------------------------------------------

SVG_SIZE = 48  # px — the canonical square we produce
MIN_SOURCE_PX = 48  # raster sources smaller than this look pixelated when scaled up
MAX_ASPECT_RATIO = 1.5  # reject wider/taller than 1.5:1 — those are wordmarks, not square marks
WIKIDATA_API = "https://www.wikidata.org/w/api.php"


_VIEWBOX_RE = re.compile(
    r"viewBox\s*=\s*[\"']\s*[-\d.eE]+\s+[-\d.eE]+\s+([-\d.eE]+)\s+([-\d.eE]+)\s*[\"']",
    flags=re.IGNORECASE,
)
_SVG_WIDTH_RE = re.compile(
    r"<svg[^>]*?\bwidth\s*=\s*[\"']\s*([-\d.eE]+)(?:px)?\s*[\"']",
    flags=re.IGNORECASE,
)
_SVG_HEIGHT_RE = re.compile(
    r"<svg[^>]*?\bheight\s*=\s*[\"']\s*([-\d.eE]+)(?:px)?\s*[\"']",
    flags=re.IGNORECASE,
)


def _image_dimensions(image_bytes: bytes) -> tuple[int, int] | None:
    """Return (width, height) of a raster image. None on parse failure.
    For ICO files PIL auto-loads the largest embedded frame."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(image_bytes)) as img:
            return img.size
    except Exception:
        return None


def _svg_native_dimensions(svg_text: str) -> tuple[float, float] | None:
    """Read viewBox width/height, falling back to <svg width=/height=>."""
    m = _VIEWBOX_RE.search(svg_text)
    if m:
        try:
            return float(m.group(1)), float(m.group(2))
        except ValueError:
            pass
    w = _SVG_WIDTH_RE.search(svg_text)
    h = _SVG_HEIGHT_RE.search(svg_text)
    if w and h:
        try:
            return float(w.group(1)), float(h.group(1))
        except ValueError:
            return None
    return None


def _aspect_ok(w: float, h: float) -> bool:
    """True if width:height is close enough to square (1:1.5 .. 1.5:1)."""
    if w <= 0 or h <= 0:
        return False
    ratio = w / h
    return (1.0 / MAX_ASPECT_RATIO) <= ratio <= MAX_ASPECT_RATIO


def _image_bytes_to_data_uri(image_bytes: bytes, url: str) -> str:
    """Convert raw image bytes to a data URI, guessing mime type from URL."""
    mime = mimetypes.guess_type(url.split("?")[0])[0] or "image/png"
    # Treat .ico as image/x-icon so browsers render it
    if url.lower().endswith(".ico"):
        mime = "image/x-icon"
    encoded = base64.b64encode(image_bytes).decode()
    return f"data:{mime};base64,{encoded}"


def _svg_from_data_uri(data_uri: str, ticker: str) -> str:
    """Wrap a logo data URI in a square SVG with rounded corners."""
    s = SVG_SIZE
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {s} {s}" width="{s}" height="{s}">'
        f'<rect width="{s}" height="{s}" rx="12" ry="12" fill="#ffffff"/>'
        f'<image href="{data_uri}" x="4" y="4" width="{s-8}" height="{s-8}" '
        f'preserveAspectRatio="xMidYMid meet"/>'
        f'</svg>'
    )


def _svg_fallback(ticker: str, bg_color: str) -> str:
    """Generic square SVG: brand-color background + first letter of ticker."""
    s = SVG_SIZE
    letter = ticker[0].upper() if ticker else "?"
    # Pick white or dark text depending on luminance of bg
    try:
        r = int(bg_color[1:3], 16)
        g = int(bg_color[3:5], 16)
        b = int(bg_color[5:7], 16)
        luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        text_color = "#ffffff" if luminance < 0.55 else "#1a1a1a"
    except Exception:
        text_color = "#ffffff"

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {s} {s}" width="{s}" height="{s}">'
        f'<rect width="{s}" height="{s}" rx="12" ry="12" fill="{bg_color}"/>'
        f'<text x="{s//2}" y="{s//2}" '
        f'font-family="system-ui, -apple-system, sans-serif" '
        f'font-size="{s//2}" font-weight="700" fill="{text_color}" '
        f'text-anchor="middle" dominant-baseline="central">{letter}</text>'
        f'</svg>'
    )


LINK_TAG_PATTERN = re.compile(r"<link\b([^>]*?)/?>", flags=re.IGNORECASE)
_REL_ATTR = re.compile(r"rel\s*=\s*[\"']([^\"']+)[\"']", flags=re.IGNORECASE)
_HREF_ATTR = re.compile(r"href\s*=\s*[\"']([^\"']+)[\"']", flags=re.IGNORECASE)
_SIZES_ATTR = re.compile(r"sizes\s*=\s*[\"']([^\"']+)[\"']", flags=re.IGNORECASE)
_TYPE_ATTR = re.compile(r"type\s*=\s*[\"']([^\"']+)[\"']", flags=re.IGNORECASE)

# Treat 'any' (SVG) as the largest possible hint; apple-touch defaults to 180.
_SVG_HINT = 9999
_APPLE_TOUCH_DEFAULT = 180


def _parse_sizes_attr(sizes_attr: str) -> int:
    """Parse a sizes="…" value; return the largest dimension found, or 0."""
    if not sizes_attr:
        return 0
    best = 0
    for tok in sizes_attr.strip().lower().split():
        if tok == "any":
            best = max(best, _SVG_HINT)
        else:
            m = re.match(r"(\d+)\s*x\s*\d+", tok)
            if m:
                best = max(best, int(m.group(1)))
    return best


def collect_icon_candidates(html: str, base_url: str) -> list[tuple[str, int, str]]:
    """Find all <link rel="…icon…"> tags in the page and return them ranked
    by the largest declared size first. Returns [(url, size_hint, label), …]."""
    seen: set[str] = set()
    candidates: list[tuple[str, int, str]] = []

    for link_match in LINK_TAG_PATTERN.finditer(html):
        attrs = link_match.group(1)
        rel_m = _REL_ATTR.search(attrs)
        href_m = _HREF_ATTR.search(attrs)
        if not rel_m or not href_m:
            continue
        rel = rel_m.group(1).lower()
        if "icon" not in rel:
            continue

        href = href_m.group(1)
        sizes_m = _SIZES_ATTR.search(attrs)
        type_m = _TYPE_ATTR.search(attrs)
        size_hint = _parse_sizes_attr(sizes_m.group(1)) if sizes_m else 0

        is_svg = href.lower().endswith(".svg") or (
            type_m and "svg" in type_m.group(1).lower()
        )
        is_apple_touch = "apple-touch-icon" in rel

        if is_svg:
            size_hint = max(size_hint, _SVG_HINT)
            label = "svg_favicon"
        elif is_apple_touch:
            if size_hint == 0:
                size_hint = _APPLE_TOUCH_DEFAULT
            label = "apple_touch_icon"
        else:
            label = "favicon"

        url = urljoin(base_url, href)
        if url not in seen:
            seen.add(url)
            candidates.append((url, size_hint, label))

    # Always include the conventional /favicon.ico as a low-priority fallback.
    parsed = urlparse(base_url)
    if parsed.scheme and parsed.netloc:
        default_ico = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"
        if default_ico not in seen:
            candidates.append((default_ico, 0, "favicon"))

    candidates.sort(key=lambda c: -c[1])
    return candidates


def _try_use_image(
    image_bytes: bytes, source_url: str, label: str, ticker: str
) -> tuple[str, str] | None:
    """Validate a fetched image and wrap it into our square SVG.

    All sources are wrapped in the canonical SVG_SIZE square so cards render
    consistently. Sources are rejected when:
      - raster < MIN_SOURCE_PX on the largest side (avoids pixelated upscale)
      - aspect ratio falls outside MAX_ASPECT_RATIO (filters wordmarks/banners)
    """
    if not image_bytes or len(image_bytes) < 100:
        return None

    is_svg = source_url.lower().endswith(".svg") or b"<svg" in image_bytes[:512]

    if is_svg:
        try:
            svg_text = image_bytes.decode("utf-8", errors="replace")
        except Exception:
            return None
        if "<svg" not in svg_text:
            return None
        dims = _svg_native_dimensions(svg_text)
        if dims is None or not _aspect_ok(*dims):
            return None
        # Wrap the external SVG inside our square via base64 data URI so the
        # browser fits it with preserveAspectRatio.
        data_uri = "data:image/svg+xml;base64," + base64.b64encode(image_bytes).decode()
        return _svg_from_data_uri(data_uri, ticker), label

    dims = _image_dimensions(image_bytes)
    if dims is None:
        return None
    w, h = dims
    if max(w, h) < MIN_SOURCE_PX or not _aspect_ok(w, h):
        return None
    return _svg_from_data_uri(_image_bytes_to_data_uri(image_bytes, source_url), ticker), label


def fetch_logo_svg(
    html: str,
    base_url: str,
    session: requests.Session,
    ticker: str,
    brand_color: str,
) -> tuple[str, str]:
    """Try to build an SVG logo from the site; fall back to a branded square.

    Returns (svg_string, source_label).
    """
    for icon_url, _size_hint, label in collect_icon_candidates(html, base_url):
        image_bytes = fetch_binary_image(icon_url, session)
        result = _try_use_image(image_bytes or b"", icon_url, label, ticker)
        if result is not None:
            return result

    # og:image / <img class="logo"> as a last raster source (often very large)
    og_url = extract_logo_url(html, base_url)
    if og_url:
        image_bytes = fetch_binary_image(og_url, session)
        result = _try_use_image(image_bytes or b"", og_url, "og_image", ticker)
        if result is not None:
            return result

    # Nothing usable — generate a branded fallback
    return _svg_fallback(ticker, brand_color), "fallback"


# ---------------------------------------------------------------------------
# Wikidata logo lookup
# ---------------------------------------------------------------------------


def _wikidata_search_entities(query: str, session: requests.Session) -> list[dict]:
    """Search Wikidata for items matching query. Returns hits with id/label."""
    try:
        r = session.get(WIKIDATA_API, params={
            "action": "wbsearchentities",
            "search": query,
            "language": "en",
            "type": "item",
            "limit": 5,
            "format": "json",
        }, timeout=8)
        if not r.ok:
            return []
        return r.json().get("search", []) or []
    except Exception:
        return []


def _wikidata_get_claims(entity_id: str, session: requests.Session) -> dict | None:
    """Fetch a Wikidata entity's claims dict (property → list of statements)."""
    try:
        r = session.get(WIKIDATA_API, params={
            "action": "wbgetentities",
            "ids": entity_id,
            "props": "claims",
            "format": "json",
        }, timeout=8)
        if not r.ok:
            return None
        return r.json().get("entities", {}).get(entity_id, {}).get("claims", {})
    except Exception:
        return None


def _claim_string_values(claims: dict, prop: str) -> list[str]:
    """Pull string values from a property's claim list (e.g. P249 tickers)."""
    out: list[str] = []
    for statement in claims.get(prop, []) or []:
        val = statement.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(val, str):
            out.append(val)
    return out


def _commons_filepath_url(filename: str) -> str:
    """Wikimedia Commons FilePath endpoint redirects to the actual image."""
    from urllib.parse import quote
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename)}"


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def fetch_wikidata_logo(
    ticker: str, company: str, session: requests.Session
) -> tuple[str, str] | None:
    """Try Wikidata for a high-quality brand logo.

    Strategy: search by company name, then for each hit verify via P249
    (ticker symbol). If no P249 match, accept the top hit only when its
    label closely matches the company name. Returns (svg, "wikidata") or None.
    """
    if not company and not ticker:
        return None

    queries = [q for q in (company, f"{company} {ticker}".strip(), ticker) if q]
    seen_ids: set[str] = set()
    company_slug = _slug(company)
    fallback_logo_file: str | None = None

    for query in queries:
        for i, hit in enumerate(_wikidata_search_entities(query, session)):
            entity_id = hit.get("id")
            if not entity_id or entity_id in seen_ids:
                continue
            seen_ids.add(entity_id)

            claims = _wikidata_get_claims(entity_id, session)
            if not claims:
                continue
            logo_files = _claim_string_values(claims, "P154")
            if not logo_files:
                continue

            tickers = [t.upper() for t in _claim_string_values(claims, "P249")]
            ticker_match = ticker and ticker.upper() in tickers
            label_match = company_slug and company_slug in _slug(hit.get("label", ""))

            if ticker_match:
                # Confident — fetch & return immediately
                logo_url = _commons_filepath_url(logo_files[0])
                image_bytes = fetch_binary_image(logo_url, session)
                result = _try_use_image(image_bytes or b"", logo_url, "wikidata", ticker)
                if result is not None:
                    return result
            elif fallback_logo_file is None and i == 0 and label_match:
                # Top hit with a logo and matching label — hold as fallback
                fallback_logo_file = logo_files[0]

    if fallback_logo_file:
        logo_url = _commons_filepath_url(fallback_logo_file)
        image_bytes = fetch_binary_image(logo_url, session)
        return _try_use_image(image_bytes or b"", logo_url, "wikidata", ticker)
    return None


def save_brand_color_to_db(ticker: str, company: str, color: str, logo_svg: str = "") -> bool:
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
            INSERT INTO stock_brand (ticker, company_name, primary_color, logo)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              company_name  = VALUES(company_name),
              primary_color = VALUES(primary_color),
              logo          = VALUES(logo)
            """,
            (ticker, company, color, logo_svg or None),
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

    # Wikidata is independent of the website and often returns vector logos.
    # Run it once up front; reuse the result whether or not we reach a site.
    wikidata_logo = fetch_wikidata_logo(ticker, company, session)

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
        if wikidata_logo:
            svg, logo_src = wikidata_logo
        else:
            svg, logo_src = _svg_fallback(ticker, DEFAULT_COLOR), "fallback"
        return LookupResult(
            ticker=ticker, company=company, website=None,
            color=DEFAULT_COLOR, source="default",
            logo_svg=svg, logo_source=logo_src,
        )

    # Proceed with analysis for the FIRST reachable URL only
    page = fetch_url(reachable_url, session)
    if not page:
        if wikidata_logo:
            svg, logo_src = wikidata_logo
        else:
            svg, logo_src = _svg_fallback(ticker, DEFAULT_COLOR), "fallback"
        return LookupResult(
            ticker=ticker, company=company, website=reachable_url,
            color=DEFAULT_COLOR, source="default",
            logo_svg=svg, logo_source=logo_src,
        )

    final_url = page.url
    html = page.text

    # Determine brand color (existing multi-step logic)
    brand_color = DEFAULT_COLOR
    color_source = "default"

    # STEP 1: LOGO ANALYSIS
    logo_url = extract_logo_url(html, final_url)
    if logo_url:
        logo_bytes = fetch_binary_image(logo_url, session)
        if logo_bytes:
            logo_color = dominant_color_from_image(logo_bytes)
            if logo_color:
                brand_color, color_source = logo_color, "logo"

    # STEP 2: FAVICON ANALYSIS (only if color not yet found)
    if color_source == "default":
        for favicon_url in extract_favicon_urls(html, final_url):
            icon_bytes = fetch_binary_image(favicon_url, session)
            if not icon_bytes:
                continue
            favicon_color = dominant_color_from_image(icon_bytes)
            if favicon_color:
                brand_color, color_source = favicon_color, "favicon"
                break

    # STEP 3: SCREENSHOT ANALYSIS (only if color not yet found)
    if color_source == "default":
        screenshot_color = fetch_screenshot_color(final_url)
        if screenshot_color:
            brand_color, color_source = screenshot_color, "screenshot"

    # STEP 4: CSS FALLBACK (only if color not yet found)
    if color_source == "default":
        css_color = fetch_css_color(html, final_url, session)
        if css_color:
            brand_color, color_source = css_color, "css"

    # Generate SVG logo. Prefer Wikidata when we have it; otherwise discover
    # from the page (apple-touch / sized favicon / og:image), and finally fall
    # back to a clean letter tile if every source is too small.
    if wikidata_logo:
        logo_svg, logo_source = wikidata_logo
    else:
        logo_svg, logo_source = fetch_logo_svg(html, final_url, session, ticker, brand_color)

    return LookupResult(
        ticker=ticker,
        company=company,
        website=final_url,
        color=brand_color,
        source=color_source,
        logo_svg=logo_svg,
        logo_source=logo_source,
    )


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
    db_saved = save_brand_color_to_db(
        result.ticker, result.company, result.color, result.logo_svg
    )
    print(
        json.dumps(
            {
                "ticker": result.ticker,
                "company": result.company,
                "website": result.website,
                "brand_color": result.color,
                "color_source": result.source,
                "logo_source": result.logo_source,
                "logo_svg_length": len(result.logo_svg),
                "saved_to_db": db_saved,
            }
        )
    )


if __name__ == "__main__":
    main()