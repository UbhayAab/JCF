import os
import requests
import config

token_file = os.path.join(config.BASE_DIR, "zoho_token.json")
import json
with open(token_file, "r") as f:
    token = json.load(f).get("access_token")

headers = {"Authorization": f"Zoho-oauthtoken {token}"}
base_url = f"https://mail.zoho.in/api/accounts/5292649000000002002"

# Get an unread message to test on
resp = requests.get(f"{base_url}/messages/view", headers=headers, params={"status": "unread", "limit": 1})
if resp.status_code != 200:
    print("Could not fetch unread email:", resp.text)
    exit()

data = resp.json()
msgs = data.get("data", [])
if not msgs:
    print("No unread messages.")
    exit()

msg_id = msgs[0]["messageId"]
folder_id = msgs[0]["folderId"]
print(f"Testing on msg_id: {msg_id}")

tests = [
    # 1. Standard PUT /messages/{id}
    (f"{base_url}/messages/{msg_id}", {"isRead": "true"}),
    (f"{base_url}/messages/{msg_id}", {"status": "read"}),
    (f"{base_url}/messages/{msg_id}", {"action": "update", "isRead": "true"}),
    
    # 2. Folder route PUT /folders/{folderId}/messages/{id}
    (f"{base_url}/folders/{folder_id}/messages/{msg_id}", {"isRead": "true"}),
    
    # 3. Dedicated status route
    (f"{base_url}/messages/{msg_id}/status", {"isRead": "true"}),
]

for url, payload in tests:
    try:
        r = requests.put(url, headers=headers, json=payload)
        print(f"\nPUT {url}\nPayload: {payload}\nStatus: {r.status_code} | Response: {r.text[:200]}")
    except Exception as e:
        print("Error:", e)
