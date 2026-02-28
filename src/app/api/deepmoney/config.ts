
import tickers from '@/../../public/company_tickers.json';

interface Ticker {
  ticker: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Ticker Resolution Helper
// ---------------------------------------------------------------------------
export const tickerMap: { [key: string]: { ticker: string, name: string } } = {};
(tickers as Ticker[]).forEach(t => {
  if (t.name) {
    const normalizedName = t.name.toLowerCase()
      .replace(/,?\s+(inc|corporation|corp|ltd|llc|plc|group|holdings|technologies)\.?/g, '')
      .trim();
    tickerMap[normalizedName] = { ticker: t.ticker, name: t.name };
  }
});

export function resolveTicker(name: string): string | null {
  const norm = name.toLowerCase().replace(/,$/, '').trim();
  // Direct match or partial match
  for (const key in tickerMap) {
    if (key === norm || key.includes(norm) || norm.includes(key)) {
      // Very basic disambiguation: avoid too short matches unless exact
      if (norm.length < 3 && key !== norm) continue;
      return tickerMap[key].ticker;
    }
  }
  return null;
}

export const AI_TECH_TAXONOMY = {
  'Artificial Intelligence': [
    'artificial intelligence', 'ai model', 'large language model', 'llm', 'generative ai', 'ai chip', 'inference',
    'foundation model', 'ai infrastructure', 'neural network', 'machine learning', 'deep learning', 'ai agent',
    'agentic ai', 'rag', 'vector database'
  ],
  'Semiconductors': [
    'semiconductor', 'chip', 'gpu', 'tpu', 'npu', 'wafer', 'fab', 'advanced packaging', 'hbm', 'memory bandwidth',
    'chip design', 'eda', 'foundry', 'chip shortage', 'ai accelerator'
  ],
  'Cloud & SaaS': [
    'cloud computing', 'saas', 'software as a service', 'hyperscaler', 'cloud revenue', 'arr', 'net revenue retention',
    'nrr', 'cloud migration', 'data center', 'platform'
  ],
  'Cybersecurity': [
    'cybersecurity', 'zero trust', 'endpoint security', 'threat detection', 'siem', 'soc', 'ransomware',
    'identity security', 'cloud security', 'firewall', 'vulnerability management'
  ],
  'Data Infrastructure': [
    'data infrastructure', 'data pipeline', 'etl', 'data lake', 'data warehouse', 'observability', 'mlops',
    'vector store', 'gpu cluster', 'ai training infrastructure'
  ],
  'Robotics & Automation': [
    'robotics', 'autonomous', 'automation', 'computer vision', 'edge ai', 'physical ai', 'humanoid robot',
    'industrial ai', 'drone', 'autonomous vehicle'
  ]
};

export const BROAD_INDUSTRIES = {
  'Gold': ['gold', 'precious metals'],
  'S&P 500': ['s&p 500', 's&p', 'sp500'],
  'Dow Jones': ['dow'],
  'Silver': ['silver'],
  'Energy': ['solar', 'energy', 'Alternative fule', 'green energy'],
  'Oil': ['oil', 'crude', 'petroleum'],
  'Tech': ['tech', 'technology', 'software', 'hardware'],
  'Real Estate': ['real estate', 'housing'],
  'Biotech': ['biotech', 'pharmaceutical'],
};

export const PRICE_FILTER_MAX = 150;

export const GPS_WEIGHTS = {
  ANALYST_UPSIDE: 0.25,
  REVENUE_GROWTH: 0.20,
  EPS_GROWTH: 0.15,
  MOMENTUM: 0.15,
  MENTIONS: 0.15,
  SENTIMENT: 0.10
};

export const AI_TECH_BONUS = {
  PROFILE_C: 8,
  SUB_SECTOR_SENTIMENT: 4,
  RD_SPEND_HIGH: 3, // >= 20%
  FWD_REVENUE_GROWTH: 4, // >= 25%
  ANALYST_UPGRADE: 5,
  PT_RAISED: 4,
  RECENT_IPO: 3,
  KEYWORD_DENSITY: 4,
  SMALL_CAP: 3 // < $5B
};

export const SCREENER_THRESHOLDS = {
  MARKET_CAP_CEILING: 50 * 1000 * 1000 * 1000, // $50B
  MARKET_CAP_FLOOR: 150 * 1000 * 1000, // $150M
  REVENUE_GROWTH_FLOOR: 0.15,
  GROSS_MARGIN_FLOOR: 0.40,
  ANALYST_COVERAGE_FLOOR: 2
};
