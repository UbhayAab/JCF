import requests
import json
import config

print("Attempting to refresh Zoho access token...\n")
print(f"Client ID: {config.ZOHO_CLIENT_ID}")
print(f"Refresh Token: {config.ZOHO_REFRESH_TOKEN[:10]}... (len: {len(config.ZOHO_REFRESH_TOKEN)})\n")

resp = requests.post(
    "https://accounts.zoho.in/oauth/v2/token",
    data={
        "grant_type": "refresh_token",
        "client_id": config.ZOHO_CLIENT_ID,
        "client_secret": config.ZOHO_CLIENT_SECRET,
        "refresh_token": config.ZOHO_REFRESH_TOKEN,
    },
)

print(f"Status Code: {resp.status_code}")
print("Response JSON:")
print(json.dumps(resp.json(), indent=2))
