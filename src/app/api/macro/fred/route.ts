import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/macro/fred');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  try {
    const [rows]: any[] = await executeRawQuery(`
      SELECT
        series_id, series_name, category, unit, frequency,
        display_mode, direction,
        obs_date, obs_value,
        prior_date, prior_value,
        yoy_date, yoy_value,
        mom_change, yoy_pct, qoq_pct,
        synced_at
      FROM fred_macro_indicators
      ORDER BY FIELD(category, 'labor','inflation','monetary','growth','credit','sentiment'), series_name
    `, []);

    // Group by category
    const grouped: Record<string, any[]> = {};
    for (const row of rows) {
      const cat = row.category as string;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({
        seriesId:    row.series_id,
        name:        row.series_name,
        category:    row.category,
        unit:        row.unit,
        frequency:   row.frequency,
        displayMode: row.display_mode,
        direction:   row.direction,
        obsDate:     row.obs_date,
        obsValue:    row.obs_value != null ? Number(row.obs_value) : null,
        priorDate:   row.prior_date,
        priorValue:  row.prior_value != null ? Number(row.prior_value) : null,
        yoyDate:     row.yoy_date,
        yoyValue:    row.yoy_value != null ? Number(row.yoy_value) : null,
        momChange:   row.mom_change != null ? Number(row.mom_change) : null,
        yoyPct:      row.yoy_pct != null ? Number(row.yoy_pct) : null,
        qoqPct:      row.qoq_pct != null ? Number(row.qoq_pct) : null,
        syncedAt:    row.synced_at,
      });
    }

    return NextResponse.json({ indicators: grouped, syncedAt: rows[0]?.synced_at ?? null });
  } catch (error: any) {
    logger.error('Error fetching FRED macro indicators', { error });
    return NextResponse.json({ error: 'Failed to fetch macro indicators' }, { status: 500 });
  }
}
