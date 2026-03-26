import asyncio
import json
import config
from zoho_service import ZohoMailService
from gemini_service import classify_email, generate_reply
import telegram_bot

async def diagnose_pipeline():
    print("=== STARTING DEEP DIAGNOSTIC ===")
    config.validate()
    zoho = ZohoMailService()
    
    print("\n1. Fetching Inbox Folder ID...")
    try:
        folder_id = zoho.get_folder_id("Inbox")
        print(f"✅ Inbox Folder ID: {folder_id}")
    except Exception as e:
        print(f"❌ Failed to get Inbox folder ID: {e}")
        folder_id = None

    print("\n2. Fetching UNREAD emails...")
    params = {"status": "unread", "limit": 10}
    if folder_id:
        params["folderId"] = folder_id

    try:
        data = zoho._api_get("messages/view", params=params)
        emails = data.get("data", [])
        if not emails:
            print("⚠️ ZERO unread emails found in Zoho! (This is why the bot hasn't triggered)")
            print("Response from Zoho:")
            print(json.dumps(data, indent=2)[:500])
            return
            
        print(f"✅ Found {len(emails)} unread emails!")
        
    except Exception as e:
        print(f"❌ Failed to fetch emails: {e}")
        return

    print("\n3. Processing first unread email...")
    email = emails[0]
    msg_id = email.get("messageId")
    subject = email.get("subject", "No Subject")
    from_address = email.get("fromAddress", "Unknown")
    print(f"📧 EMAIL: {subject} | FROM: {from_address} | ID: {msg_id}")
    
    print("\n4. Fetching Full Thread Context...")
    try:
        thread_text = zoho.get_email_thread(msg_id)
        print(f"✅ Thread fetched ({len(thread_text)} characters)")
        if len(thread_text) < 50:
             print(f"⚠️ Thread seems suspiciously short: '{thread_text}'")
    except Exception as e:
        print(f"❌ Failed to fetch thread: {e}")
        return
        
    print("\n5. Running AI Classifier...")
    is_relevant = classify_email(thread_text)
    print(f"Classification Result: {'✅ RELEVANT' if is_relevant else '🚫 SPAM/IRRELEVANT'}")
    
    if is_relevant:
        print("\n6. Generating AI Reply...")
        draft = generate_reply(thread_text)
        print(f"✅ Draft length: {len(draft)} characters")
        
        print("\n7. Sending test payload to Telegram...")
        app = telegram_bot.build_telegram_app()
        await app.initialize()
        await app.start()
        try:
             await telegram_bot.send_notification(
                 app, 
                 f"🧪 <b>DIAGNOSTIC TEST PASS</b>\n\nFetched email: {telegram_bot._escape_html(subject)}"
             )
             print("✅ Telegram notification sent successfully!")
        except Exception as e:
             print(f"❌ Telegram send failed: {e}")
        finally:
             await app.stop()
             await app.shutdown()
             
    print("\n=== DIAGNOSTIC COMPLETE ===")

if __name__ == "__main__":
    asyncio.run(diagnose_pipeline())
