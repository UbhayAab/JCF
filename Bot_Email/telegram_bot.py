"""
Telegram Bot (v5.0 — Complete Command Suite + Human-in-the-Loop)

Commands:
  /start        — Boot message + command list
  /status       — Live health check (Ollama + Zoho + DB stats + PDFs)
  /go_live      — Disable safe-test mode (real recipients)
  /test_mode    — Re-enable safe-test mode (→ test inbox)
  /pause_drip   — Pause drip campaign
  /resume_drip  — Resume drip campaign
  /reset_drip   — Reset all drip statuses to Pending
  /bulk_sync    — Import leads from output.csv
  /bulk_start   — Trigger drip sweep NOW 
  /reset_spam   — Unblock an email address
  /db_stats     — Show database breakdown

ALL reply emails require human approval (SEND/SKIP/REGENERATE/SPAM buttons).
ALL meeting requests require human confirmation (reply with date/time).
Drip emails auto-send but show Telegram notification.
"""

import logging
import re
import asyncio
import html as html_mod
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes,
)
import config
import state

logger = logging.getLogger("telegram_bot")

# ── Global State ──────────────────────────────────────────────────────────────

_group_chat_id: int | None = None
_pending_approvals: dict = {}       # msg_id → asyncio.Future
_pending_meeting_slots: dict = {}   # telegram_msg_id → slot info
_bulk_send_callback = None
_zoho_ref = None
_processing_status = {"active": 0, "last_processed": "None"}


def _esc(text: str) -> str:
    return html_mod.escape(str(text or ""))

def _chat_id() -> int | None:
    return _group_chat_id or (int(config.TELEGRAM_GROUP_CHAT_ID) if config.TELEGRAM_GROUP_CHAT_ID else None)

def set_bulk_send_callback(cb):
    global _bulk_send_callback
    _bulk_send_callback = cb

def set_zoho_ref(zoho):
    global _zoho_ref
    _zoho_ref = zoho

def register_active_processing():
    _processing_status["active"] += 1

def unregister_active_processing(email: str):
    _processing_status["active"] = max(0, _processing_status["active"] - 1)
    _processing_status["last_processed"] = email


# ═══════════════════════════════════════════════════════════════════════════════
# COMMANDS
# ═══════════════════════════════════════════════════════════════════════════════

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global _group_chat_id
    _group_chat_id = update.effective_chat.id
    mode = "🟡 SAFE-TEST" if state.is_safe_test_mode() else "🔴 LIVE"
    drip = "⏸️ PAUSED" if state.is_drip_paused() else "✅ ACTIVE"
    await update.message.reply_text(
        f"🤖 <b>JCF Outreach Bot v5.0</b>\n\n"
        f"📡 <b>Mode:</b> {mode}\n"
        f"💧 <b>Drip:</b> {drip}\n"
        f"📎 <b>Attachments:</b> {len(_zoho_ref._attachment_cache or []) if _zoho_ref else 0} PDFs\n\n"
        f"<b>Commands:</b>\n"
        f"/status — Full health check\n"
        f"/go_live — Switch to LIVE mode\n"
        f"/test_mode — Switch to safe-test mode\n"
        f"/pause_drip — Pause drip campaign\n"
        f"/resume_drip — Resume drip campaign\n"
        f"/reset_drip — Reset ALL targets to Pending\n"
        f"/bulk_sync — Import leads from output.csv\n"
        f"/bulk_start — Run drip sweep now\n"
        f"/db_stats — Database breakdown\n"
        f"/reset_spam &lt;email&gt; — Unblock an email",
        parse_mode="HTML"
    )


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import database

    # Ollama check — use /api/tags (instant, doesn't load models)
    try:
        import requests as req
        r = req.get("http://localhost:11434/api/tags", timeout=5)
        if r.status_code == 200:
            models = [m.get("name", "") for m in r.json().get("models", [])]
            has_8b  = any(config.OLLAMA_TRIAGE_MODEL in m for m in models)
            has_14b = any(config.OLLAMA_DRAFT_MODEL in m for m in models)
            ollama_8b  = "✅ Ready" if has_8b else "⚠️ Model not found"
            ollama_14b = "✅ Ready" if has_14b else "⚠️ Model not found"
        else:
            ollama_8b = ollama_14b = f"⚠️ HTTP {r.status_code}"
    except Exception:
        ollama_8b = ollama_14b = "❌ Offline"

    zoho_status = "✅ Connected" if (_zoho_ref and _zoho_ref.test_connection()) else "⚠️ Not checked"
    pdfs = len(_zoho_ref._attachment_cache or []) if _zoho_ref else 0

    stats = database.get_stats()
    total = sum(stats.values())
    db_lines = "\n".join(f"  {k}: {v}" for k, v in sorted(stats.items(), key=lambda x: -x[1]))

    mode = "🟡 SAFE-TEST → " + state.get("test_email") if state.is_safe_test_mode() else "🔴 LIVE (real recipients)"
    drip = "⏸️ PAUSED" if state.is_drip_paused() else "✅ ACTIVE"

    await update.message.reply_text(
        f"📊 <b>System Status</b>\n\n"
        f"<b>Mode:</b> {mode}\n"
        f"<b>Drip:</b> {drip}\n"
        f"<b>Processing:</b> {_processing_status['active']} email(s)\n"
        f"<b>Last:</b> {_processing_status['last_processed']}\n\n"
        f"🧠 <b>Ollama:</b>\n"
        f"  8B (Classify/Triage/Critic): {ollama_8b}\n"
        f"  14B (Strategist/Copywriter): {ollama_14b}\n\n"
        f"📧 <b>Zoho:</b> {zoho_status}\n"
        f"📎 <b>PDFs uploaded:</b> {pdfs}\n\n"
        f"📋 <b>Database</b> ({total} total):\n{db_lines}",
        parse_mode="HTML"
    )


async def cmd_go_live(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[
        InlineKeyboardButton("✅ Yes, Go LIVE", callback_data="GO_LIVE_CONFIRM"),
        InlineKeyboardButton("❌ Cancel", callback_data="GO_LIVE_CANCEL"),
    ]]
    await update.message.reply_text(
        "⚠️ <b>WARNING</b>\n\n"
        "This will send ALL future emails to <b>real recipients</b>.\nAre you sure?",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="HTML"
    )


async def cmd_test_mode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state.go_test()
    await update.message.reply_text(
        f"🟡 <b>Switched to SAFE-TEST mode.</b>\n"
        f"All emails → <code>{state.get('test_email')}</code>",
        parse_mode="HTML"
    )


async def cmd_pause_drip(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state.pause_drip()
    await update.message.reply_text("⏸️ <b>Drip campaign PAUSED.</b>\n/resume_drip to resume.", parse_mode="HTML")


async def cmd_resume_drip(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state.resume_drip()
    await update.message.reply_text("✅ <b>Drip campaign RESUMED.</b>", parse_mode="HTML")


async def cmd_reset_drip(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Reset all Sent_* statuses back to Pending for a fresh start."""
    keyboard = [[
        InlineKeyboardButton("✅ Yes, RESET", callback_data="RESET_DRIP_CONFIRM"),
        InlineKeyboardButton("❌ Cancel", callback_data="RESET_DRIP_CANCEL"),
    ]]
    await update.message.reply_text(
        "⚠️ <b>RESET DRIP</b>\n\n"
        "This will reset ALL Sent_1/2/3/... statuses back to Pending.\n"
        "Replied, Unsubscribed, Spam are preserved.\n\nProceed?",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="HTML"
    )


async def cmd_bulk_sync(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import database
    added, msg = database.sync_external_csv()
    await update.message.reply_text(f"📊 <b>Sync Result:</b>\n{_esc(msg)}", parse_mode="HTML")


async def cmd_bulk_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if state.is_drip_paused():
        await update.message.reply_text("⏸️ Drip is PAUSED. /resume_drip first.")
        return
    if _bulk_send_callback:
        await update.message.reply_text("💧 <b>Starting drip sweep...</b>", parse_mode="HTML")
        asyncio.create_task(_bulk_send_callback(context.application, None))
    else:
        await update.message.reply_text("⚠️ Drip trigger not registered. Bot may need restart.")


async def cmd_reset_spam(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /reset_spam <email>")
        return
    import database
    email = context.args[0]
    if database.reset_spam_status(email):
        await update.message.reply_text(f"✅ <code>{_esc(email)}</code> reset to Pending.", parse_mode="HTML")
    else:
        await update.message.reply_text(f"❌ <code>{_esc(email)}</code> not found.", parse_mode="HTML")


async def cmd_db_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import database
    stats = database.get_stats()
    total = sum(stats.values())
    lines = "\n".join(f"  {k}: {v}" for k, v in sorted(stats.items(), key=lambda x: -x[1]))
    await update.message.reply_text(
        f"📋 <b>Database Stats</b> ({total} total)\n\n{lines}",
        parse_mode="HTML"
    )


# ═══════════════════════════════════════════════════════════════════════════════
# CALLBACK HANDLER
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    # Go Live
    if data == "GO_LIVE_CONFIRM":
        state.go_live()
        await query.edit_message_text("🔴 <b>Now in LIVE mode.</b> Emails go to real recipients!", parse_mode="HTML")
        return
    if data == "GO_LIVE_CANCEL":
        await query.edit_message_text("✅ Cancelled. Staying in safe-test mode.", parse_mode="HTML")
        return

    # Reset Drip
    if data == "RESET_DRIP_CONFIRM":
        import database
        count = database.reset_all_drip_statuses()
        await query.edit_message_text(f"🔄 <b>Reset complete!</b> {count} targets back to Pending.", parse_mode="HTML")
        return
    if data == "RESET_DRIP_CANCEL":
        await query.edit_message_text("✅ Reset cancelled.", parse_mode="HTML")
        return

    # Draft approval callbacks (SEND:id, SKIP:id, SPAM:id, REGENERATE:id)
    if ":" in data:
        action, msg_id = data.split(":", 1)
        if msg_id in _pending_approvals and not _pending_approvals[msg_id].done():
            _pending_approvals[msg_id].set_result((action, None))
            try:
                await query.edit_message_reply_markup(reply_markup=None)
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════════════════════════
# MESSAGE HANDLER (meeting replies, regeneration context)
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message:
        return

    reply_to = update.message.reply_to_message

    # ── Meeting slot reply ────────────────────────────────────────────────────
    if reply_to:
        replied_msg_id = reply_to.message_id
        if replied_msg_id in _pending_meeting_slots:
            slot = _pending_meeting_slots.pop(replied_msg_id)
            meeting_details = update.message.text
            await update.message.reply_text("📅 Got it! Drafting meeting confirmation...")
            asyncio.create_task(
                _send_meeting_confirmation(context.application, slot, meeting_details)
            )
            return

    # ── Regenerate context reply ──────────────────────────────────────────────
    if reply_to:
        text = reply_to.text or ""
        match = re.search(r'ID:\s*(\S+)', text)
        if match:
            msg_id = match.group(1)
            if msg_id in _pending_approvals and not _pending_approvals[msg_id].done():
                _pending_approvals[msg_id].set_result(("REGENERATE", update.message.text))


# ═══════════════════════════════════════════════════════════════════════════════
# MEETING REQUEST HANDLER (non-blocking)
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_meeting_request(app, from_email: str, name: str, thread_text: str, zoho_msg_id: str, subject: str):
    """Post a card asking human for meeting date/time. Non-blocking."""
    import local_ai
    chat_id = _chat_id()
    if not chat_id:
        return

    greeting = local_ai.build_greeting(name)

    msg = await app.bot.send_message(
        chat_id=chat_id,
        text=(
            f"🗓️ <b>MEETING REQUEST</b>\n\n"
            f"<b>From:</b> {_esc(greeting.rstrip(','))} (<code>{_esc(from_email)}</code>)\n"
            f"<b>Subject:</b> {_esc(subject)}\n\n"
            f"<b>Reply to THIS message</b> with the date and time.\n"
            f"Example: <i>April 15, 2026 at 4:00 PM IST via Zoom</i>\n\n"
            f"I will draft and send the confirmation for your approval."
        ),
        parse_mode="HTML"
    )

    _pending_meeting_slots[msg.message_id] = {
        "from_email":  from_email,
        "name":        name,
        "thread_text": thread_text,
        "zoho_msg_id": zoho_msg_id,
        "subject":     subject,
    }


async def _send_meeting_confirmation(app, slot: dict, meeting_details: str):
    """Drafts + sends meeting confirmation (after human approval)."""
    import local_ai, zoho_logic, database, ai_orchestrator

    name        = slot["name"]
    from_email  = slot["from_email"]
    zoho_msg_id = slot["zoho_msg_id"]
    thread_text = slot["thread_text"]
    chat_id     = _chat_id()

    greeting = local_ai.build_greeting(name)
    await app.bot.send_message(chat_id=chat_id, text=f"🧠 Drafting meeting confirmation for {greeting.rstrip(',')}...")

    draft = local_ai.draft_meeting_confirmation(name, meeting_details, thread_text)
    if not draft:
        await app.bot.send_message(chat_id=chat_id, text="❌ Draft failed. Reply manually in Zoho.")
        return

    # Clean + add signature
    draft = ai_orchestrator._nuke_clean(draft, name)
    draft = ai_orchestrator._add_signature(draft)

    # Human approval for the confirmation
    decision, _ = await send_draft_for_review(
        app, from_email, f"Re: Meeting — {slot.get('subject', '')}", draft, zoho_msg_id + "_mtg"
    )

    if decision == "SEND":
        zoho = _zoho_ref or zoho_logic.ZohoMailService()
        zoho.send_reply(zoho_msg_id, draft, attach=True)
        zoho.mark_as_read(zoho_msg_id)
        database.update_status(from_email, "Replied")
        await app.bot.send_message(chat_id=chat_id, text=f"✅ Meeting confirmation sent to {greeting.rstrip(',')}")
    else:
        await app.bot.send_message(chat_id=chat_id, text="⏭️ Meeting confirmation skipped.")


# ═══════════════════════════════════════════════════════════════════════════════
# DRAFT REVIEW (human approval for ALL reply emails)
# ═══════════════════════════════════════════════════════════════════════════════

async def send_draft_for_review(app, from_email: str, subject: str, draft: str, msg_id: str, pipeline_summary: str = ""):
    """
    Sends draft to Telegram for human approval.
    Waits up to 60 minutes. Returns (decision, context_text).
    """
    chat_id = _chat_id()
    if not chat_id:
        return "SKIP", None

    _pending_approvals[msg_id] = asyncio.get_event_loop().create_future()

    keyboard = [
        [
            InlineKeyboardButton("✅ SEND", callback_data=f"SEND:{msg_id}"),
            InlineKeyboardButton("🚫 SKIP", callback_data=f"SKIP:{msg_id}"),
        ],
        [
            InlineKeyboardButton("🔄 REGEN (reply with feedback)", callback_data=f"REGENERATE:{msg_id}"),
            InlineKeyboardButton("🗑️ SPAM", callback_data=f"SPAM:{msg_id}"),
        ]
    ]

    draft_preview = draft[:1800] + ("..." if len(draft) > 1800 else "")
    mode_badge = "🟡 TEST" if state.is_safe_test_mode() else "🔴 LIVE"
    pipeline_line = f"\n<i>{_esc(pipeline_summary)}</i>" if pipeline_summary else ""

    try:
        await app.bot.send_message(
            chat_id=chat_id,
            text=(
                f"📬 <b>Draft Ready for Review</b> [{mode_badge}]{pipeline_line}\n\n"
                f"<b>To:</b> <code>{_esc(from_email)}</code>\n"
                f"<b>Subject:</b> {_esc(subject)}\n"
                f"<b>ID:</b> {_esc(msg_id)}\n\n"
                f"<pre>{_esc(draft_preview)}</pre>"
            ),
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    except Exception as e:
        logger.error(f"send_draft_for_review failed: {e}")
        _pending_approvals.pop(msg_id, None)
        return "SKIP", None

    try:
        decision, ctx = await asyncio.wait_for(_pending_approvals[msg_id], timeout=3600)
        return decision, ctx
    except asyncio.TimeoutError:
        return "SKIP", None
    finally:
        _pending_approvals.pop(msg_id, None)


# ═══════════════════════════════════════════════════════════════════════════════
# PIPELINE PROGRESS NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════════════════════

_progress_messages: dict = {}

async def notify_pipeline_start(app, from_email: str, subject: str):
    chat_id = _chat_id()
    if not chat_id:
        return
    try:
        msg = await app.bot.send_message(
            chat_id=chat_id,
            text=(
                f"⚙️ <b>Processing Email</b>\n"
                f"<b>From:</b> <code>{_esc(from_email)}</code>\n"
                f"<b>Subject:</b> {_esc(subject[:60])}\n\n"
                f"[1/5] Classifier... ⏳\n[2/5] Triage...\n[3/5] Strategy...\n[4/5] Draft...\n[5/5] Review..."
            ),
            parse_mode="HTML"
        )
        _progress_messages[from_email] = {"msg_id": msg.message_id, "stages": ["⏳", "", "", "", ""]}
    except Exception as e:
        logger.warning(f"Pipeline start notify failed: {e}")


async def notify_pipeline_stage(app, from_email: str, stage: int, name: str, summary: str):
    chat_id = _chat_id()
    prog = _progress_messages.get(from_email)
    if not chat_id or not prog:
        return

    stages = prog["stages"]
    idx = stage - 1
    if 0 <= idx < 5:
        icon = "✅" if not summary.startswith("⏳") else "⏳"
        stages[idx] = f"{icon} {name}: {summary[:60]}"

    stage_lines = "\n".join(
        f"[{i+1}/5] {s}" if s else f"[{i+1}/5] ..."
        for i, s in enumerate(stages)
    )

    try:
        await app.bot.edit_message_text(
            chat_id=chat_id,
            message_id=prog["msg_id"],
            text=f"⚙️ <b>Processing Email</b>\n<code>{_esc(from_email)}</code>\n\n{stage_lines}",
            parse_mode="HTML"
        )
    except Exception:
        pass


async def notify_send_confirmation(app, to_email: str, subject: str, body_preview: str):
    chat_id = _chat_id()
    if not chat_id:
        return
    mode = "🟡 TEST" if state.is_safe_test_mode() else "🔴 LIVE"
    preview = body_preview[:400] + ("..." if len(body_preview) > 400 else "")
    try:
        await app.bot.send_message(
            chat_id=chat_id,
            text=(
                f"✅ <b>Email Sent</b> [{mode}]\n"
                f"<b>To:</b> <code>{_esc(to_email)}</code>\n"
                f"<b>Subject:</b> {_esc(subject)}\n\n"
                f"<pre>{_esc(preview)}</pre>"
            ),
            parse_mode="HTML"
        )
    except Exception as e:
        logger.warning(f"Send confirmation notify failed: {e}")


async def send_notification(app, text: str):
    chat_id = _chat_id()
    if not chat_id:
        return
    try:
        await app.bot.send_message(chat_id=chat_id, text=text, parse_mode="HTML")
    except Exception as e:
        logger.warning(f"send_notification failed: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# APP BUILDER (registers ALL handlers)
# ═══════════════════════════════════════════════════════════════════════════════

def build_telegram_app():
    from telegram.ext import Defaults
    from telegram.request import HTTPXRequest
    
    # Increase Telegram HTTP timeouts (default 5s is too short when Ollama is busy)
    request = HTTPXRequest(connect_timeout=20.0, read_timeout=30.0, write_timeout=30.0)
    
    app = (ApplicationBuilder()
           .token(config.TELEGRAM_BOT_TOKEN)
           .request(request)
           .build())

    # All 11 commands
    app.add_handler(CommandHandler("start",       cmd_start))
    app.add_handler(CommandHandler("status",      cmd_status))
    app.add_handler(CommandHandler("go_live",     cmd_go_live))
    app.add_handler(CommandHandler("test_mode",   cmd_test_mode))
    app.add_handler(CommandHandler("pause_drip",  cmd_pause_drip))
    app.add_handler(CommandHandler("resume_drip", cmd_resume_drip))
    app.add_handler(CommandHandler("reset_drip",  cmd_reset_drip))
    app.add_handler(CommandHandler("bulk_sync",   cmd_bulk_sync))
    app.add_handler(CommandHandler("bulk_start",  cmd_bulk_start))
    app.add_handler(CommandHandler("reset_spam",  cmd_reset_spam))
    app.add_handler(CommandHandler("db_stats",    cmd_db_stats))

    # Inline button callbacks
    app.add_handler(CallbackQueryHandler(handle_callback))

    # Text messages (meeting replies, regeneration feedback)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Global error handler — suppresses Telegram timeout spam
    async def _error_handler(update, context):
        if "TimedOut" in str(context.error) or "Timed out" in str(context.error):
            logger.debug(f"Telegram timeout (transient): {context.error}")
        else:
            logger.error(f"Telegram error: {context.error}")
    app.add_error_handler(_error_handler)

    return app


async def register_commands(app):
    """Register command menu with Telegram so users see all commands."""
    from telegram import BotCommand
    commands = [
        BotCommand("start",       "Boot message + command list"),
        BotCommand("status",      "Full health check (AI, Zoho, DB)"),
        BotCommand("go_live",     "Switch to LIVE mode (real recipients)"),
        BotCommand("test_mode",   "Switch to safe-test mode"),
        BotCommand("pause_drip",  "Pause the drip campaign"),
        BotCommand("resume_drip", "Resume the drip campaign"),
        BotCommand("reset_drip",  "Reset all targets to Pending"),
        BotCommand("bulk_sync",   "Import leads from output.csv"),
        BotCommand("bulk_start",  "Run drip sweep now"),
        BotCommand("reset_spam",  "Unblock an email address"),
        BotCommand("db_stats",    "Database status breakdown"),
    ]
    try:
        await app.bot.set_my_commands(commands)
        logger.info("✅ Telegram command menu registered (11 commands)")
    except Exception as e:
        logger.warning(f"set_my_commands failed: {e}")
