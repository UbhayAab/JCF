import asyncio
import logging
import time

import config
from zoho_service import ZohoMailService
from gemini_service import generate_reply, classify_email


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("demo")

def demo_process_email(zoho, email):
    msg_id = email.get("messageId")
    from_email = email.get("fromAddress", "Unknown")
    subject = email.get("subject", "No Subject")
    
    logger.info(f"\n" + "="*80)
    logger.info(f"📧 EMAIL DETECTED: {subject}")
    logger.info(f"   From: {from_email}")
    logger.info("="*80)
    
    # 1. Fetch FULL thread
    logger.info("📡 Fetching FULL thread for context...")
    try:
        thread_text = zoho.get_email_thread(msg_id)
        logger.info(f"✅ Context fetched successfully ({len(thread_text)} chars).")
        print("\n--- THREAD CONTEXT PREVIEW ---")
        lines = thread_text.split('\n')
        if len(lines) > 20:
             print("\n".join(lines[:10]) + "\n\n... [SNIP] ...\n\n" + "\n".join(lines[-10:]))
        else:
             print(thread_text)
        print("------------------------------\n")
    except Exception as e:
        logger.error(f"❌ Could not fetch thread for {msg_id}: {e}")
        return

    # 2. Classify
    logger.info("🔍 Running Spam/Relevance Classifier...")
    is_relevant = classify_email(thread_text)
    
    if not is_relevant:
        logger.warning("🚫 CLASSIFIED AS SPAM/IRRELEVANT. Would SKIP this email in production.")
        return
        
    logger.info("✅ Classified as RELEVANT.")
    
    # 3. Generate Reply
    logger.info("🤖 Generating AI Reply...")
    draft = generate_reply(thread_text)
    
    print("\n--- AI DRAFT REPLY ---")
    print(draft)
    print("----------------------\n")
    logger.info("🛑 DEMO MODE: No email sent, no Telegram notification triggered.")


def run_demo():
    config.validate()
    zoho = ZohoMailService()
    
    logger.info("🚀 Starting Safe Demo Mode...")
    logger.info("Polling Zoho Inbox. Will NOT send emails. Will NOT mark as read.")
    
    # Track seen message IDs to avoid repeating the demo output endlessly
    local_seen = set()

    while True:
        try:
            logger.info("📬 Checking for new emails...")
            # We fetch using the normal method, but our local_seen will handle deduplication
            # for the demo, since we aren't marking them as read on Zoho's end.
            
            # Temporary override of the Zoho Service's fetch method to not mark them as seen internally
            # or rely purely on its internal state which resets on restart. We'll fetch the raw data.
            try:
                folder_id = zoho.get_folder_id("Inbox")
            except Exception as e:
                 # Fallback if folder_id fetch fails (as seen previously)
                 # We will use the account ID to fetch all unread messages directly
                 logger.warning("Could not get Inbox folder ID by name. Fetching all unread messages globally.")
                 folder_id = None
                 
            params = {"status": "unread", "limit": 10}
            if folder_id:
                params["folderId"] = folder_id

            data = zoho._api_get("messages/view", params=params)
            emails = data.get("data", [])
            
            new_emails = [e for e in emails if e.get("messageId") not in local_seen]
            
            if new_emails:
                logger.info(f"📬 Found {len(new_emails)} new unread email(s) for demo processing.")
                for e in new_emails:
                    local_seen.add(e.get("messageId"))
                    demo_process_email(zoho, e)
            else:
                logger.info("No unread emails found right now.")
                
        except Exception as e:
            logger.error(f"Error during poll: {e}")
            
        logger.info("⏳ Waiting 30 seconds before next check...\n")
        time.sleep(30)


if __name__ == "__main__":
    try:
        run_demo()
    except KeyboardInterrupt:
        logger.info("\n🛑 Demo stopped.")
