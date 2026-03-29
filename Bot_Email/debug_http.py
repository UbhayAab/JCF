import os
import requests
import config

print("ZOHO_API_BASE =", config.ZOHO_API_BASE)

token_file = os.path.join(config.BASE_DIR, "zoho_token.json")
import json
with open(token_file, "r") as f:
    token = json.load(f).get("access_token")

headers = {"Authorization": f"Zoho-oauthtoken {token}"}

url = f"https://mail.zoho.in/api/accounts/5292649000000002002/folders/5292649000000002014/messages/1774560429265125600"
print(f"Making direct request to: {url}")

try:
    resp = requests.get(url, headers=headers, allow_redirects=False)
    print("Status:", resp.status_code)
    print("Headers:", resp.headers)
    print("Body:", resp.text)
    
    if resp.status_code in [301, 302, 307, 308]:
        print("Redirect Location:", resp.headers.get("Location"))
except Exception as e:
    print("Raw Request Exception:", e)
