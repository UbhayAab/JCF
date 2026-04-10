"""
JCF Outreach Bot — Main Entry Point (v5.0)

Architecture:
- boot_thread_audit: on startup, checks all active threads for self-reply prevention
- poll_inbox: every 2 min, spawns asyncio.create_task per email (non-blocking)
- process_email: 5-stage AI pipeline with Telegram progress + human approval
- Meeting requests: posted to Telegram, NEVER block the poll loop
- drip_scheduler: runs every 4 hours
- All config via state.json (go_live, pause_drip)
"""

import asyncio
import logging
import config
import state
import zoho_logic
import database
import telegram_bot
import ai_orchestrator
import local_ai
from drip_campaign import run_drip_campaign

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("main")

_email_locks: dict = {}
_reported_errors: set = set()


# ═══════════════════════════════════════════════════════════════════════════════
# BOOT-TIME THREAD AUDIT
# Runs once on startup. Checks sent folder for any threads where our reply
# is the latest — marks those as "Replied" so we don't double-send.
# ═══════════════════════════════════════════════════════════════════════════════

async def boot_thread_audit(zoho: zoho_logic.ZohoMailService):
    """
    On every restart, scan recent inbox for threads we already replied to.
    If our email is the last message in a thread, mark it as Replied.
    """
    logger.info("🔍 Boot thread audit: checking for self-replied threads...")
    
    try:
        fid = zoho._folder_id("Inbox")
        if not fid:
            logger.warning("Could not find Inbox for thread audit")
            return

        # Get recent messages (not just unread — all recent ones)
        data = zoho._get("messages/view", params={"folderId": fid, "limit": 50})
        messages = data.get("data", [])
        
        checked = 0
        marked_replied = 0
        
        for msg in messages:
            msg_id = str(msg.get("messageId", "")).strip()
            from_addr = msg.get("fromAddress", "").lower()
            
            # Skip system emails
            if any(skip in from_addr for skip in ("noreply", "no-reply", "zohocalendar", "mailer-daemon")):
                continue
            
            # Skip our own sent emails
            if zoho.from_email in from_addr:
                continue
            
            try:
                _, last_sender, from_us = zoho.get_email_thread(msg_id)
                checked += 1
                
                if from_us:
                    # Our reply is the latest — mark as Replied in DB
                    if "<" in from_addr:
                        clean_email = from_addr.split("<")[1].split(">")[0].strip()
                    else:
                        clean_email = from_addr.strip()
                    
                    existing = database.get_target(clean_email)
                    if existing and existing.get("Status", "").startswith("Sent_"):
                        database.update_status(clean_email, "Replied")
                        marked_replied += 1
                        logger.info(f"  ✅ Marked {clean_email} as Replied (our reply was latest)")
                    
                    zoho.mark_as_read(msg_id)
            except Exception:
                pass
        
        logger.info(f"🔍 Thread audit done: checked {checked} threads, marked {marked_replied} as Replied")
    
    except Exception as e:
        logger.error(f"Thread audit failed: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# CORE EMAIL PROCESSOR
# ═══════════════════════════════════════════════════════════════════════════════

async def process_email(app, zoho: zoho_logic.ZohoMailService, msg: dict):
    """Process a single inbound email. Non-blocking (runs as asyncio task)."""
    msg_id     = str(msg.get("messageId", "")).strip()
    from_email = msg.get("fromAddress", "Unknown").lower().strip()
    subject    = msg.get("subject", "No Subject")

    if "<" in from_email:
        from_email = from_email.split("<")[1].split(">")[0].strip()

    if from_email in _email_locks:
        return
    _email_locks[from_email] = True
    telegram_bot.register_active_processing()

    try:
        logger.info(f"📧 Processing: '{subject}' from {from_email}")

        # ─── Build thread ────────────────────────────────────────────────────
        try:
            thread_text, last_sender, last_was_us = zoho.get_email_thread(msg_id)
        except Exception as e:
            logger.error(f"Thread build failed for {msg_id}: {e}")
            thread_text = f"From: {from_email}\nSubject: {subject}\n\n[Thread unavailable]"
            last_sender = from_email
            last_was_us = False

        # ─── Self-reply check ────────────────────────────────────────────────
        if last_was_us:
            logger.info(f"🛑 Last message from US — skipping {from_email}")
            zoho.mark_as_read(msg_id)
            database.update_status(from_email, "Replied")
            return

        if zoho.from_email in from_email:
            zoho.mark_as_read(msg_id)
            return

        # ─── Pipeline progress card ──────────────────────────────────────────
        await telegram_bot.notify_pipeline_start(app, from_email, subject)

        # ─── Deterministic unsubscribe ────────────────────────────────────────
        unsub_keywords = ["unsubscribe", "stop emailing", "remove me", "not interested", "opt out", "please stop", "do not contact"]
        if any(kw in thread_text.lower() for kw in unsub_keywords):
            database.update_status(from_email, "Unsubscribed")
            await telegram_bot.send_notification(app, f"🛑 <b>UNSUBSCRIBE:</b> <code>{from_email}</code>")
            zoho.mark_as_read(msg_id)
            return

        # ─── 5-stage AI pipeline ─────────────────────────────────────────────
        async def progress_cb(stage: int, name: str, summary: str):
            await telegram_bot.notify_pipeline_stage(app, from_email, stage, name, summary)

        max_retries = 2
        custom_context = None

        for attempt in range(max_retries):
            thread_with_ctx = thread_text
            if custom_context:
                thread_with_ctx = f"[HUMAN FEEDBACK]: {custom_context}\n\n{thread_text}"

            result = await ai_orchestrator.run_full_pipeline(thread_with_ctx, from_email, progress_cb)

            intent   = result.get("intent", "OTHER")
            name     = result.get("name", "")
            draft    = result.get("draft", "")
            greeting = local_ai.build_greeting(name)

            # ── SPAM ──────────────────────────────────────────────────────────
            if not result.get("is_relevant"):
                zoho.mark_as_read(msg_id)
                database.update_status(from_email, "Spam")
                await telegram_bot.send_notification(
                    app, f"🚫 <b>Skipped (irrelevant)</b>\n<code>{from_email}</code>\n{subject}"
                )
                return

            # ── UNSUBSCRIBE ───────────────────────────────────────────────────
            if intent == "UNSUBSCRIBE" or "[UNSUBSCRIBE]" in draft:
                database.update_status(from_email, "Unsubscribed")
                await telegram_bot.send_notification(app, f"🛑 <b>UNSUBSCRIBE:</b> <code>{from_email}</code>")
                zoho.mark_as_read(msg_id)
                return

            # ── MEETING REQUEST (non-blocking) ────────────────────────────────
            if intent == "MEETING_REQUEST" or (result.get("escalate_to_human") and "meeting" in result.get("human_escalation_reason", "").lower()):
                asyncio.create_task(
                    telegram_bot.handle_meeting_request(app, from_email, name, thread_text, msg_id, subject)
                )
                database.update_status(from_email, "Meeting_Pending")
                zoho.mark_as_read(msg_id)
                return

            # ── HUMAN ESCALATION ──────────────────────────────────────────────
            if result.get("escalate_to_human"):
                await telegram_bot.send_notification(
                    app,
                    f"🚨 <b>HUMAN ASSIST</b>\n{greeting} (<code>{from_email}</code>)\n"
                    f"Reason: {result.get('human_escalation_reason', 'Complex inquiry')}"
                )
                zoho.mark_as_read(msg_id)
                return

            # ── NORMAL: Human approval via Telegram ───────────────────────────
            if not draft:
                if attempt < max_retries - 1:
                    custom_context = "Draft was empty. Try again."
                    continue
                await telegram_bot.send_notification(app, f"❌ Draft failed for <code>{from_email}</code>. Reply manually.")
                return

            pipeline_summary = f"[Classify ✅] [Triage: {intent} ✅] [Strategy ✅] [Draft ✅] [Review ✅]"

            decision, context_text = await telegram_bot.send_draft_for_review(
                app, from_email, f"Re: {subject}", draft, msg_id, pipeline_summary
            )

            if decision == "SEND":
                zoho.send_reply(msg_id, draft, attach=True)
                zoho.mark_as_read(msg_id)
                database.update_status(from_email, "Replied")
                await telegram_bot.notify_send_confirmation(app, from_email, f"Re: {subject}", draft)
                logger.info(f"✅ Reply sent to {from_email}")
                return

            elif decision == "REGENERATE":
                custom_context = context_text
                continue

            elif decision == "SPAM":
                zoho.mark_as_read(msg_id)
                database.update_status(from_email, "Spam")
                return

            else:  # SKIP or timeout
                return

    except Exception as e:
        err_key = f"{from_email}:{type(e).__name__}"
        if err_key not in _reported_errors:
            logger.error(f"process_email error [{from_email}]: {e}")
            _reported_errors.add(err_key)
    finally:
        _email_locks.pop(from_email, None)
        telegram_bot.unregister_active_processing(from_email)


# ═══════════════════════════════════════════════════════════════════════════════
# POLL LOOP + SCHEDULER
# ═══════════════════════════════════════════════════════════════════════════════

async def poll_inbox(app, zoho: zoho_logic.ZohoMailService):
    logger.info("📡 Inbox polling started")
    while True:
        try:
            unread = zoho.fetch_unread_emails()
            if unread:
                logger.info(f"📬 {len(unread)} new email(s)")
                for msg in unread:
                    asyncio.create_task(process_email(app, zoho, msg))
        except Exception as e:
            err = str(e)
            if err not in _reported_errors:
                logger.error(f"poll_inbox error: {e}")
                _reported_errors.add(err)
        await asyncio.sleep(config.POLL_INTERVAL_SECONDS)


async def drip_scheduler(app, zoho: zoho_logic.ZohoMailService):
    logger.info("💧 Drip scheduler started (4h interval)")
    # Run first sweep immediately on boot
    try:
        await run_drip_campaign(app, zoho, limit=25)
    except Exception as e:
        logger.error(f"Initial drip sweep error: {e}")
    
    while True:
        await asyncio.sleep(4 * 3600)
        try:
            await run_drip_campaign(app, zoho, limit=50)
        except Exception as e:
            logger.error(f"Drip scheduler error: {e}")


async def _bulk_send_trigger(app, _zoho):
    zoho = zoho_logic.ZohoMailService()
    await run_drip_campaign(app, zoho)


# ═══════════════════════════════════════════════════════════════════════════════
# BOOT
# ═══════════════════════════════════════════════════════════════════════════════

async def main():
    config.validate()
    database.ensure_db()

    zoho = zoho_logic.ZohoMailService()
    app  = telegram_bot.build_telegram_app()

    telegram_bot.set_bulk_send_callback(_bulk_send_trigger)
    telegram_bot.set_zoho_ref(zoho)

    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)

    # ── Register Telegram command menu ────────────────────────────────────────
    await telegram_bot.register_commands(app)

    # ── Boot-time thread audit ────────────────────────────────────────────────
    await boot_thread_audit(zoho)

    # ── Pre-upload PDFs (caches for 1 hour) ───────────────────────────────────
    zoho.upload_attachments()

    # ── Boot notification ─────────────────────────────────────────────────────
    mode  = "🟡 SAFE-TEST" if state.is_safe_test_mode() else "🔴 LIVE"
    drip  = "⏸️ PAUSED" if state.is_drip_paused() else "✅ ACTIVE"
    stats = database.get_stats()
    pending = stats.get("Pending", 0)
    total   = sum(stats.values())

    await telegram_bot.send_notification(
        app,
        f"🚀 <b>JCF Outreach Bot v5.0 Online</b>\n\n"
        f"📡 <b>Mode:</b> {mode}\n"
        f"💧 <b>Drip:</b> {drip}\n"
        f"🧠 <b>AI:</b> {config.OLLAMA_TRIAGE_MODEL} + {config.OLLAMA_DRAFT_MODEL}\n"
        f"📎 <b>PDFs:</b> {len(zoho._attachment_cache or [])} attached\n"
        f"📧 <b>CC:</b> {config.CC_EMAILS}\n"
        f"📋 <b>DB:</b> {pending} pending / {total} total\n\n"
        f"Type /status for full health check."
    )

    logger.info("=" * 55)
    logger.info("🚀 JCF Outreach Bot v5.0")
    logger.info(f"   Mode  : {mode}")
    logger.info(f"   Drip  : {drip}")
    logger.info(f"   CC    : {config.CC_EMAILS}")
    logger.info(f"   DB    : {pending} pending / {total} total")
    logger.info(f"   PDFs  : {len(zoho._attachment_cache or [])} ready")
    logger.info("=" * 55)

    await asyncio.gather(
        poll_inbox(app, zoho),
        drip_scheduler(app, zoho),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("🛑 Shutting down")
