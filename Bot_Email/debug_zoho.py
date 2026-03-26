"""Debug Zoho API to figure out the correct endpoints and scopes."""
import json
import requests
from zoho_service import ZohoMailService

z = ZohoMailService()
z._ensure_access_token()

print("=== Fetching Account Info ===")
r = requests.get("https://mail.zoho.in/api/accounts", headers=z._headers())
data = r.json()
print(json.dumps(data, indent=2)[:2000])

accts = data.get("data", [])
if accts:
    acct = accts[0]
    acct_id = acct.get("accountId")
    print(f"\nAccount ID from API: {acct_id}")
    print(f"Account ID from .env: {z.account_id}")
    
    # Try to get folders with correct account ID
    print(f"\n=== Fetching Folders (Account: {acct_id}) ===")
    r2 = requests.get(f"https://mail.zoho.in/api/accounts/{acct_id}/folders", headers=z._headers())
    print(f"Status: {r2.status_code}")
    print(json.dumps(r2.json(), indent=2)[:2000])
    
    # Try to fetch messages directly without folder ID
    print(f"\n=== Fetching Messages (no folder filter) ===")
    r3 = requests.get(
        f"https://mail.zoho.in/api/accounts/{acct_id}/messages/view",
        headers=z._headers(),
        params={"limit": 5, "status": "unread"}
    )
    print(f"Status: {r3.status_code}")
    print(json.dumps(r3.json(), indent=2)[:2000])
