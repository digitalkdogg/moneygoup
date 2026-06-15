/**
 * User Investment Strategy
 *
 * Single source of truth mapping aggressiveness + investment timeframe to
 * concrete scoring parameters used by the GPS-driven recommendation pipeline
 * and the DeepMoney discovery flow.
 */
import { executeRawQuery } from './databaseHelper';

export type Aggressiveness = 'safe' | 'neutral' | 'aggressive';
export type InvestmentTimeframe = '1_week' | '1_month' | '6_month' | '1_year';

export interface UserStrategy {
  aggressiveness: Aggressiveness;
  investment_timeframe: InvestmentTimeframe;
}

/** Gates applied when surfacing recommendations. */
export interface StrategyGates {
  confidenceFloor: number;   // 0–100; minimum prediction confidence
  betaCutoff: number;        // maximum beta tolerated
  gpsGate: number;           // minimum GPS score
  predChangeGate: number;    // minimum predicted change %
  /** Multiplier on env-driven floor thresholds (buy/discovery/etf gates).
   *  <1 loosens, >1 tightens. safe=1.05, neutral=1.0, aggressive=0.95. */
  envFloorMultiplier: number;
}

/** Timeframe-derived knobs for prediction + threshold tuning. */
export interface TimeframeConfig {
  /** outlook param passed to predict_weighted_analysis.py */
  outlook: InvestmentTimeframe;
  /** Multiplier stacked on top of strategyGates.predChangeGate. Short horizons
   *  lower the bar (less time → smaller expected move), long horizons raise it. */
  predChangeMultiplier: number;
  /** Offset added to env-driven sell threshold. Negative = more hair-trigger sells. */
  sellThresholdShift: number;
  /** ML validation gate for DeepMoney (minimum positive predicted change %). */
  mlGate: number;
  /** Short label for UI display, e.g. "in 6 months". */
  displayLabel: string;
  /** Compact label used on cards, e.g. "6M". */
  shortLabel: '1W' | '1M' | '6M' | '1Y';
  /** Which predicted_price column to read from user_stock_predictions. */
  predictedPriceColumn: 'predicted_price_1w' | 'predicted_price_1m' | 'predicted_price_6m' | 'predicted_price_1y';
}

export interface StrategyConfig {
  aggressiveness: Aggressiveness;
  investment_timeframe: InvestmentTimeframe;
  gates: StrategyGates;
  timeframe: TimeframeConfig;
}

export const DEFAULT_STRATEGY: UserStrategy = {
  aggressiveness:       'neutral',
  investment_timeframe: '1_month',
};

const AGGRESSIVENESS_GATES: Record<Aggressiveness, StrategyGates> = {
  safe: {
    confidenceFloor:    65,
    betaCutoff:         1.5,
    gpsGate:            75,
    predChangeGate:     3.0,
    envFloorMultiplier: 1.05,
  },
  neutral: {
    confidenceFloor:    50,
    betaCutoff:         2.0,
    gpsGate:            65,
    predChangeGate:     1.5,
    envFloorMultiplier: 1.0,
  },
  aggressive: {
    confidenceFloor:    35,
    betaCutoff:         3.5,
    gpsGate:            55,
    predChangeGate:     0.5,
    envFloorMultiplier: 0.95,
  },
};

const TIMEFRAME_CONFIG: Record<InvestmentTimeframe, TimeframeConfig> = {
  '1_week': {
    outlook:              '1_week',
    predChangeMultiplier: 0.5,
    sellThresholdShift:   -2,
    mlGate:               0.5,
    displayLabel:         'in 1 week',
    shortLabel:           '1W',
    predictedPriceColumn: 'predicted_price_1w',
  },
  '1_month': {
    outlook:              '1_month',
    predChangeMultiplier: 1.0,
    sellThresholdShift:   0,
    mlGate:               1.5,
    displayLabel:         'in 1 month',
    shortLabel:           '1M',
    predictedPriceColumn: 'predicted_price_1m',
  },
  '6_month': {
    outlook:              '6_month',
    predChangeMultiplier: 1.5,
    sellThresholdShift:   3,
    mlGate:               5,
    displayLabel:         'in 6 months',
    shortLabel:           '6M',
    predictedPriceColumn: 'predicted_price_6m',
  },
  '1_year': {
    outlook:              '1_year',
    predChangeMultiplier: 2.0,
    sellThresholdShift:   5,
    mlGate:               10,
    displayLabel:         'in 1 year',
    shortLabel:           '1Y',
    predictedPriceColumn: 'predicted_price_1y',
  },
};

export function resolveStrategy(strategy: UserStrategy): StrategyConfig {
  return {
    aggressiveness:       strategy.aggressiveness,
    investment_timeframe: strategy.investment_timeframe,
    gates:                AGGRESSIVENESS_GATES[strategy.aggressiveness],
    timeframe:            TIMEFRAME_CONFIG[strategy.investment_timeframe],
  };
}

const VALID_AGGRESSIVENESS: readonly Aggressiveness[] = ['safe', 'neutral', 'aggressive'];
const VALID_TIMEFRAMES: readonly InvestmentTimeframe[] = ['1_week', '1_month', '6_month', '1_year'];

export function isValidAggressiveness(v: unknown): v is Aggressiveness {
  return typeof v === 'string' && (VALID_AGGRESSIVENESS as readonly string[]).includes(v);
}

export function isValidTimeframe(v: unknown): v is InvestmentTimeframe {
  return typeof v === 'string' && (VALID_TIMEFRAMES as readonly string[]).includes(v);
}

/**
 * Fetch a user's strategy from user_investment_strategy. Falls back to the
 * default (neutral / 1_month) when the user has no row yet.
 */
export async function getUserStrategy(userId: number | string): Promise<UserStrategy> {
  const [rows] = await executeRawQuery(
    'SELECT aggressiveness, investment_timeframe FROM user_investment_strategy WHERE user_id = ?',
    [userId]
  );
  const row = Array.isArray(rows) && rows.length > 0 ? (rows[0] as any) : null;
  if (!row) return DEFAULT_STRATEGY;
  return {
    aggressiveness:       isValidAggressiveness(row.aggressiveness) ? row.aggressiveness : DEFAULT_STRATEGY.aggressiveness,
    investment_timeframe: isValidTimeframe(row.investment_timeframe) ? row.investment_timeframe : DEFAULT_STRATEGY.investment_timeframe,
  };
}
