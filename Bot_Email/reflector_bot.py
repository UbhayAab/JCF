"""
Automated Reflector Bot
Bypasses Gemini AI. 
Reads the entire thread (or all emails from a specific sender), 
builds a numbered template proving it can read context, 
sends the reply back via Zoho, and notifies Telegram.
"""

import asyncio
import logging
import time

import config
from zoho_service import ZohoMailService
import telegram_bot

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("reflector")


def _get_all_messages_from_user(zoho, from_email, thread_id=None):
    """
    Finds all messages from the user. 
    If thread_id exists, it gets the thread. Otherwise it searches by email.
    """
    messages = []
    try:
        if thread_id:
            logger.info(f"Fetching thread {thread_id}...")
            data = zoho._api_get("messages/view", params={"threadId": thread_id, "limit": 50})
            messages = data.get("data", [])
            messages.reverse() # Oldest first
        else:
            logger.info(f"Searching for all emails from {from_email}...")
            # Fallback to search if no thread ID
            data = zoho._api_get("messages/search", params={"searchKey": f"from:{from_email}", "limit": 10})
            messages = data.get("data", [])
            messages.reverse() # Oldest first
    except Exception as e:
        logger.error(f"Error fetching history: {e}")
        
    return messages


async def reflector_process_email(app, zoho, email):
    msg_id = email.get("messageId")
    from_email = email.get("fromAddress", "Unknown")
    subject = email.get("subject", "No Subject")
    thread_id = email.get("threadId", msg_id)
    
    logger.info(f"📧 Processing: {subject} (from {from_email})")
    
    # Check if this email is from or contains variations of the user's name
    content_preview = email.get("summary", "").lower()
    name_variations = ["ubhay", "ubhai", "obai"]
    
    is_targeted = any(name in from_email.lower() for name in name_variations) or \
                  any(name in subject.lower() for name in name_variations) or \
                  any(name in content_preview for name in name_variations)
                  
    if not is_targeted:
        logger.info(f"⏭️ Skipping {from_email} (Does not contain target name)")
        # Still mark as read so we don't loop
        zoho.mark_as_read(msg_id)
        return
    
    logger.info(f"🎯 Target matched for {from_email}! Processing...")
    
    # 1. Gather all emails in this conversation
    messages = _get_all_messages_from_user(zoho, from_email, thread_id)
    
    if not messages:
        messages = [email] # Fallback to just this one
        
    # 2. Build the template reply
    reply_lines = [
        "Hey! This is an automated message.",
        "We are successfully able to read your message and extract full context.<br><br>",
    ]
    
    if len(messages) == 1:
        reply_lines.append(f"<b>This is the 1st (and only) email in this thread:</b><br>")
        try:
             content = zoho.get_email_content(messages[0]["messageId"])
        except:
             content = "[Content unreadable]"
        reply_lines.append(f" -> {content.strip()}<br><br>")
    else:
        for idx, msg in enumerate(messages):
            try:
                content = zoho.get_email_content(msg["messageId"])
            except:
                content = msg.get("summary", "[Content unreadable]")
                
            reply_lines.append(f"<b>This was the {idx + 1} email in this thread</b> (Sent: {msg.get('receivedTime', 'Unknown')}):<br>")
            reply_lines.append(f" -> {content.strip()}<br><br>")
            
    final_reply_text = "".join(reply_lines)
    
    # 3. Send via Zoho
    logger.info(f"📤 Sending automated template reply to {from_email}...")
    try:
        reply_subj = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        zoho.send_new_email(from_email, reply_subj, final_reply_text)
        zoho.mark_as_read(msg_id)
        logger.info("✅ Reply sent successfully.")
    except Exception as e:
        logger.error(f"❌ Failed to send reply: {e}")
        
    # 4. Notify Telegram
    msg_html = (
        f"🧪 <b>REFLECTOR TEST EXECUTED</b>\n\n"
        f"<b>From:</b> {telegram_bot._escape_html(from_email)}\n"
        f"<b>Emails in Thread:</b> {len(messages)}\n\n"
        f"<b>🤖 Reply Sent:</b>\n"
        f"<i>{telegram_bot._escape_html(final_reply_text[:2000])}</i>"
    )
    await telegram_bot.send_notification(app, msg_html)


async def reflector_loop():
    config.validate()
    zoho = ZohoMailService()
    
    app = telegram_bot.build_telegram_app()
    await app.initialize()
    await app.start()
    
    logger.info("🚀 Starting Reflector Bot (No AI, Direct Replies)...")
    local_seen = set()

    while True:
        try:
            try:
                folder_id = zoho.get_folder_id("Inbox")
            except:
                folder_id = None
                 
            params = {"status": "unread", "limit": 10}
            if folder_id:
                params["folderId"] = folder_id

            data = zoho._api_get("messages/view", params=params)
            emails = data.get("data", [])
            
            new_emails = [e for e in emails if e.get("messageId") not in local_seen]
            
            if new_emails:
                logger.info(f"📬 Found {len(new_emails)} new unread email(s).")
                for e in new_emails:
                    local_seen.add(e.get("messageId"))
                    await reflector_process_email(app, zoho, e)
            
        except Exception as e:
            logger.error(f"Error during poll: {e}")
            
        await asyncio.sleep(20)


if __name__ == "__main__":
    try:
        asyncio.run(reflector_loop())
    except KeyboardInterrupt:
        logger.info("\n🛑 Reflector stopped.")
