"""
Main Orchestrator — Email Bot
Runs the Telegram bot and polls Zoho for new emails simultaneously.
"""

import asyncio
import logging
import sys
import signal

import config
from zoho_service import ZohoMailService
from gemini_service import generate_reply, classify_email
import telegram_bot
from bulk_sender import run_bulk_send

# ── Logging ────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("main")


# ── Email Processing ───────────────────────────────────────

async def process_email(app, zoho, email):
    """
    Process a single email:
    1. Fetch FULL thread (from first message)
    2. Classify as relevant or spam
    3. If relevant: generate reply → get approval → send
    Loops until approved or cancelled.
    """
    msg_id = email.get("messageId")
    from_email = email.get("fromAddress", "Unknown")
    subject = email.get("subject", "No Subject")
    
    logger.info(f"📧 New email: {subject} (from {from_email})")
    
    # Step 1: ALWAYS fetch full thread from the very first message
    try:
        thread_text = zoho.get_email_thread(msg_id)
        logger.info(f"📜 Fetched full thread ({len(thread_text)} chars)")
    except Exception as e:
        logger.error(f"Could not fetch thread for {msg_id}: {e}")
        thread_text = f"From: {from_email}\nSubject: {subject}\n\n[Could not fetch full thread]"
    
    # Step 2: Classify — is this email relevant to our campaign?
    logger.info(f"🔍 Classifying email...")
    is_relevant = classify_email(thread_text)
    
    if not is_relevant:
        logger.info(f"🚫 SPAM/IRRELEVANT — skipping: {subject}")
        zoho.mark_as_read(msg_id)
        await telegram_bot.send_notification(
            app,
            f"🚫 <b>Skipped (not event-related)</b>\n"
            f"From: {from_email}\n"
            f"Subject: {subject}\n"
            f"<i>Classified as spam/irrelevant by AI</i>"
        )
        return
    
    logger.info(f"✅ Email classified as RELEVANT — generating reply...")
    
    # Step 3: Human-in-the-loop reply loop
    custom_context = None
    
    while True:
        # Generate AI reply using full thread context
        logger.info(f"🤖 Generating AI reply...")
        draft = generate_reply(thread_text, custom_context)
        
        if draft.startswith("[ERROR"):
            await telegram_bot.send_notification(
                app, f"❌ <b>AI Error</b> for email from {from_email}:\n{draft}"
            )
            break
        
        # Send to Telegram for review
        logger.info(f"📱 Sending draft to Telegram for review...")
        try:
            decision, context_text = await telegram_bot.send_draft_for_review(
                app, from_email, subject, draft, msg_id
            )
        except Exception as e:
            logger.error(f"Telegram error: {e}")
            await asyncio.sleep(5)
            continue
        
        # Handle decision
        if decision == "approve":
            logger.info(f"✅ Approved — sending reply to {from_email}")
            try:
                zoho.send_reply(msg_id, draft)
                zoho.mark_as_read(msg_id)
                await telegram_bot.send_notification(
                    app, f"✅ Reply sent to <b>{from_email}</b>"
                )
            except Exception as e:
                logger.error(f"Failed to send reply: {e}")
                await telegram_bot.send_notification(
                    app, f"❌ Failed to send reply to {from_email}: {e}"
                )
            break
        
        elif decision == "edit":
            logger.info(f"✏️ Edit requested — regenerating with custom context")
            custom_context = context_text
            # Loop continues → will regenerate with full thread + custom context
        
        elif decision == "cancel":
            logger.info(f"❌ Cancelled — skipping {from_email}")
            zoho.mark_as_read(msg_id)
            break


async def poll_inbox(app, zoho):
    """Continuously poll Zoho inbox for new unread emails."""
    logger.info(f"📬 Starting inbox polling (every {config.POLL_INTERVAL_SECONDS}s)...")
    
    while True:
        try:
            emails = zoho.fetch_unread_emails()
            if emails:
                logger.info(f"📬 Found {len(emails)} new unread email(s)")
                for email in emails:
                    await process_email(app, zoho, email)
            else:
                logger.debug("No new emails")
        except Exception as e:
            logger.error(f"Polling error: {e}")
        
        await asyncio.sleep(config.POLL_INTERVAL_SECONDS)


# ── Bulk Send (runs in Telegram callback) ──────────────────

def _bulk_send_sync():
    """Synchronous wrapper for bulk send (called from telegram callback)."""
    return run_bulk_send(progress_callback=lambda msg: print(f"  {msg}"))


# ── Main ───────────────────────────────────────────────────

async def main():
    """Main entry point — runs Telegram bot + inbox poller concurrently."""
    # Validate config
    config.validate()
    
    # Initialize services
    zoho = ZohoMailService()
    
    # Build Telegram app
    app = telegram_bot.build_telegram_app()
    telegram_bot.set_bulk_send_callback(_bulk_send_sync)
    
    # Initialize the Telegram app
    await app.initialize()
    await app.start()
    
    # Start polling for Telegram updates
    await app.updater.start_polling(drop_pending_updates=True)
    
    logger.info("=" * 50)
    logger.info("🚀 Email Bot is running!")
    logger.info("=" * 50)
    logger.info("1️⃣  Add the bot to a Telegram group")
    logger.info("2️⃣  Send /start in the group")
    logger.info("3️⃣  Bot will auto-detect the group and start polling emails")
    logger.info("=" * 50)
    
    try:
        # If group chat ID is already set, start polling immediately
        chat_id = config.TELEGRAM_GROUP_CHAT_ID
        if chat_id and chat_id != "WILL_AUTO_DETECT":
            logger.info("📬 Group already configured — starting inbox polling...")
            await poll_inbox(app, zoho)
        else:
            # Wait for /start command to set the group chat ID
            logger.info("⏳ Waiting for /start command in a group chat...")
            while True:
                gid = telegram_bot.get_group_chat_id()
                if gid:
                    logger.info(f"✅ Group detected: {gid}")
                    logger.info("📬 Starting inbox polling...")
                    await poll_inbox(app, zoho)
                    break
                await asyncio.sleep(2)
    except (KeyboardInterrupt, SystemExit):
        logger.info("🛑 Shutting down...")
    finally:
        await app.updater.stop()
        await app.stop()
        await app.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Bot stopped.")
