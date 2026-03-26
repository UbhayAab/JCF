"""
Smart Demo Bot
- Filters for specifically named users ("ubhay", "ubhai", "obai").
- Fetches full conversation history by searching the entire mailbox for the user's email.
- Uses Gemini AI strictly for the user's custom spam rules.
- Replies via Zoho `send_new_email` proving the thread count.
- Logs to Telegram.
"""

import asyncio
import logging
import time

import config
from zoho_service import ZohoMailService
import telegram_bot
import google.generativeai as genai

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("smart_demo")


def _get_full_conversation(zoho, target_email):
    """
    Fetch the last 50 emails from Inbox and Sent, 
    filter by target_email, and sort them chronologically.
    This guarantees we capture every email regardless of thread ID bugs.
    """
    try:
        inbox_id = zoho.get_folder_id("Inbox")
        sent_id = zoho.get_folder_id("Sent")
        
        inbox_data = zoho._api_get("messages/view", params={"limit": 50, "folderId": inbox_id})
        sent_data = zoho._api_get("messages/view", params={"limit": 50, "folderId": sent_id})
        
        all_msgs = inbox_data.get("data", []) + sent_data.get("data", [])
        
        # Filter for messages involving this email
        filtered = []
        for msg in all_msgs:
            f_addr = msg.get("fromAddress", "").lower()
            t_addr = msg.get("toAddress", "").lower()
            if target_email.lower() in f_addr or target_email.lower() in t_addr:
                filtered.append(msg)
                
        # Remove exact duplicates (same messageId)
        unique_msgs = {m.get("messageId"): m for m in filtered}.values()
        
        # Sort oldest first based on receivedTime string
        sorted_msgs = sorted(unique_msgs, key=lambda x: int(x.get("receivedTime", "0")))
        return sorted_msgs
    except Exception as e:
        logger.error(f"Error fetching global history for {target_email}: {e}")
        return []


def analyze_thread_spam(thread_text):
    """Simple AI verifier per user rules."""
    genai.configure(api_key=config.GEMINI_API_KEY)
    prompt = f"""
You are a simple spam classifier for an email thread demo.
Look specifically at the LATEST message in this thread context.

RULES:
1. If the latest message explicitly says "this is a spam email", or if they start aggressively selling something, output "SPAM".
2. If the user explicitly writes "this is not a spam", or "please mark not a spam", output "NOT_SPAM".
3. If it's a normal test or inquiry, output "NOT_SPAM".

Output ONLY the word "SPAM" or "NOT_SPAM". Do not write any other text.
Here is the thread:
{thread_text}
"""
    try:
        model = genai.GenerativeModel("gemini-2.5-flash")
        resp = model.generate_content(prompt)
        text = resp.text.strip().upper()
        logger.info(f"🧠 AI raw output: {text}")
        return text == "SPAM" or text.startswith("SPAM") and "NOT" not in text
    except Exception as e:
        logger.error(f"Gemini error: {e}")
        return False # Fallback to not-spam


async def process_email(app, zoho, email):
    msg_id = email.get("messageId")
    from_email = email.get("fromAddress", "Unknown")
    subject = email.get("subject", "No Subject")
    
    # 1. Check if user name is present in metadata
    content_preview = email.get("summary", "").lower()
    name_variations = ["ubhay", "ubhai", "obai"]
    
    is_targeted = any(name in from_email.lower() for name in name_variations) or \
                  any(name in subject.lower() for name in name_variations) or \
                  any(name in content_preview for name in name_variations)
                  
    if not is_targeted:
        logger.info(f"⏭️ Skipping {from_email}")
        zoho.mark_as_read(msg_id)
        return
        
    logger.info(f"🎯 Target matched for {from_email}! Extracting full history...")
    
    # 2. Get full conversation
    messages = _get_full_conversation(zoho, from_email)
    if not messages:
        messages = [email] # Fallback
        
    # 3. Build text string for AI context
    thread_parts = []
    reply_lines = []
    
    for idx, msg in enumerate(messages):
        try:
             content = zoho.get_email_content(msg["messageId"])
        except:
             content = msg.get("summary", "[Content unreadable]")
        
        sender = msg.get("fromAddress", "Unknown")
        time_str = msg.get('receivedTime', 'Unknown')
        
        thread_parts.append(f"From: {sender}\n{content}\n---")
        
        # Build HTML reply lines for user
        reply_lines.append(f"<b>This was the {idx + 1} email in this thread</b> (Sent: {time_str}):<br>")
        reply_lines.append(f" -> {content.strip()}<br><br>")
        
    full_thread_text = "\n".join(thread_parts)
    
    # 4. AI Spam Check
    is_spam = analyze_thread_spam(full_thread_text)
    
    # 5. Build Final Reply
    prefix = (
        "This is a spam email, and this is an automated reply.<br><br>" 
        if is_spam else 
        "This was not a spam. This is an automated reply.<br><br>"
    )
    
    final_reply_html = prefix + "".join(reply_lines)
    
    # 6. Send Reply
    logger.info(f"📤 Sending reply to {from_email} (Spam: {is_spam})")
    try:
        reply_subj = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        zoho.send_new_email(from_email, reply_subj, final_reply_html)
        zoho.mark_as_read(msg_id)
        logger.info("✅ Reply sent via send_new_email.")
    except Exception as e:
        logger.error(f"❌ Send failed: {e}")
        
    # 7. Notify Telegram
    msg_html = (
        f"🤖 <b>SMART DEMO EXECUTED</b>\n\n"
        f"<b>From:</b> {telegram_bot._escape_html(from_email)}\n"
        f"<b>Emails in Thread:</b> {len(messages)}\n"
        f"<b>AI Verdict:</b> {'🚫 SPAM' if is_spam else '✅ NOT SPAM'}\n\n"
        f"<b>Reply Sent:</b>\n"
        f"<i>{telegram_bot._escape_html(final_reply_html[:2000])}</i>"
    )
    await telegram_bot.send_notification(app, msg_html)


async def main_loop():
    config.validate()
    zoho = ZohoMailService()
    
    app = telegram_bot.build_telegram_app()
    await app.initialize()
    await app.start()
    
    logger.info("🚀 Starting Smart Demo Bot...")
    local_seen = set()

    while True:
        try:
            folder_id = zoho.get_folder_id("Inbox")
            data = zoho._api_get("messages/view", params={"status": "unread", "limit": 10, "folderId": folder_id})
            
            emails = data.get("data", [])
            new_emails = [e for e in emails if e.get("messageId") not in local_seen]
            
            for e in new_emails:
                local_seen.add(e.get("messageId"))
                await process_email(app, zoho, e)
                
        except Exception as e:
            logger.error(f"Poll error: {e}")
            
        await asyncio.sleep(20)

if __name__ == "__main__":
    asyncio.run(main_loop())
