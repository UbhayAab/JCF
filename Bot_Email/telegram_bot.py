"""
Telegram Bot Interface for Carcinome Outreach.
Handles human-in-the-loop approvals and remote campaign management.
"""

import logging
import re
import asyncio
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ContextTypes
import config
import html

# Configure logging
logger = logging.getLogger("telegram_bot")

_group_chat_id = None
_pending_decisions = {}
_bulk_send_callback = None

def set_bulk_send_callback(cb):
    global _bulk_send_callback
    _bulk_send_callback = cb

def _escape_html(text):
    return html.escape(text or "")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global _group_chat_id
    _group_chat_id = update.effective_chat.id
    await update.message.reply_text(
        f"🤖 <b>Email Bot Active!</b>\n\n"
        f"📍 <b>Group ID:</b> <code>{_group_chat_id}</code>\n"
        f"🚀 Monitoring your Zoho inbox for inquiries.\n\n"
        f"<b>Commands:</b>\n"
        f"/bulk_sync - Import leads from output.csv\n"
        f"/bulk_start - Trigger Drip Campaign sweep\n"
        f"/reset_spam &lt;email&gt; - Unblock an email\n"
        f"/status - General system health",
        parse_mode="HTML"
    )

async def bulk_sync(update: Update, context: ContextTypes.DEFAULT_TYPE):
    import database
    added_count, msg = database.sync_external_csv()
    await update.message.reply_text(f"📊 <b>Sync Result:</b>\n{msg}", parse_mode='HTML')

async def bulk_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if _bulk_send_callback:
        await update.message.reply_text("🚀 Starting Smart Drip Campaign Sweep...")
        try:
            await _bulk_send_callback(context.application, None)
        except Exception as e:
            await update.message.reply_text(f"❌ Error during drip: {e}")
    else:
        await update.message.reply_text("⚠️ System Error: Drip Trigger not registered.")

async def reset_spam(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /reset_spam <email>")
        return
    email = context.args[0]
    import database
    if database.reset_spam_status(email):
        await update.message.reply_text(f"✅ {email} reset to Pending.")
    else:
        await update.message.reply_text(f"❌ {email} not found.")

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    data = query.data.split(":")
    action = data[0]
    msg_id = data[1]
    
    if msg_id in _pending_decisions:
        _pending_decisions[msg_id].set_result((action, None))
        await query.edit_message_reply_markup(reply_markup=None)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle custom reply context (regenerate)."""
    if update.message.reply_to_message and update.message.reply_to_message.reply_markup:
        # Extract msg_id from previous message or metadata
        text = update.message.reply_to_message.text
        match = re.search(r'ID: (\d+)', text)
        if match:
            msg_id = match.group(1)
            if msg_id in _pending_decisions:
                _pending_decisions[msg_id].set_result(("REGENERATE", update.message.text))

async def send_admin_alert(app, text, msg_id):
    """Sends a high-priority alert to the group."""
    keyboard = [
        [InlineKeyboardButton("📖 View Full Thread", callback_data=f"VTH_{msg_id}")],
        [InlineKeyboardButton("❌ Ignore", callback_data=f"REJ_{msg_id}")]
    ]
    await app.bot.send_message(
        chat_id=config.TELEGRAM_GROUP_CHAT_ID,
        text=text,
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def _handle_view_thread(update, context):
    """Callback to show the last 5 messages in the thread."""
    query = update.callback_query
    msg_id = query.data.split("_")[-1]
    await query.answer("Fetching thread history...")
    
    # We'll use a placeholder or call zoho here
    # For now, let's just confirm it's implemented
    await query.edit_message_text(
        text=f"{query.message.text}\n\n<i>[Thread history would appear here - Requires Zoho integration fetch]</i>",
        parse_mode="HTML"
    )

async def send_notification(app, text):
    chat_id = _group_chat_id or config.TELEGRAM_GROUP_CHAT_ID
    if chat_id and chat_id != "WILL_AUTO_DETECT":
        await app.bot.send_message(chat_id=chat_id, text=text, parse_mode="HTML")

async def send_draft_for_review(app, from_email, subject, draft, msg_id):
    chat_id = _group_chat_id or config.TELEGRAM_GROUP_CHAT_ID
    if not chat_id: return "SKIP", None
    
    _pending_decisions[msg_id] = asyncio.Future()
    
    keyboard = [
        [InlineKeyboardButton("✅ SEND", callback_data=f"SEND:{msg_id}"),
         InlineKeyboardButton("🚫 SPAM", callback_data=f"SPAM:{msg_id}")],
        [InlineKeyboardButton("🔄 REGENERATE (Reply to this)", callback_data=f"REGENERATE:{msg_id}")]
    ]
    
    text = (
        f"🤖 <b>AI Draft Review</b>\n\n"
        f"📧 <b>From:</b> {from_email}\n"
        f"📝 <b>Subject:</b> {subject}\n"
        f"🆔 <b>ID:</b> {msg_id}\n\n"
        f"--- Draft ---\n"
        f"{draft}\n"
    )
    
    await app.bot.send_message(chat_id=chat_id, text=text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="HTML")
    
    try:
        decision, context = await asyncio.wait_for(_pending_decisions[msg_id], timeout=3600)
        return decision, context
    except:
        return "SKIP", None
    finally:
        _pending_decisions.pop(msg_id, None)

def build_telegram_app():
    return ApplicationBuilder().token(config.TELEGRAM_BOT_TOKEN).build()
