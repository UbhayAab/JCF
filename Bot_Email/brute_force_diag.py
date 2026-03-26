import json
import config
from zoho_service import ZohoMailService

def run():
    print("=== ZOHO INBOX BRUTE FORCE DIAGNOSTIC ===")
    config.validate()
    zoho = ZohoMailService()
    
    print("\n1. Fetching all folders...")
    try:
        data = zoho._api_get("folders")
        folders = data.get("data", [])
        inbox_id = None
        spam_id = None
        for f in folders:
            name = f.get('folderName', '')
            print(f"   Folder: {name} (ID: {f.get('folderId')})")
            if name.lower() == 'inbox':
                inbox_id = f.get('folderId')
            elif name.lower() == 'spam':
                spam_id = f.get('folderId')
                
    except Exception as e:
        print(f"❌ Failed to get folders: {e}")
        return

    print(f"\n2. Fetching last 10 emails from Inbox (ID: {inbox_id})...")
    try:
        data = zoho._api_get("messages/view", params={"limit": 10, "folderId": inbox_id})
        emails = data.get("data", [])
        if not emails:
            print("   ⚠️ INBOX IS COMPLETELY EMPTY!")
        else:
            for i, e in enumerate(emails):
                status = e.get('status', '0')
                is_unread = not (status == '0')
                subj = e.get('subject', 'No Subject')
                sender = e.get('fromAddress', 'Unknown')
                print(f"   [{i+1}] {'📬 UNREAD' if is_unread else '📖 READ'} | From: {sender} | Subj: {subj}")
    except Exception as e:
        print(f"❌ Failed: {e}")

    print(f"\n3. Fetching last 5 emails from Spam (ID: {spam_id})...")
    if spam_id:
        try:
            data = zoho._api_get("messages/view", params={"limit": 5, "folderId": spam_id})
            emails = data.get("data", [])
            if not emails:
                print("   ✅ SPAM IS COMPLETELY EMPTY!")
            else:
                for i, e in enumerate(emails):
                    subj = e.get('subject', 'No Subject')
                    sender = e.get('fromAddress', 'Unknown')
                    print(f"   [{i+1}] From: {sender} | Subj: {subj}")
        except Exception as e:
            print(f"❌ Failed: {e}")

if __name__ == "__main__":
    run()
