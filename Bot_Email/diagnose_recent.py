import asyncio
import json
import config
from zoho_service import ZohoMailService

async def check_all_recent():
    config.validate()
    zoho = ZohoMailService()
    
    print("\n1. Fetching Inbox Folder ID...")
    folder_id = zoho.get_folder_id("Inbox")
    print(f"✅ Inbox Folder ID: {folder_id}")

    print("\n2. Fetching the last 5 emails in Inbox (IGNORE READ STATUS)...")
    params = {"limit": 5, "folderId": folder_id}
    
    try:
        data = zoho._api_get("messages/view", params=params)
        emails = data.get("data", [])
        if not emails:
            print("Inbox is completely empty!")
            return
            
        print(f"✅ Found {len(emails)} recent emails in Inbox:")
        for idx, email in enumerate(emails):
             print(f"  [{idx+1}] {email.get('subject')} (From: {email.get('fromAddress')}) - Unread: {not bool(email.get('status', '0') == '0')}")
             # Zoho commonly uses 'status': '1' for unread and '0' for read, or similar
             # but we'll just show the raw metadata
             
        # Also check Spam folder just in case
        print("\n3. Checking Spam folder...")
        spam_id = zoho.get_folder_id("Spam")
        if spam_id:
             sdata = zoho._api_get("messages/view", params={"limit": 2, "folderId": spam_id})
             semails = sdata.get("data", [])
             if semails:
                 print(f"⚠️ Found {len(semails)} emails in Spam:")
                 for s in semails:
                      print(f"  - {s.get('subject')} (From: {s.get('fromAddress')})")
             else:
                 print("✅ Spam folder is empty.")
                 
    except Exception as e:
        print(f"❌ Failed: {e}")

if __name__ == "__main__":
    asyncio.run(check_all_recent())
