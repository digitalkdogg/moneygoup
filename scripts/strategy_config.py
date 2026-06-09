"""
User Investment Strategy — Python mirror of src/utils/strategy.ts.

Maps aggressiveness → concrete scoring parameters used by update_predictions.py
and deepmoney_sync.py. Keep in sync with the TS module.

Timeframe was removed in favor of a single aggressiveness dimension.
"""
from typing import Literal, TypedDict
import mysql.connector


Aggressiveness = Literal['safe', 'neutral', 'aggressive']

VALID_AGGRESSIVENESS = ('safe', 'neutral', 'aggressive')


class UserStrategy(TypedDict):
    aggressiveness: Aggressiveness


class StrategyGates(TypedDict):
    confidenceFloor: float
    betaCutoff: float
    gpsGate: float
    predChangeGate: float
    envFloorMultiplier: float


class StrategyConfig(TypedDict):
    aggressiveness: Aggressiveness
    gates: StrategyGates


DEFAULT_STRATEGY: UserStrategy = {
    'aggressiveness': 'neutral',
}


_AGGRESSIVENESS_GATES: dict[Aggressiveness, StrategyGates] = {
    'safe': {
        'confidenceFloor':    65.0,
        'betaCutoff':         1.5,
        'gpsGate':            75.0,
        'predChangeGate':     3.0,
        'envFloorMultiplier': 1.05,
    },
    'neutral': {
        'confidenceFloor':    50.0,
        'betaCutoff':         2.0,
        'gpsGate':            65.0,
        'predChangeGate':     1.5,
        'envFloorMultiplier': 1.0,
    },
    'aggressive': {
        'confidenceFloor':    35.0,
        'betaCutoff':         3.5,
        'gpsGate':            55.0,
        'predChangeGate':     0.5,
        'envFloorMultiplier': 0.95,
    },
}


def resolve_strategy(strategy: UserStrategy) -> StrategyConfig:
    return {
        'aggressiveness': strategy['aggressiveness'],
        'gates':          _AGGRESSIVENESS_GATES[strategy['aggressiveness']],
    }


def strategy_bucket_key(strategy: UserStrategy) -> str:
    """Stable short identifier for cache/log keys."""
    return strategy['aggressiveness']


def get_user_strategy(cursor: mysql.connector.cursor.MySQLCursor, user_id: int) -> UserStrategy:
    """Fetch a user's strategy, defaulting to neutral when missing."""
    cursor.execute(
        'SELECT aggressiveness FROM user_investment_strategy WHERE user_id = %s',
        (user_id,)
    )
    row = cursor.fetchone()
    if not row:
        return DEFAULT_STRATEGY

    if isinstance(row, dict):
        aggressiveness = row.get('aggressiveness')
    else:
        aggressiveness = row[0]

    return {
        'aggressiveness': aggressiveness if aggressiveness in VALID_AGGRESSIVENESS else DEFAULT_STRATEGY['aggressiveness'],
    }


def get_all_user_strategies(cursor: mysql.connector.cursor.MySQLCursor, user_ids: list[int]) -> dict[int, UserStrategy]:
    """Batch fetch — returns user_id → strategy (defaults for missing rows)."""
    if not user_ids:
        return {}

    placeholders = ', '.join(['%s'] * len(user_ids))
    cursor.execute(
        f'SELECT user_id, aggressiveness FROM user_investment_strategy WHERE user_id IN ({placeholders})',
        tuple(user_ids)
    )
    result: dict[int, UserStrategy] = {}
    for row in cursor.fetchall():
        if isinstance(row, dict):
            uid = row['user_id']
            agg = row.get('aggressiveness')
        else:
            uid, agg = row[0], row[1]
        result[uid] = {
            'aggressiveness': agg if agg in VALID_AGGRESSIVENESS else DEFAULT_STRATEGY['aggressiveness'],
        }

    for uid in user_ids:
        if uid not in result:
            result[uid] = DEFAULT_STRATEGY

    return result
