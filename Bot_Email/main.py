"""
Main entry point for the Carcinome Outreach Bot.
Coordinates Zoho fetching, Gemini classification, and Telegram human-in-the-loop.
"""

import asyncio
import logging
import config
import zoho_logic
import database
import telegram_bot
import ai_orchestrator
from drip_campaign import run_drip_campaign

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger("main")

# Cache to prevent spamming the log with the same errors repeatedly
_sent_error_summaries = set()

async def poll_inbox(app, zoho):
    """Main loop to check Zoho for new unread emails."""
    logger.info("🚀 Monitoring inbox for new inquiries...")
    
    while True:
        try:
            unread = zoho.fetch_unread_emails()
            
            if unread:
                logger.info(f"📬 Found {len(unread)} new unread email(s)")
                for msg in unread:
                    try:
                        await process_email(app, zoho, msg)
                    except Exception as e:
                        logger.error(f"Error processing email {msg.get('messageId')}: {e}")
            
            # Poll every 2 minutes for new emails
            await asyncio.sleep(120)
            
        except Exception as e:
            err_msg = str(e)
            if err_msg not in _sent_error_summaries:
                logger.error(f"Polling Loop Error: {e}")
                _sent_error_summaries.add(err_msg)
            await asyncio.sleep(60)

async def process_email(app, zoho, msg):
    """Handles an individual email's lifecycle: Thread -> Classify -> Reply -> Telegram."""
    msg_id = msg.get("messageId")
    from_email = msg.get("fromAddress", "Unknown")
    subject = msg.get("subject", "No Subject")
    
    logger.info(f"📧 New email: {subject} (from {from_email})")
    
    # Step 1: Use the new logic layer to get full thread context
    try:
        thread_text, last_sender = zoho.get_email_thread(msg_id)
        logger.info(f"📜 Thread fetched. Last Sender: {last_sender}")
    except Exception as e:
        logger.error(f"Could not fetch thread for {msg_id}: {e}")
        # Fallback to minimal context if thread fails
        thread_text = f"From: {from_email}\nSubject: {subject}\n\n[Could not fetch full thread]"
        last_sender = from_email
        
    # Safety Check: If the absolutely most recent email in the thread is from US, do not reply.
    if last_sender.lower() == zoho.from_email.lower():
        logger.info(f"🛑 Skipping {from_email}: The last email in this thread was sent by us.")
        zoho.mark_as_read(msg_id)
        database.update_status(from_email, "Replied")
        return
    
    # Step 1: Detect Unsubscribe (Deterministic Flow)
    unsub_keywords = ["unsubscribe", "stop emailing", "remove me", "not interested", "opt out"]
    if any(kw in thread_text.lower() for kw in unsub_keywords):
        logger.info(f"🛑 Unsubscribe detected from {from_email}. Updating status.")
        database.update_status(from_email, "Unsubscribed")
        await telegram_bot.send_notification(app, f"🛑 <b>UNSUBSCRIBE:</b> {from_email} has been removed from all outreach.")
        zoho.mark_as_read(msg_id)
        return

    # Step 2: Classify Relevance
    logger.info(f"🔍 Classifying email (Local-First AI)...")
    is_relevant = ai_orchestrator.smart_classify(thread_text)
    
    if not is_relevant:
        logger.info(f"🚫 SPAM/IRRELEVANT — skipping: {subject}")
        zoho.mark_as_read(msg_id)
        database.update_status(from_email, "Spam")
        await telegram_bot.send_notification(
            app,
            f"🚫 <b>Skipped (not event-related)</b>\n"
            f"From: {from_email}\n"
            f"Subject: {subject}\n"
            f"<i>Classified as spam/irrelevant by AI</i>"
        )
        return
    
    logger.info(f"✅ Email classified as RELEVANT — generating reply...")
    
    # Step 3: Reply Loop (Human-in-the-loop)
    while True:
        # 2. Generate Reply (Scaffolded Logic)
        logger.info("🤖 Routing inquiry through AI Orchestrator...")
        reply_body, attachments = ai_orchestrator.smart_reply(thread_text)
        
        # 3. Handle Deterministic Actions (Unsubscribe/Stop)
        if "[DETERMINISTIC_ACTION]" in reply_body:
            logger.info(f"🛑 Deterministic action triggered: {reply_body}")
            if "UNSUBSCRIBE" in reply_body:
                database.update_status(from_email, "Unsubscribed")
                await telegram_bot.send_notification(app, f"🛑 <b>AUTO-UNSUBSCRIBE:</b> {from_email} removed.")
                zoho.mark_as_read(msg_id)
                return
        
        # 4. Handle Edge Cases / Human Assist
        if "[HUMAN_ASSIST_REQUIRED]" in reply_body:
            logger.info("🚨 Complexity detected — triggering HUMAN ASSIST alert.")
            await telegram_bot.send_admin_alert(
                app,
                f"🚨 <b>HUMAN ASSIST NEEDED</b>\n\n"
                f"<b>From:</b> {telegram_bot._escape_html(from_email)}\n"
                f"<b>Reason:</b> Complex/Asset Inquiry\n\n"
                f"<b>AI Nudge:</b>\n<i>{reply_body.replace('[HUMAN_ASSIST_REQUIRED]', '').strip()[:500]}...</i>\n\n"
                f"<b>Auto-Attachments:</b> {len(attachments)} files identified.",
                msg_id
            )
            continue

        # 5. Send Draft for Review (Normal Flow)
        logger.info(f"📱 Sending draft (with {len(attachments)} attachments) for user review...")
        decision, context_text = await telegram_bot.send_draft_for_review(
            app, from_email, subject, reply_body, msg_id
        )
        
        if decision == "SEND":
            logger.info(f"📨 Telegram approved: Sending reply...")
            zoho.send_reply(msg_id, reply_body)
            zoho.mark_as_read(msg_id)
            database.update_status(from_email, "Replied")
            await telegram_bot.send_notification(app, f"✅ Email sent to {from_email}")
            break
        elif decision == "REGENERATE":
            logger.info("🔄 Telegram requested regeneration with context.")
            custom_context = context_text
        elif decision == "SPAM":
            logger.info("🚫 Telegram rejected: Marking as Spam.")
            zoho.mark_as_read(msg_id)
            database.update_status(from_email, "Spam")
            break
        elif decision == "SKIP":
            logger.info("⏳ Telegram requested SKIP.")
            break

async def _bulk_send_sync(app, zoho):
    """Triggered by /bulk_send command in Telegram."""
    await run_drip_campaign(app, zoho)

async def main():
    config.validate()
    zoho = zoho_logic.ZohoMailService()
    app = telegram_bot.build_telegram_app()
    telegram_bot.set_bulk_send_callback(_bulk_send_sync)
    
    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)
    
    logger.info("=" * 50)
    logger.info("🚀 Email Bot vSTABILIZED_80 is running!")
    logger.info("📡 DeepSeek-API & Eternal Follow-ups: ACTIVE")
    logger.info("=" * 50)
    
    try:
        chat_id = config.TELEGRAM_GROUP_CHAT_ID
        if chat_id and chat_id != "WILL_AUTO_DETECT":
            logger.info("📬 Group detected — Starting Inbox Polling (Drip Disabled)...")
            # Drip is only manual now to protect costs and ensure name sanitization review
            await poll_inbox(app, zoho)
        else:
            logger.info("⏳ Waiting for /start command...")
            while True:
                gid = telegram_bot.get_group_chat_id()
                if gid:
                    logger.info("📬 Starting inbox polling...")
                    await poll_inbox(app, zoho)
                await asyncio.sleep(10)
    except KeyboardInterrupt:
        await app.stop()
        await app.shutdown()

if __name__ == "__main__":
    asyncio.run(main())
