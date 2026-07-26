export interface RecommendationPeriod {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface AnalystGradeResult {
  composite: number;
  grade: string;
  recScore: number;
  upsideScore: number;
  momentumScore: number;
  convictionScore: number;
  coverageScore: number;
}

const PERIOD_WEIGHTS: Record<string, number> = {
  '0m': 0.40,
  '-1m': 0.25,
  '-2m': 0.20,
  '-3m': 0.15,
};

function periodWRS(row: RecommendationPeriod): number | null {
  const total = row.strongBuy + row.buy + row.hold + row.sell + row.strongSell;
  if (total <= 0) return null;
  return (5 * row.strongBuy + 4 * row.buy + 3 * row.hold + 2 * row.sell + 1 * row.strongSell) / total;
}

function gradeFromComposite(score: number): string {
  if (score >= 93) return 'A+';
  if (score >= 87) return 'A';
  if (score >= 82) return 'A-';
  if (score >= 77) return 'B+';
  if (score >= 72) return 'B';
  if (score >= 67) return 'B-';
  if (score >= 62) return 'C+';
  if (score >= 57) return 'C';
  if (score >= 52) return 'C-';
  if (score >= 47) return 'D+';
  if (score >= 42) return 'D';
  if (score >= 37) return 'D-';
  if (score >= 27) return 'F+';
  if (score >= 14) return 'F';
  return 'F-';
}

export function computeAnalystGrade(
  recommendationTrend: RecommendationPeriod[] | null | undefined,
  priceTarget: { low?: number | null; mean?: number | null; high?: number | null } | null | undefined,
  currentPrice: number | null | undefined,
): AnalystGradeResult | null {
  if (!recommendationTrend || recommendationTrend.length === 0) return null;

  const wrsMap: Record<string, number> = {};
  for (const row of recommendationTrend) {
    const wrs = periodWRS(row);
    if (wrs !== null) wrsMap[row.period] = wrs;
  }

  if (wrsMap['0m'] === undefined) return null;

  // Step 1 — blended WRS (renormalized for any missing periods)
  let blendedWRS = 0;
  let totalWeight = 0;
  for (const [period, weight] of Object.entries(PERIOD_WEIGHTS)) {
    if (wrsMap[period] !== undefined) {
      blendedWRS += weight * wrsMap[period];
      totalWeight += weight;
    }
  }
  if (totalWeight <= 0) return null;
  blendedWRS /= totalWeight;

  // Step 2 — RecScore: maps WRS 1–5 → 0–100
  const recScore = ((blendedWRS - 1) / 4) * 100;

  // Step 3 — MomentumScore: 0m vs oldest available period
  const wrs0 = wrsMap['0m'];
  const wrsOldest = wrsMap['-3m'] ?? wrsMap['-2m'] ?? wrsMap['-1m'] ?? wrs0;
  const momentumScore = Math.max(0, Math.min(100, 50 + (wrs0 - wrsOldest) * 50));

  // Step 4 — UpsideScore: capped upside mapped to 0–100
  let upsideScore = 50;
  if (priceTarget?.mean && currentPrice && currentPrice > 0) {
    const upsidePct = ((priceTarget.mean - currentPrice) / currentPrice) * 100;
    upsideScore = Math.max(0, Math.min(100, (upsidePct + 20) / 60 * 100));
  }

  // Step 5 — ConvictionScore: tighter target spread = higher conviction
  let convictionScore = 50;
  if (priceTarget?.low && priceTarget?.high && priceTarget?.mean && priceTarget.mean > 0) {
    const dispersion = (priceTarget.high - priceTarget.low) / priceTarget.mean;
    convictionScore = Math.max(0, Math.min(100, 100 - dispersion * 100));
  }

  // Step 6 — CoverageScore: more analysts = more reliable signal (sqrt scale, caps at 30)
  const row0m = recommendationTrend.find(r => r.period === '0m');
  const total0m = row0m
    ? row0m.strongBuy + row0m.buy + row0m.hold + row0m.sell + row0m.strongSell
    : 0;
  const coverageScore = Math.min(100, (Math.sqrt(total0m) / Math.sqrt(30)) * 100);

  const composite = Math.max(
    0,
    Math.min(
      100,
      0.47 * recScore + 0.29 * upsideScore + 0.14 * momentumScore + 0.05 * convictionScore + 0.05 * coverageScore,
    ),
  );

  return {
    composite: Math.round(composite * 10) / 10,
    grade: gradeFromComposite(composite),
    recScore: Math.round(recScore * 10) / 10,
    upsideScore: Math.round(upsideScore * 10) / 10,
    momentumScore: Math.round(momentumScore * 10) / 10,
    convictionScore: Math.round(convictionScore * 10) / 10,
    coverageScore: Math.round(coverageScore * 10) / 10,
  };
}

export function gradeColor(grade: string): string {
  const letter = grade[0];
  if (letter === 'A') return 'bg-green-100 text-green-800 border-green-300';
  if (letter === 'B') return 'bg-blue-100 text-blue-800 border-blue-300';
  if (letter === 'C') return 'bg-yellow-100 text-yellow-800 border-yellow-300';
  if (letter === 'D') return 'bg-orange-100 text-orange-800 border-orange-300';
  return 'bg-red-100 text-red-800 border-red-300';
}
