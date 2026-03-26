"""
Telegram Bot — Human-in-the-Loop for Email Approval
Runs in a Telegram GROUP so any team member can approve/edit/cancel email drafts.
Also supports /bulksend command and auto-detects group chat ID.
"""

import asyncio
import html
import os
import re
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes
)
import config

logger = logging.getLogger(__name__)

# ── Shared state ───────────────────────────────────────────
# Pending decisions: message_id -> asyncio.Future
_pending_decisions = {}
# Store the group chat ID once detected
_group_chat_id = None
# Callback for bulk send (set by main.py)
_bulk_send_callback = None
# Store custom context requests: chat_id -> message_id being edited
_awaiting_context = {}


def set_bulk_send_callback(callback):
    """Set the callback function for /bulksend command."""
    global _bulk_send_callback
    _bulk_send_callback = callback


def get_group_chat_id():
    """Return the detected group chat ID."""
    return _group_chat_id


# ── Helpers ────────────────────────────────────────────────

def _truncate(text, max_len=3000):
    """Truncate text for Telegram's message limit."""
    if len(text) <= max_len:
        return text
    return text[:max_len] + "\n\n... [truncated]"


def _escape_html(text):
    """Escape HTML for Telegram's HTML parse mode."""
    return html.escape(text)


# ── Handlers ───────────────────────────────────────────────

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command — also auto-detects group chat ID."""
    global _group_chat_id
    chat_id = update.effective_chat.id
    
    # Auto-detect group chat ID
    if update.effective_chat.type in ("group", "supergroup"):
        _group_chat_id = str(chat_id)
        # Persist to .env if needed
        _save_group_chat_id(str(chat_id))
        await update.message.reply_text(
            f"✅ Bot activated in this group!\n"
            f"📋 Group Chat ID: <code>{chat_id}</code>\n\n"
            f"Commands:\n"
            f"• /status — Check bot status\n"
            f"• /bulksend — Send initial emails to all addresses in email_list.txt\n"
            f"• /help — Show this message",
            parse_mode="HTML"
        )
    else:
        await update.message.reply_text(
            "⚠️ Please add me to a GROUP and use /start there.\n"
            "I work best in group chats so your whole team can participate."
        )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command."""
    await update.message.reply_text(
        "🤖 <b>Email Bot Commands</b>\n\n"
        "• /start — Activate bot & detect group\n"
        "• /status — Check if bot is running\n"
        "• /bulksend — Send initial outreach emails\n"
        "• /help — Show this message\n\n"
        "<b>When a reply comes in:</b>\n"
        "I'll show you the AI-drafted reply with buttons:\n"
        "✅ Send — Approve and send the reply\n"
        "✏️ Edit — Provide custom context, I'll regenerate\n"
        "❌ Cancel — Skip this email",
        parse_mode="HTML"
    )


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /status command."""
    pending = len(_pending_decisions)
    await update.message.reply_text(
        f"🟢 Bot is running\n"
        f"📬 Pending decisions: {pending}\n"
        f"📋 Group Chat ID: <code>{_group_chat_id or 'Not set'}</code>",
        parse_mode="HTML"
    )


async def bulksend_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /bulksend command — triggers bulk email sending."""
    if _bulk_send_callback is None:
        await update.message.reply_text("⚠️ Bulk send not configured yet. Wait for the bot to fully start.")
        return
    
    await update.message.reply_text(
        "📧 Starting bulk email send...\n"
        "I'll send updates here as emails go out."
    )
    
    # Run bulk send in background
    asyncio.create_task(_run_bulk_send(update))


async def _run_bulk_send(update: Update):
    """Run bulk send and report results."""
    try:
        result = await asyncio.get_event_loop().run_in_executor(None, _bulk_send_callback)
        await update.message.reply_text(f"✅ Bulk send complete!\n\n{result}")
    except Exception as e:
        await update.message.reply_text(f"❌ Bulk send failed: {e}")


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle inline button presses (Approve/Edit/Cancel)."""
    query = update.callback_query
    await query.answer()
    
    data = query.data  # Format: "action:message_id"
    parts = data.split(":", 1)
    if len(parts) != 2:
        return
    
    action, msg_id = parts
    
    if msg_id not in _pending_decisions:
        await query.edit_message_text("⚠️ This decision has already been made or expired.")
        return
    
    if action == "approve":
        _pending_decisions[msg_id].set_result(("approve", None))
        await query.edit_message_text(
            query.message.text + "\n\n✅ <b>APPROVED — Sending reply...</b>",
            parse_mode="HTML"
        )
    
    elif action == "cancel":
        _pending_decisions[msg_id].set_result(("cancel", None))
        await query.edit_message_text(
            query.message.text + "\n\n❌ <b>CANCELLED — Skipping this email.</b>",
            parse_mode="HTML"
        )
    
    elif action == "edit":
        _awaiting_context[update.effective_chat.id] = msg_id
        await query.edit_message_text(
            query.message.text + "\n\n✏️ <b>EDIT MODE — Type your custom context/instructions below:</b>",
            parse_mode="HTML"
        )


async def text_message_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages — used for receiving custom context during edit flow."""
    chat_id = update.effective_chat.id
    
    if chat_id in _awaiting_context:
        msg_id = _awaiting_context.pop(chat_id)
        custom_context = update.message.text
        
        if msg_id in _pending_decisions:
            _pending_decisions[msg_id].set_result(("edit", custom_context))
            await update.message.reply_text(
                f"📝 Got it! Regenerating reply with your context:\n"
                f"<i>{_escape_html(_truncate(custom_context, 500))}</i>",
                parse_mode="HTML"
            )


# ── API for main.py ────────────────────────────────────────

async def send_draft_for_review(app, from_email, subject, draft_reply, message_id):
    """
    Send a draft reply to the Telegram group for approval.
    Returns: ("approve", None) | ("edit", custom_context) | ("cancel", None)
    """
    chat_id = _group_chat_id or config.TELEGRAM_GROUP_CHAT_ID
    if not chat_id or chat_id == "WILL_AUTO_DETECT":
        raise Exception(
            "Group Chat ID not set! Add the bot to a group and send /start"
        )
    chat_id = int(chat_id)
    
    text = (
        f"📧 <b>New Email Reply Needed</b>\n\n"
        f"<b>From:</b> {_escape_html(from_email)}\n"
        f"<b>Subject:</b> {_escape_html(subject)}\n\n"
        f"<b>──── AI Draft Reply ────</b>\n\n"
        f"{_escape_html(_truncate(draft_reply))}\n\n"
        f"<b>────────────────────────</b>"
    )
    
    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton("✅ Send", callback_data=f"approve:{message_id}"),
            InlineKeyboardButton("✏️ Edit", callback_data=f"edit:{message_id}"),
            InlineKeyboardButton("❌ Cancel", callback_data=f"cancel:{message_id}"),
        ]
    ])
    
    # Create a future to wait for the decision
    loop = asyncio.get_event_loop()
    future = loop.create_future()
    _pending_decisions[message_id] = future
    
    await app.bot.send_message(
        chat_id=chat_id,
        text=text,
        parse_mode="HTML",
        reply_markup=keyboard,
    )
    
    # Wait for human decision (blocks until button is pressed)
    result = await future
    del _pending_decisions[message_id]
    
    return result


async def send_notification(app, text):
    """Send a plain notification to the group."""
    chat_id = _group_chat_id or config.TELEGRAM_GROUP_CHAT_ID
    if not chat_id or chat_id == "WILL_AUTO_DETECT":
        return
    
    await app.bot.send_message(
        chat_id=int(chat_id),
        text=text,
        parse_mode="HTML",
    )


# ── Persistence ────────────────────────────────────────────

def _save_group_chat_id(chat_id_str):
    """Update .env file with the detected group chat ID."""
    global _group_chat_id
    _group_chat_id = chat_id_str
    
    env_path = os.path.join(config.BASE_DIR, ".env")
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        if "TELEGRAM_GROUP_CHAT_ID" in content:
            import re
            content = re.sub(
                r"TELEGRAM_GROUP_CHAT_ID=.*",
                f"TELEGRAM_GROUP_CHAT_ID={chat_id_str}",
                content
            )
        else:
            content += f"\nTELEGRAM_GROUP_CHAT_ID={chat_id_str}\n"
        
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(content)
        
        print(f"✅ Saved Group Chat ID to .env: {chat_id_str}")
    except Exception as e:
        print(f"⚠️ Could not save chat ID to .env: {e}")



# ── Build Application ─────────────────────────────────────

def build_telegram_app():
    """Build and return the Telegram Application (not started yet)."""
    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()
    
    # Register handlers
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("status", status_command))
    app.add_handler(CommandHandler("bulksend", bulksend_command))
    app.add_handler(CallbackQueryHandler(button_callback))
    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND,
        text_message_handler
    ))
    
    return app


# ── Standalone test ────────────────────────────────────────
if __name__ == "__main__":
    config.validate()
    
    print("🤖 Testing Telegram bot...")
    print("   Starting bot — send /start in your group to activate.")
    print("   Press Ctrl+C to stop.\n")
    
    app = build_telegram_app()
    app.run_polling(drop_pending_updates=True)
