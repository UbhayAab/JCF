"""
Safe Demo Mode — Email Bot
Runs like a cron job (polls Zoho inbox), classifying emails and generating AI drafts,
but sends all output ONLY to the Telegram Group for you to verify.
NEVER sends real emails, NEVER marks as read on Zoho.
"""

import asyncio
import logging
import time

import config
from zoho_service import ZohoMailService
from gemini_service import generate_reply, classify_email
import telegram_bot

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("demo")

def _truncate(text, max_len=1000):
    if len(text) <= max_len:
        return text
    return text[:max_len] + "\n\n... [truncated]"

async def demo_process_email(app, zoho, email):
    msg_id = email.get("messageId")
    from_email = email.get("fromAddress", "Unknown")
    subject = email.get("subject", "No Subject")
    
    logger.info(f"📧 Processing Demo Email: {subject}")
    
    # ── 1. Fetch Thread ───────────────────────────────────────
    try:
        thread_text = zoho.get_email_thread(msg_id)
        thread_preview = _truncate(thread_text, 800)
    except Exception as e:
        logger.error(f"❌ Could not fetch thread: {e}")
        thread_text = f"Fetch failed: {e}"
        thread_preview = thread_text

    # ── 2. Spam/Relevance Classification ──────────────────────
    is_relevant = classify_email(thread_text)
    
    if not is_relevant:
        logger.warning(f"🚫 SPAM/IRRELEVANT: {subject}")
        await telegram_bot.send_notification(
            app,
            f"🛠️ <b>DEMO: Spam Classification Test</b>\n\n"
            f"<b>From:</b> {telegram_bot._escape_html(from_email)}\n"
            f"<b>Subject:</b> {telegram_bot._escape_html(subject)}\n\n"
            f"<b>🤖 AI Verdict:</b> 🚫 SPAM/IRRELEVANT\n"
            f"<i>(In production, this email would be skipped entirely)</i>"
        )
        return

    # ── 3. Generate Reply ─────────────────────────────────────
    logger.info(f"✅ RELEVANT. Generating Draft...")
    draft = generate_reply(thread_text)
    
    # Send full demo report to Telegram
    msg = (
        f"🛠️ <b>DEMO: Email Processing Workflow</b>\n\n"
        f"<b>From:</b> {telegram_bot._escape_html(from_email)}\n"
        f"<b>Subject:</b> {telegram_bot._escape_html(subject)}\n\n"
        f"<b>1️⃣ Classification:</b> ✅ RELEVANT\n\n"
        f"<b>2️⃣ Context Parsed (Thread Preview):</b>\n"
        f"<i>{telegram_bot._escape_html(thread_preview)}</i>\n\n"
        f"<b>3️⃣ AI Drafted Response:</b>\n"
        f"{telegram_bot._escape_html(draft)}\n\n"
        f"⚠️ <i>This is just a demo. No email was sent, no buttons to click.</i>"
    )
    
    await telegram_bot.send_notification(app, msg)
    logger.info("📱 Sent demo report to Telegram.")


async def demo_loop():
    config.validate()
    zoho = ZohoMailService()
    
    app = telegram_bot.build_telegram_app()
    await app.initialize()
    await app.start()
    
    logger.info("🚀 Starting Safe Demo Mode to Telegram Group...")
    
    local_seen = set()

    while True:
        try:
            # Temporary override of the folder fetch to catch all unread if folder name fails
            try:
                folder_id = zoho.get_folder_id("Inbox")
            except Exception:
                 folder_id = None
                 
            params = {"status": "unread", "limit": 10}
            if folder_id:
                params["folderId"] = folder_id

            data = zoho._api_get("messages/view", params=params)
            emails = data.get("data", [])
            
            new_emails = [e for e in emails if e.get("messageId") not in local_seen]
            
            if new_emails:
                logger.info(f"📬 Found {len(new_emails)} unread email(s) for demo.")
                for e in new_emails:
                    local_seen.add(e.get("messageId"))
                    await demo_process_email(app, zoho, e)
            
        except Exception as e:
            logger.error(f"Error during poll: {e}")
            
        await asyncio.sleep(30)


if __name__ == "__main__":
    try:
        asyncio.run(demo_loop())
    except KeyboardInterrupt:
        logger.info("\n🛑 Demo stopped.")
