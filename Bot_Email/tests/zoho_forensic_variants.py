import os
import requests
import json
import config
from zoho_logic import ZohoMailService

def forensic_diagnostics():
    print("🔬 Forensic Multi-Variant Attachment Test (Zoho)...")
    zoho = ZohoMailService()
    test_file = os.path.join(config.BASE_DIR, "Docs", "Horizon Deck .pdf")
    file_name = os.path.basename(test_file)
    acc_id = zoho.account_id
    base = "https://mail.zoho.in/api/accounts"
    
    variants = [
        # Variant 1: Standard v2 (messages/attachments)
        {"url": f"{base}/{acc_id}/messages/attachments", "field": "file"},
        # Variant 2: Standard v1 (attach field)
        {"url": f"{base}/{acc_id}/messages/attachments", "field": "attach"},
        # Variant 3: No 'messages' path
        {"url": f"{base}/{acc_id}/attachments", "field": "file"},
        # Variant 4: Filename in Query
        {"url": f"{base}/{acc_id}/messages/attachments?fileName={file_name}", "field": "file"},
    ]
    
    for i, v in enumerate(variants):
        print(f"\n--- Testing Variant {i+1}: {v['url']} (field: {v['field']}) ---")
        try:
            with open(test_file, "rb") as f:
                files = {v["field"]: (file_name, f, "application/octet-stream")}
                resp = requests.post(v["url"], headers=zoho._headers(), files=files)
                print(f"Status: {resp.status_code}")
                print(f"Response: {resp.text}")
                if resp.status_code == 200:
                    print(f"✅ SUCCESS on Variant {i+1}!")
                    return
        except Exception as e:
            print(f"❌ Error: {e}")

if __name__ == "__main__":
    forensic_diagnostics()
