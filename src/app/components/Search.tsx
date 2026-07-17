'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createLogger } from '@/utils/logger';

const logger = createLogger('components/Search');

interface SearchResult {
  symbol: string
  name: string
  sector: string | null
  industry: string | null
  size: string | null
  marketCap: number | null
  matchType: 'exact' | 'prefix' | 'fulltext'
}

const SIZE_LABEL: Record<string, string> = {
  mega:  'Mega-cap',
  large: 'Large-cap',
  mid:   'Mid-cap',
  small: 'Small-cap',
  micro: 'Micro-cap',
  nano:  'Nano-cap',
};

function categoryChip(r: SearchResult): string | null {
  const parts: string[] = [];
  if (r.size && SIZE_LABEL[r.size]) parts.push(SIZE_LABEL[r.size]);
  if (r.industry) parts.push(r.industry);
  else if (r.sector) parts.push(r.sector);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function Search() {
  const [searchValue, setSearchValue] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  // -1 = no highlight (Enter falls back to first result / raw ticker).
  const [highlight, setHighlight] = useState(-1)
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const runSearch = useCallback((q: string) => {
    if (abortRef.current) abortRef.current.abort();
    if (!q.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`Search API ${res.status}`);
        return res.json();
      })
      .then(data => {
        setResults(Array.isArray(data.results) ? data.results : []);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        logger.error('Search request failed', { error: err });
        setResults([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(searchValue), 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchValue, runSearch]);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  // Reset highlight whenever the result set changes so keyboard focus can't
  // point at a row that no longer exists.
  useEffect(() => {
    setHighlight(-1);
  }, [results]);

  // Keep the highlighted row scrolled into view when navigating past the
  // visible slice of the dropdown.
  useEffect(() => {
    if (highlight < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLLIElement>(
      `[data-idx="${highlight}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value);
    setOpen(true);
  }

  const go = useCallback((target: string) => {
    if (!target) return;
    setOpen(false);
    router.push(`/search/${target}`);
  }, [router]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Only intercept navigation keys when the dropdown is showing results.
    const hasResults = open && results.length > 0;

    if (e.key === 'ArrowDown' && hasResults) {
      e.preventDefault();
      setHighlight(h => (h + 1) % results.length);
      return;
    }
    if (e.key === 'ArrowUp' && hasResults) {
      e.preventDefault();
      setHighlight(h => (h <= 0 ? results.length - 1 : h - 1));
      return;
    }
    if (e.key === 'Home' && hasResults) {
      e.preventDefault();
      setHighlight(0);
      return;
    }
    if (e.key === 'End' && hasResults) {
      e.preventDefault();
      setHighlight(results.length - 1);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setHighlight(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Priority: highlighted row → first result → raw ticker guess.
      const target =
        (highlight >= 0 && results[highlight]?.symbol) ||
        results[0]?.symbol ||
        searchValue.trim().toUpperCase();
      go(target);
    }
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const target =
      (highlight >= 0 && results[highlight]?.symbol) ||
      results[0]?.symbol ||
      searchValue.trim().toUpperCase();
    go(target);
  }

  const showDropdown = open && Boolean(searchValue) && (loading || results.length > 0);

  return (
    <div className="w-full">
      <form
        onSubmit={handleSubmit}
        className="relative w-full"
        role="combobox"
        aria-expanded={showDropdown}
        aria-haspopup="listbox"
        aria-owns="search-results-listbox"
      >
        <input
          type="text"
          value={searchValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          // Delay close so a click on a result registers before blur hides it.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder="Search a ticker, company, or category (e.g. Large Retail)…"
          className="w-full p-4 text-lg border-2 border-gray-300 rounded-xl shadow-lg focus:outline-none focus-visible:!outline-none focus:border-[#017e3b] transition duration-200"
          autoComplete="off"
          aria-autocomplete="list"
          aria-controls="search-results-listbox"
          aria-activedescendant={
            highlight >= 0 && results[highlight]
              ? `search-result-${results[highlight].symbol}`
              : undefined
          }
        />
        {showDropdown && (
          <ul
            ref={listRef}
            id="search-results-listbox"
            role="listbox"
            className="absolute z-10 w-full bg-white border-2 border-gray-300 rounded-xl shadow-xl mt-2 max-h-80 overflow-y-auto"
          >
            {loading && results.length === 0 && (
              <li className="p-4 text-sm text-gray-500">Searching…</li>
            )}
            {results.map((r, idx) => {
              const chip = categoryChip(r);
              const active = idx === highlight;
              return (
                <li
                  key={r.symbol}
                  id={`search-result-${r.symbol}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    // onMouseDown fires before input's onBlur — prevents the
                    // dropdown from closing before the click registers.
                    e.preventDefault();
                    go(r.symbol);
                  }}
                  onMouseEnter={() => setHighlight(idx)}
                  className={`p-4 cursor-pointer border-b border-gray-200 last:border-b-0 transition duration-150 ${
                    active ? 'bg-[#f5fff9]' : ''
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <span className="font-semibold text-gray-800">{r.symbol}</span>
                      <span className="ml-2 text-sm text-gray-600">{r.name}</span>
                    </div>
                    {chip && (
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        {chip}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </form>
    </div>
  )
}
