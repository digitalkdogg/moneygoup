/**
 * horizons.ts — single source of truth for prediction horizon constants.
 *
 * Pure module: no server-side imports. Safe to use from both client
 * components and server-only code.
 */

export type InvestmentTimeframe =
  | '1_week'
  | '1_month'
  | '3_month'
  | '6_month';

/** Alias used by accuracy widgets and API response shapes. */
export type HorizonKey = InvestmentTimeframe;

/** Ordered list of horizons shown in the Model Accuracy widget and other horizon selectors. */
export const WIDGET_HORIZON_KEYS = [
  '1_week',
  '1_month',
  '3_month',
  '6_month',
] as const satisfies readonly HorizonKey[];

export type WidgetHorizonKey = (typeof WIDGET_HORIZON_KEYS)[number];

/** Full labels for horizon selector buttons and dropdowns. */
export const HORIZON_LABELS: Record<HorizonKey, string> = {
  '1_week':  '1 Week',
  '1_month': '1 Month',
  '3_month': '3 Months',
  '6_month': '6 Months',
};

/** Compact labels for GPS breakdown and tight-space UI (e.g. "3m", "6m"). */
export const HORIZON_LABEL_SHORT: Record<HorizonKey, string> = {
  '1_week':  '1w',
  '1_month': '1m',
  '3_month': '3m',
  '6_month': '6m',
};
