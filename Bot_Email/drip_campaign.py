"""
Drip Campaign Engine (v3.1 - Hyper-Precision & Local AI)
Deterministic outreach with Local AI name-cleaning and forwarding incentives.
"""

import asyncio
import logging
import config
from zoho_logic import ZohoMailService
import database
import telegram_bot
import ai_orchestrator

logger = logging.getLogger("drip_campaign")

def get_smart_template(attempt_number, name):
    """Professional templates with organizational forwarding incentives."""
    if attempt_number == 0: # Initial
        return (
            f"Dear {name},<br><br>"
            f"On behalf of the Jarurat Care Foundation (JCF), I am honored to invite you to the <b>Horizon Series: International GI Oncology Webinar</b>.<br><br>"
            f"This monthly series brings together world-class oncologists and researchers to discuss the latest advancements in Gastrointestinal Oncology.<br><br>"
            f"If you are part of a medical organization, students club, or hospital network, we would be incredibly grateful if you could forward this invitation to your colleagues. Our goal is to make these life-saving insights accessible to as many professionals as possible.<br><br>"
            f"Please let us know if you would like the registration link.<br><br>"
            f"Best Regards,<br>Ubhay Anand<br>Jarurat Care Foundation"
        )
    elif attempt_number == 1: # 24h Nudge
        return (
            f"Hi {name},<br><br>"
            f"I'm quickly following up on the Horizon Series invitation. If you know any students or junior doctors who would benefit from this, feel free to forward this email to them or your organization's mailing list.<br><br>"
            f"Best,<br>Ubhay Anand"
        )
    elif attempt_number == 2: # 48h Nudge
        return (
            f"Dear {name},<br><br>"
            f"Bumping this to the top of your inbox. Even if you cannot make it personally, we would appreciate it if you could share the summit details with your professional network or university department.<br><br>"
            f"Regards,<br>Ubhay Anand"
        )
    else: # Final Nudge
        return (
            f"Hi {name},<br><br>"
            f"This is my final follow-up. If you could take 10 seconds to forward this to one person or group who might be interested, it would mean a lot to our foundation.<br><br>"
            f"Best,<br>Ubhay Anand"
        )

async def run_drip_campaign(app=None, zoho=None):
    """Execute one sweep of the AI-free smart drip campaign."""
    if not zoho:
        zoho = ZohoMailService()
    
    logger.info("🔍 Scanning for actionable targets...")
    actionable = database.get_actionable_targets()
    
    if not actionable:
        logger.info("📭 No targets currently need emails.")
        return
        
    results = {"initial": 0, "followup": 0, "errors": 0}
    
    for item in actionable:
        email = item["email"]
        action = item["action"]
        raw_name = item["row"].get("Name", "")
        
        # Use our new AI-Orchestrator for high-precision name cleaning (Local AI)
        clean_name = ai_orchestrator.smart_name_clean(raw_name, email)
        
        # ── FLOW 1: Initial
        if action == "send_initial":
            logger.info(f"❄️ Sending Smart Initial to {email} ({clean_name})")
            body = get_smart_template(0, clean_name)
            try:
                zoho.send_new_email(email, "Invitation: International GI Oncology Webinar (Horizon Series)", body)
                database.update_status(email, "Sent_1")
                results["initial"] += 1
            except Exception as e:
                logger.error(f"❌ Failed initial {email}: {e}")
                results["errors"] += 1
                
        # ── FLOW 2: Followups
        elif action.startswith("followup_from_Sent_"):
            n = int(action.split("_")[-1])
            logger.info(f"🔥 Sending Smart Followup #{n} to {email} ({clean_name})")
            body = get_smart_template(n, clean_name)
            try:
                zoho.send_new_email(email, f"Re: Invitation: International GI Oncology Webinar (Horizon Series)", body)
                database.update_status(email, f"Sent_{n + 1}")
                results["followup"] += 1
            except Exception as e:
                logger.error(f"❌ Failed followup {email}: {e}")
                results["errors"] += 1
                
        await asyncio.sleep(2)
        
    if app:
        msg = (
            f"💧 <b>Smart Drip Sweep Complete (Local-AI Ready)</b>\n\n"
            f"🔹 <b>Cold Emails:</b> {results['initial']}\n"
            f"🔥 <b>Follow-ups:</b> {results['followup']}\n"
            f"❌ <b>Errors:</b> {results['errors']}"
        )
        await telegram_bot.send_notification(app, msg)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_drip_campaign())
