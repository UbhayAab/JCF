import os
import requests
import json
import config
from zoho_logic import ZohoMailService

def test_v2_attachment():
    print("🔬 Forensic Attachment Test (Zoho v2)...")
    zoho = ZohoMailService()
    
    # Path to one of the real assets
    test_file = os.path.join(config.BASE_DIR, "Docs", "Horizon Deck .pdf")
    if not os.path.exists(test_file):
        print(f"❌ Test file not found: {test_file}")
        return

    print(f"📁 Testing upload for: {os.path.basename(test_file)}")
    
    # 1. Try 'file' field
    result = zoho.upload_attachment(test_file)
    if result:
        print(f"✅ SUCCESS! Attachment ID: {result.get('attachmentId')}")
    else:
        print("❌ FAILED with 'file' field.")

if __name__ == "__main__":
    test_v2_attachment()
