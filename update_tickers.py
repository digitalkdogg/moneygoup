import json
import requests
import os

def update_company_tickers(url, output_path):
    """
    Downloads a JSON file from a given URL and saves it to a specified local path.
    """
    try:
        response = requests.get(url)
        response.raise_for_status()  # Raise an exception for HTTP errors (4xx or 5xx)
        company_tickers_data = response.json()

        # Ensure the directory exists
        output_dir = os.path.dirname(output_path)
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)

        with open(output_path, 'w') as f:
            json.dump(company_tickers_data, f, indent=4)
        print(f"Successfully updated {output_path}")
    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from {url}: {e}")
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON from {url}: {e}")
    except IOError as e:
        print(f"Error writing to file {output_path}: {e}")

if __name__ == "__main__":
    SEC_TICKERS_URL = "https://dumbstockapi.com/stock?exchanges=NYSE,NASDAQ&format=json"
    OUTPUT_FILE_PATH = "/Users/kbollma/Projects/www/moneygoup/public/company_tickers.json"
    update_company_tickers(SEC_TICKERS_URL, OUTPUT_FILE_PATH)
