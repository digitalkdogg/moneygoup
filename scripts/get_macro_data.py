import os
import requests
import mysql.connector
from datetime import datetime
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Environment & DB Connection (Mirrored from update_predictions.py)
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
WORLD_BANK_BASE_URL = "https://api.worldbank.org/v2/country/US/indicator/"

def fetch_wb_indicator(indicator_code: str, mrv: int = 5) -> list:
    """
    Fetches the Most Recent Values (mrv) for a specific indicator.
    """
    url = f"{WORLD_BANK_BASE_URL}{indicator_code}?format=json&mrv={mrv}"
    print(f"  [wb] Fetching {indicator_code}...")
    try:
        response = requests.get(url)
        response.raise_for_status()
        data = response.json()
        # World Bank JSON structure: [metadata, actual_data_list]
        if len(data) > 1:
            return data[1]
        return []
    except Exception as exc:
        print(f"  [wb] ERROR fetching {indicator_code}: {exc}")
        return []

# ---------------------------------------------------------------------------
# Processing Routines
# ---------------------------------------------------------------------------

def sync_macro_regime_data(cursor):
    """
    Syncs GDP growth and Inflation for the 109-feature tensor/GMM.
    Indicators: NY.GDP.MKTP.KD.ZG (GDP), FP.CPI.TOTL.ZG (Inflation)
    """
    indicators = ['NY.GDP.MKTP.KD.ZG', 'FP.CPI.TOTL.ZG', 'NE.CON.PRVT.KD.ZG']
    
    upsert_sql = """
        INSERT INTO world_bank_macro_data (indicator_code, country_code, year, value)
        VALUES (%s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE value = VALUES(value)
    """

    for code in indicators:
        results = fetch_wb_indicator(code)
        for entry in results:
            if entry['value'] is not None:
                cursor.execute(upsert_sql, (
                    code, 
                    entry['countryiso3code'], 
                    int(entry['date']), 
                    float(entry['value'])
                ))
    print(f"  [db] Macro regime data synced.")

def sync_etf_gps_factors(cursor):
    """
    Updates the latest values for ETF GPS scoring factors.
    Indicators: BX.KLT.DINV.WD.GD.ZS (FDI), TG.VAL.TOTL.GD.ZS (Trade), IT.NET.USER.ZS (Tech)
    """
    # Mapping indicator codes to the sectors/themes they influence
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
        SET latest_value = %s, country_code = %s
        WHERE indicator_code = %s AND theme_or_sector = %s
    """

    for code, sector in mappings:
        # Fetch only the most recent value (mrv=1)
        results = fetch_wb_indicator(code, mrv=1)
        if results and results[0]['value'] is not None:
            cursor.execute(update_sql, (
                float(results[0]['value']),
                results[0]['countryiso3code'],
                code,
                sector
            ))
    print(f"  [db] ETF GPS factors updated.")

# ---------------------------------------------------------------------------
# Main Sync Logic
# ---------------------------------------------------------------------------
def main():
    print(f"[{datetime.now()}] Starting World Bank Data Sync...")
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # 1. Macro Data for GMM Regime Detection
        sync_macro_regime_data(cursor)
        
        # 2. Factors for ETF GPS Scoring
        sync_etf_gps_factors(cursor)
        
        conn.commit()
        print(f"[{datetime.now()}] Sync complete and committed.")
        
    except Exception as exc:
        print(f"CRITICAL ERROR during sync: {exc}")
    finally:
        if 'cursor' in locals(): cursor.close()
        if 'conn' in locals(): conn.close()

if __name__ == "__main__":
    main()