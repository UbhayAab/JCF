import asyncio
from zoho_service import ZohoMailService
import json

async def debug_thread():
    zoho = ZohoMailService()
    
    # Get the latest unread email to use its msg_id
    emails = zoho.fetch_unread_emails()
    if not emails:
        print("No unread emails found to test.")
        return
        
    msg_id = emails[0]["messageId"]
    print(f"Testing thread for Unread msg_id: {msg_id}")
    
    # 1. Fetch raw thread data to see if it includes Sent emails
    thread_data = zoho._api_get(f"messages/{msg_id}/thread")
    messages = thread_data.get("data", [])
    
    print(f"Thread contains {len(messages)} messages.")
    for idx, msg in enumerate(messages):
        print(f"[{idx}] From: {msg.get('fromAddress')} | To: {msg.get('toAddress')} | Folder: {msg.get('folderId')}")

    # 2. Let's see if we can find Sent emails for this thread
    # In Zoho, maybe there is a thread ID we can search globally?
    print("\nGlobal Search for Thread via subject:")
    subject = emails[0].get("subject", "")
    print(f"Subject: {subject}")
    search_data = zoho._api_get(f"messages/search", params={"searchKey": subject})
    for m in search_data.get("data", []):
        print(f"Global Match -> From: {m.get('fromAddress')} | Folder: {m.get('folderId')}")


if __name__ == "__main__":
    asyncio.run(debug_thread())
