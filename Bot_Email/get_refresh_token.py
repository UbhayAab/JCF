"""Quick script to exchange Zoho grant token for refresh token. 
Run: python get_refresh_token.py YOUR_GRANT_TOKEN_HERE
"""
import sys
import requests
import config

CLIENT_ID = config.ZOHO_CLIENT_ID
CLIENT_SECRET = config.ZOHO_CLIENT_SECRET

if len(sys.argv) < 2:
    print("Usage: python get_refresh_token.py <GRANT_TOKEN>")
    sys.exit(1)

grant_token = sys.argv[1].strip()
print(f"Exchanging grant token: {grant_token[:20]}...")

resp = requests.post(
    "https://accounts.zoho.in/oauth/v2/token",
    data={
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": grant_token,
    },
)

data = resp.json()
print(f"\nFull response: {data}\n")

if "refresh_token" in data:
    rt = data["refresh_token"]
    print(f"=== REFRESH TOKEN ===")
    print(rt)
    print(f"=====================")
    
    # Save to file
    with open("refresh_token.txt", "w") as f:
        f.write(rt)
    print(f"\nAlso saved to refresh_token.txt")
    
    # Update .env
    with open(".env", "r") as f:
        content = f.read()
    content = content.replace("PASTE_YOUR_REFRESH_TOKEN_HERE", rt)
    with open(".env", "w") as f:
        f.write(content)
    print("Updated .env with refresh token!")
else:
    print(f"ERROR: {data.get('error', 'unknown')}")
    if "invalid_code" in str(data):
        print("The grant token has expired or was already used. Generate a new one.")
