import inspect
from zoho_service import ZohoMailService
import config
with open('debug_source.txt', 'w', encoding='utf-8') as f:
    f.write(f"config.ZOHO_API_BASE = '{config.ZOHO_API_BASE}'\n")
    f.write(f"Source:\n{inspect.getsource(ZohoMailService._api_url)}")
