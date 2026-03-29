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

payloads = [
    {"status": "read"},
    {"status": "read", "action": "update"},
    {"action": "read"},
    {"read": "true"},
    {"Read": "true"},
    {"is_read": "true"},
    {"state": "read"},
]

for p in payloads:
    r = requests.post(f"{base_url}/messages/{msg_id}", headers=headers, json=p)
    print(f"\nPayload: {p}\nCode: {r.status_code} | Text: {r.text[:200]}")
