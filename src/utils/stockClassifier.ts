export interface StockClassification {
  growthStars: number; // 1–5: 1 = almost no growth, 5 = exceptional
  riskStars:   number; // 1–5: 1 = very safe, 5 = speculative
}

export interface ClassifyInput {
  gps_score?:           number | null;
  predicted_change_pct?: number | null; // 1m prediction %
  analyst_upside_pct?:  number | null;
  revenue_growth_yoy?:  number | null;
  trailing_pe?:         number | null;
  price_to_book?:       number | null;
  trading_signal?:      string | null;  // e.g. 'bull', 'strong bear', 'neutral'
}

export function classifyStock(ctx: ClassifyInput): StockClassification {
  const gps        = Number(ctx.gps_score          ?? 50);
  const predPct    = Number(ctx.predicted_change_pct ?? 0);
  const analystUp  = Number(ctx.analyst_upside_pct  ?? 0);
  const revGrowth  = Number(ctx.revenue_growth_yoy  ?? 0);
  const trailingPe = Number(ctx.trailing_pe         ?? 0);
  const ptb        = Number(ctx.price_to_book       ?? 0);
  const signal     = String(ctx.trading_signal      ?? '').toLowerCase();

  // Growth score (0–100)
  const gpsComp  = (gps / 100) * 40;
  const predComp = ((Math.max(-20, Math.min(30, predPct)) + 20) / 50) * 25;
  const upComp   = (Math.max(0, Math.min(40, analystUp)) / 40) * 20;
  const revComp  = ((Math.max(-20, Math.min(50, revGrowth)) + 20) / 70) * 15;
  const growthScore = Math.round(gpsComp + predComp + upComp + revComp);

  // Risk score (0–100)
  let peComp = 18;
  if (trailingPe <= 0)       peComp = 28;
  else if (trailingPe <= 20) peComp = 5;
  else if (trailingPe <= 35) peComp = 10;
  else if (trailingPe <= 60) peComp = 18;
  else                        peComp = 25;

  let ptbComp = 6;
  if (ptb < 0)       ptbComp = 12;
  else if (ptb < 1)  ptbComp = 4;
  else if (ptb < 5)  ptbComp = 6;
  else if (ptb < 10) ptbComp = 8;
  else               ptbComp = 12;

  const magComp = Math.min(18, (Math.abs(predPct) / 30) * 18);

  let sigComp = 10;
  if      (signal.includes('strong') && signal.includes('bull')) sigComp = 4;
  else if (signal.includes('bull'))                               sigComp = 7;
  else if (signal.includes('neutral') || signal === '')          sigComp = 10;
  else if (signal.includes('strong') && signal.includes('bear')) sigComp = 25;
  else if (signal.includes('bear'))                               sigComp = 19;

  const revRisk = revGrowth < -10 ? 12 : revGrowth < 0 ? 8 : revGrowth > 30 ? 4 : 5;
  const riskScore = Math.min(100, Math.round(peComp + ptbComp + magComp + sigComp + revRisk));

  const growthStars =
    growthScore >= 80 ? 5 :
    growthScore >= 60 ? 4 :
    growthScore >= 40 ? 3 :
    growthScore >= 20 ? 2 : 1;

  const riskStars =
    riskScore >= 75 ? 5 :
    riskScore >= 55 ? 4 :
    riskScore >= 35 ? 3 :
    riskScore >= 20 ? 2 : 1;

  return { growthStars, riskStars };
}
