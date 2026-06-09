/**
 * User Investment Strategy
 *
 * Single source of truth mapping aggressiveness → concrete scoring parameters
 * used by the GPS-driven recommendation pipeline. The companion Python module
 * is scripts/strategy_config.py — keep in sync.
 *
 * Timeframe was removed in favor of a single aggressiveness dimension.
 */
import { executeRawQuery } from './databaseHelper';

export type Aggressiveness = 'safe' | 'neutral' | 'aggressive';

export interface UserStrategy {
  aggressiveness: Aggressiveness;
}

/** Gates applied when surfacing recommendations. */
export interface StrategyGates {
  confidenceFloor: number;   // 0–100; minimum prediction confidence
  betaCutoff: number;        // maximum beta tolerated
  gpsGate: number;           // minimum GPS score
  predChangeGate: number;    // minimum predicted 1m change %
  /** Multiplier applied to env-driven floor thresholds (buy/discovery/etf gates).
   *  <1 loosens, >1 tightens. safe=1.05, neutral=1.0, aggressive=0.95. */
  envFloorMultiplier: number;
}

export interface StrategyConfig {
  aggressiveness: Aggressiveness;
  gates: StrategyGates;
}

export const DEFAULT_STRATEGY: UserStrategy = {
  aggressiveness: 'neutral',
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

export function resolveStrategy(strategy: UserStrategy): StrategyConfig {
  return {
    aggressiveness: strategy.aggressiveness,
    gates:          AGGRESSIVENESS_GATES[strategy.aggressiveness],
  };
}

const VALID_AGGRESSIVENESS: readonly Aggressiveness[] = ['safe', 'neutral', 'aggressive'];

export function isValidAggressiveness(v: unknown): v is Aggressiveness {
  return typeof v === 'string' && (VALID_AGGRESSIVENESS as readonly string[]).includes(v);
}

/**
 * Fetch a user's strategy from user_investment_strategy. Falls back to the
 * default (neutral) when the user has no row yet.
 */
export async function getUserStrategy(userId: number | string): Promise<UserStrategy> {
  const [rows] = await executeRawQuery(
    'SELECT aggressiveness FROM user_investment_strategy WHERE user_id = ?',
    [userId]
  );
  const row = Array.isArray(rows) && rows.length > 0 ? (rows[0] as any) : null;
  if (!row) return DEFAULT_STRATEGY;
  return {
    aggressiveness: isValidAggressiveness(row.aggressiveness) ? row.aggressiveness : DEFAULT_STRATEGY.aggressiveness,
  };
}
