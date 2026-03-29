import os
import requests
import config

token_file = os.path.join(config.BASE_DIR, "zoho_token.json")
import json
with open(token_file, "r") as f:
    token = json.load(f).get("access_token")

headers = {"Authorization": f"Zoho-oauthtoken {token}"}
base_url = f"https://mail.zoho.in/api/accounts/5292649000000002002"

resp = requests.get(f"{base_url}/messages/view", headers=headers, params={"status": "unread", "limit": 1})
msgs = resp.json().get("data", [])
if not msgs: exit()

msg_id = msgs[0]["messageId"]
folder_id = msgs[0]["folderId"]

tests = [
    # Bulk PUT
    ("PUT", f"{base_url}/folders/{folder_id}/messages", {"messageId": msg_id, "isRead": "true"}),
    ("PUT", f"{base_url}/messages", [{"messageId": msg_id, "status": "read"}]),
    
    # POST
    ("POST", f"{base_url}/messages/{msg_id}", {"isRead": "true"}),
    ("POST", f"{base_url}/folders/{folder_id}/messages/{msg_id}", {"action": "update", "isRead": "true"}),
]

for method, url, payload in tests:
    print(f"\n{method} {url}")
    if method == "PUT":
        r = requests.put(url, headers=headers, json=payload)
    else:
        r = requests.post(url, headers=headers, json=payload)
    print(f"Status: {r.status_code} | {r.text[:150]}")
