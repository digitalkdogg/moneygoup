import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Environment & DB Connection
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(PROJECT_ROOT, '.env.production')):
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.production'))
load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DB_HOST     = os.getenv('DB_HOST', 'localhost')
DB_USER     = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_DATABASE = os.getenv('DB_DATABASE')
INTERNAL_SECRET  = os.getenv('DEEPMONEY_INTERNAL_SECRET')
NEXTAUTH_URL     = os.getenv('NEXTAUTH_URL', 'http://localhost:3001')
INTERNAL_API_URL = 'http://localhost:3001'

def get_db_connection():
    return mysql.connector.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_DATABASE,
    )

# ---------------------------------------------------------------------------
# World Bank API Helpers
# ---------------------------------------------------------------------------
WORLD_BANK_API_URL = "https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?format=json&mrv={mrv}"

COUNTRIES = ['USA', 'GBR', 'CHN', 'IND', 'DEU']

# Full list of indicators required by the new /api/worldbank route
MACRO_INDICATORS = [
    'NY.GDP.MKTP.KD.ZG',   # GDP Growth
    'FP.CPI.TOTL.ZG',      # Inflation
    'NE.CON.PRVT.KD.ZG',   # Consumption Growth
    'SL.UEM.TOTL.ZS',      # Unemployment
    'BX.KLT.DINV.WD.GD.ZS',# FDI Inflows
    'TG.VAL.TOTL.GD.ZS',   # Trade Volume
    'IT.NET.USER.ZS',      # Internet Penetration
    'IT.CEL.SETS.P2',      # Mobile Subscriptions
    'TX.VAL.ICTG.ZS.UN'    # ICT Goods Exports
]

def fetch_wb_data(country_code: str, indicator_code: str, mrv: int = 5) -> list:
    url = WORLD_BANK_API_URL.format(country=country_code, indicator=indicator_code, mrv=mrv)
    print(f"  [wb] Fetching {indicator_code} for {country_code}...")
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        data = response.json()
        if len(data) > 1 and data[1]:
            return data[1]
        return []
    except Exception as exc:
        print(f"  [wb] ERROR fetching {indicator_code} for {country_code}: {exc}")
        return []

# ---------------------------------------------------------------------------
# Processing Routines
# ---------------------------------------------------------------------------

def sync_all_macro_data(cursor):
    """
    Syncs all indicators for all target countries into world_bank_macro_data.
    """
    upsert_sql = """
        INSERT INTO world_bank_macro_data (indicator_code, country_code, year, value)
        VALUES (%s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE value = VALUES(value), last_updated = CURRENT_TIMESTAMP
    """

    for country in COUNTRIES:
        for code in MACRO_INDICATORS:
            results = fetch_wb_data(country, code)
            for entry in results:
                if entry.get('value') is not None:
                    try:
                        cursor.execute(upsert_sql, (
                            code, 
                            entry['countryiso3code'], 
                            int(entry['date']), 
                            float(entry['value'])
                        ))
                    except Exception as e:
                        print(f"  [db] Error inserting {code} for {country}: {e}")
    
    print(f"  [db] Multi-country macro data synced.")

def sync_etf_gps_factors(cursor):
    """
    Updates the world_bank_etf_gps_factors table with the absolute latest values.
    """
    mappings = [
        ('BX.KLT.DINV.WD.GD.ZS', 'Global Trade/FDI'),
        ('TG.VAL.TOTL.GD.ZS', 'Global Trade/FDI'),
        ('IT.NET.USER.ZS', 'Artificial Intelligence'),
        ('IT.NET.USER.ZS', 'Technology'),
        ('NE.CON.PRVT.KD.ZG', 'Consumer Cyclical'),
        ('NE.CON.PRVT.KD.ZG', 'Consumer Defensive')
    ]

    update_sql = """
        UPDATE world_bank_etf_gps_factors 
        SET latest_value = %s, country_code = %s, last_updated = CURRENT_TIMESTAMP
        WHERE indicator_code = %s AND theme_or_sector = %s
    """

    for code, sector in mappings:
        results = fetch_wb_data('USA', code, mrv=1)
        if results and results[0].get('value') is not None:
            cursor.execute(update_sql, (
                float(results[0]['value']),
                results[0]['countryiso3code'],
                code,
                sector
            ))
    print(f"  [db] ETF GPS factors updated.")

def update_macro_snapshot(cursor):
    """
    Calls the local API to get processed signals and saves them to macro_context_snapshots.
    """
    print(f"  [snapshot] Calling internal API to update processed snapshot...")
    url = f"{INTERNAL_API_URL}/api/worldbank?refresh=true"
    headers = {'x-api-key': INTERNAL_SECRET}
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        wb_data = response.json()
        
        if wb_data and wb_data.get('success'):
            macro = wb_data.get('macro', {}).get('indicators', {})
            risk = wb_data.get('risk_index', {})
            today = datetime.now().strftime('%Y-%m-%d')
            
            cursor.execute("""
                INSERT INTO macro_context_snapshots 
                (snapshot_date, global_health_score, unemployment_rate, unemployment_signal, inflation_rate, gdp_growth)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                global_health_score = VALUES(global_health_score),
                unemployment_rate = VALUES(unemployment_rate),
                unemployment_signal = VALUES(unemployment_signal),
                inflation_rate = VALUES(inflation_rate),
                gdp_growth = VALUES(gdp_growth)
            """, (
                today,
                risk.get('globalHealthScore'),
                macro.get('unemployment', {}).get('latest'),
                macro.get('unemployment', {}).get('signal'),
                macro.get('inflation', {}).get('latest'),
                macro.get('gdpGrowth', {}).get('latest')
            ))
            print(f"  [snapshot] macro_context_snapshots updated for {today}.")
    except Exception as e:
        print(f"  [snapshot] ERROR updating snapshot: {e}")

# ---------------------------------------------------------------------------
# Main Sync Logic
# ---------------------------------------------------------------------------
def main():
    print(f"[{datetime.now()}] Starting Comprehensive World Bank Data Sync...")
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # 1. Sync all macro data for all countries
        sync_all_macro_data(cursor)
        
        # 2. Update specific factors for USA-based ETF scoring
        sync_etf_gps_factors(cursor)
        
        # 3. Trigger processed snapshot update
        update_macro_snapshot(cursor)
        
        conn.commit()
        print(f"[{datetime.now()}] Sync complete and committed.")
        
    except Exception as exc:
        print(f"CRITICAL ERROR during sync: {exc}")
    finally:
        if 'cursor' in locals(): cursor.close()
        if 'conn' in locals(): conn.close()

if __name__ == "__main__":
    main()
