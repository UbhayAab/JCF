import os
import requests
import json
import config
from zoho_logic import ZohoMailService

def forensic_diagnostics_v2():
    print("🔬 Forensic Account-Identifier Test (Zoho)...")
    zoho = ZohoMailService()
    test_file = os.path.join(config.BASE_DIR, "Docs", "Horizon Deck .pdf")
    file_name = os.path.basename(test_file)
    
    # Try using the EMAIL ADDRESS instead of the NUMERIC ID
    email_acc_id = config.ZOHO_FROM_EMAIL
    numeric_acc_id = zoho.account_id
    
    base_in = "https://mail.zoho.in/api/accounts"
    
    variants = [
        # Variant A: Email Address as AccID
        {"url": f"{base_in}/{email_acc_id}/messages/attachments", "field": "file"},
        # Variant B: Email Address + attach field
        {"url": f"{base_in}/{email_acc_id}/messages/attachments", "field": "attach"},
        # Variant C: Numeric ID + attachments (No messages/)
        {"url": f"{base_in}/{numeric_acc_id}/attachments", "field": "file"},
    ]
    
    for i, v in enumerate(variants):
        print(f"\n--- Testing Variant {chr(65+i)}: {v['url']} ---")
        try:
            with open(test_file, "rb") as f:
                files = {v["field"]: (file_name, f, "application/octet-stream")}
                resp = requests.post(v["url"], headers=zoho._headers(), files=files)
                print(f"Status: {resp.status_code}")
                print(f"Response: {resp.text[:200]}")
                if resp.status_code == 200:
                    print(f"✅ SUCCESS on Variant {chr(65+i)}!")
                    return
        except Exception as e:
            print(f"❌ Error: {e}")

if __name__ == "__main__":
    forensic_diagnostics_v2()
