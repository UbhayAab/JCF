import requests
import os
import config
from zoho_logic import ZohoMailService

def test_attachment_upload():
    zoho = ZohoMailService()
    # Attempting to upload 'JCF Deck.pdf'
    file_path = os.path.join(config.BASE_DIR, "Docs", "JCF Deck.pdf")
    if not os.path.exists(file_path):
        print(f"❌ File not found: {file_path}")
        return

    url = f"https://mail.zoho.in/api/accounts/{config.ZOHO_ACCOUNT_ID}/messages/attachments"
    zoho._ensure_access_token()
    token = zoho.access_token
    headers = {"Authorization": f"Zoho-oauthtoken {token}"}
    
    file_name = os.path.basename(file_path)
    
    print(f"🚀 Testing Zoho.in Upload: {file_name}")
    print(f"URL: {url}")
    
    # Try 1: 'attach' field
    with open(file_path, "rb") as f:
        files = {"attach": (file_name, f, "application/pdf")}
        r = requests.post(url, headers=headers, files=files)
        print(f"Result (attach): {r.status_code}")
        if r.status_code != 200:
            print(f"Body: {r.text}")
        else:
            print(f"Success! Data: {r.json().get('data')}")

    # Try 2: 'file' field (fallback)
    if r.status_code != 200:
        print("\n🔄 Retrying with 'file' field...")
        with open(file_path, "rb") as f:
            files = {"file": (file_name, f, "application/pdf")}
            r = requests.post(url, headers=headers, files=files)
            print(f"Result (file): {r.status_code}")
            if r.status_code != 200:
                print(f"Body: {r.text}")
            else:
                print(f"Success! Data: {r.json().get('data')}")

if __name__ == "__main__":
    test_attachment_upload()
