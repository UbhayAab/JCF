"""
Drip Campaign Engine
Runs periodically (e.g., cron job or background loop) to check the Central Brain.
- Sends initial cold emails.
- Sends follow-up nudges based on 24h/48h/96h delays.
"""

import asyncio
import logging
import google.generativeai as genai

import config
from zoho_service import ZohoMailService
import database
import telegram_bot

logger = logging.getLogger("drip_campaign")


def _load_template(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return "Greetings {name}, this is an automated outreach from Jarurat Care."


def generate_followup_email(target_name, attempt_number):
    """
    Generates a smart contextual nudge using the FOLLOWUP API Key.
    Attempt 1 -> 24h nudge
    Attempt 2 -> 48h nudge
    Attempt 3 -> 96h final nudge
    """
    genai.configure(api_key=config.GEMINI_API_KEY_FOLLOWUP)
    
    contexts = {
        1: "It has been 24 hours since we reached out. Send a polite, brief reminder.",
        2: "It has been a few days. Emphasize the urgency or value of the event.",
        3: "This is our final attempt reaching out after a week. Keep it very short and open the door for future communication."
    }
    
    prompt = (
        f"You are reaching out to {target_name} on behalf of Jarurat Care (Cancer Awareness NGO).\n"
        f"Context: {contexts.get(attempt_number, 'Send a follow-up reminder.')}\n"
        f"Keep the tone professional and warm. Output ONLY the email body. Use <br> for line breaks."
    )
    
    try:
        model = genai.GenerativeModel("gemini-2.5-flash-lite")
        response = model.generate_content(prompt)
        return response.text.strip().replace("\n", "<br>")
    except Exception as e:
        logger.error(f"Followup Generation Error: {e}")
        # Fallback templates to save API or if API fails
        fallbacks = {
            1: f"Hi {target_name},<br><br>I wanted to quickly follow up on my previous email. Let me know if you received it!<br><br>Best,<br>Jarurat Care Team",
            2: f"Dear {target_name},<br><br>I'm bumping this to the top of your inbox. We would love to have you involved with the summit.<br><br>Best,<br>Jarurat Care Team",
            3: f"Hi {target_name},<br><br>I haven't heard back so I assume you're busy! This will be my last email, but please reach out if things change.<br><br>Best,<br>Jarurat Care Team"
        }
        return fallbacks.get(attempt_number, fallbacks[1])


async def run_drip_campaign(app=None, zoho=None):
    """Execute one sweep of the drip campaign."""
    if not zoho:
        config.validate()
        zoho = ZohoMailService()
    
    logger.info("🔍 Scanning Central Brain for actionable targets...")
    actionable = database.get_actionable_targets()
    
    if not actionable:
        logger.info("📭 No targets currently need emails.")
        return
        
    logger.info(f"📤 Found {len(actionable)} targets needing outreach.")
    results = {"initial": 0, "followup": 0, "errors": 0}
    
    initial_template = _load_template(config.INITIAL_TEMPLATE_PATH)
    
    for item in actionable:
        email = item["email"]
        action = item["action"]
        name = item["row"].get("Name", "Doctor")
        
        # ── FLOW 1: Cold Initial Outreach
        if action == "send_initial":
            logger.info(f"❄️ Sending Cold Initial to {email}")
            body = initial_template.replace("{doctor_name}", name).replace("\n", "<br>")
            
            try:
                zoho.send_new_email(email, "Invitation: Cancer Awareness Summit", body)
                database.update_status(email, "Sent_1")
                results["initial"] += 1
            except Exception as e:
                logger.error(f"❌ Failed to email {email}: {e}")
                results["errors"] += 1
                
        # ── FLOW 2: Warm Followups
        elif action.startswith("followup_from_Sent_"):
            current_sent = int(action.split("_")[-1]) # e.g., Sent_1 -> 1
            logger.info(f"🔥 Sending Followup #{current_sent} to {email}")
            
            body = generate_followup_email(name, current_sent)
            
            try:
                # "Re: Invitation" to thread it naturally (this ignores Zoho's internal ThreadId but looks right to Gmail)
                zoho.send_new_email(email, "Re: Invitation: Cancer Awareness Summit", body)
                database.update_status(email, f"Sent_{current_sent + 1}")
                results["followup"] += 1
            except Exception as e:
                logger.error(f"❌ Failed followup to {email}: {e}")
                results["errors"] += 1
                
        # To avoid Zoho API rate limits when bulk sending
        await asyncio.sleep(2)
        
    # Send Summary to Telegram if app is provided
    if app:
        msg = (
            f"💧 <b>Drip Campaign Sweep Complete</b>\n\n"
            f"🔹 <b>Cold Emails Sent:</b> {results['initial']}\n"
            f"🔥 <b>Follow-ups Sent:</b> {results['followup']}\n"
            f"❌ <b>Errors:</b> {results['errors']}"
        )
        await telegram_bot.send_notification(app, msg)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("Running test drip campaign sweep...")
    asyncio.run(run_drip_campaign())
