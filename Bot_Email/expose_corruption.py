import inspect
from zoho_service import ZohoMailService
import config

print(f"config.ZOHO_API_BASE = '{config.ZOHO_API_BASE}'")
print(f"config.ZOHO_AUTH_BASE = '{config.ZOHO_AUTH_BASE}'")

zoho = ZohoMailService()
print(f"zoho.account_id = '{zoho.account_id}'")

source = inspect.getsource(zoho._api_url)
print("\nSOURCE OF _api_url:")
print(source)

# Let's check where the ZohoMailService is coming from
print("\nFile for ZohoMailService:", inspect.getfile(ZohoMailService))
