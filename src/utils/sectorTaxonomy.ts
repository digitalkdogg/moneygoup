/**
 * Canonical Yahoo Finance sector taxonomy.
 *
 * Source: empirically derived from `assetProfile.sector` across ~200 sampled
 * tickers (see scripts/discover_sectors.ts). These are the exact strings Yahoo
 * returns — wording and capitalization must match for sector-filter screeners
 * and portfolio sector grouping to align.
 */
export const CANONICAL_SECTORS = [
  'Technology',
  'Financial Services',
  'Healthcare',
  'Consumer Cyclical',
  'Consumer Defensive',
  'Industrials',
  'Communication Services',
  'Energy',
  'Basic Materials',
  'Real Estate',
  'Utilities',
] as const;

export type CanonicalSector = typeof CANONICAL_SECTORS[number];

/**
 * Maps each canonical sector to Yahoo's predefined sector-screener id.
 * Verified against Yahoo's `/v1/finance/screener/predefined/saved` endpoint;
 * each returns 25 sector-correct quotes. Requires
 * `{ validateOptions: false, validateResult: false }` since these ids are not
 * in yahoo-finance2's TypeScript enum.
 */
export const SECTOR_TO_SCRID: Record<CanonicalSector, string> = {
  'Technology':             'ms_technology',
  'Financial Services':     'ms_financial_services',
  'Healthcare':             'ms_healthcare',
  'Consumer Cyclical':      'ms_consumer_cyclical',
  'Consumer Defensive':     'ms_consumer_defensive',
  'Industrials':            'ms_industrials',
  'Communication Services': 'ms_communication_services',
  'Energy':                 'ms_energy',
  'Basic Materials':        'ms_basic_materials',
  'Real Estate':            'ms_real_estate',
  'Utilities':              'ms_utilities',
};

export const SECTOR_COLORS: Record<string, string> = {
  'Technology':             '#3b82f6',
  'Financial Services':     '#06b6d4',
  'Healthcare':             '#ec4899',
  'Consumer Cyclical':      '#8b5cf6',
  'Consumer Defensive':     '#84cc16',
  'Industrials':            '#10b981',
  'Communication Services': '#a855f7',
  'Energy':                 '#eab308',
  'Basic Materials':        '#d97706',
  'Real Estate':            '#f43f5e',
  'Utilities':              '#64748b',
};

export const DEFAULT_SECTOR_COLOR = '#94a3b8';

export function getSectorColor(sectorName: string | null | undefined): string {
  if (!sectorName) return DEFAULT_SECTOR_COLOR;
  return SECTOR_COLORS[sectorName] ?? DEFAULT_SECTOR_COLOR;
}

export function isCanonicalSector(name: string): name is CanonicalSector {
  return (CANONICAL_SECTORS as readonly string[]).includes(name);
}
