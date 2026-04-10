"""
Drip Campaign Engine (v5.1 — Infinite Drip)

Strategy:
  Stage 0: Initial cold email
  Stage 1: First follow-up (24h later)
  Stage 2: Second follow-up (48h later)
  Stage 3+: Keeps sending every 5 days until reply or event date
  
- Auto-sends without per-email approval
- Telegram notification after each send
- Real PDF attachments
- Checks drip_paused before every email
- Reply/unsubscribe = removed from drip forever
"""

import asyncio
import re
import logging
import config
import database
import state
import telegram_bot
import ai_orchestrator
from zoho_logic import ZohoMailService

logger = logging.getLogger("drip_campaign")


def _classify_org(url: str) -> str:
    url = url.lower()
    if any(k in url for k in [".edu", "university", "college", "academic", "institute", "iit", "aiims", "bits"]):
        return "UNIVERSITY"
    if any(k in url for k in ["hospital", "clinic", "healthcare", "medical", "oncology", "tmc", "fortis", "max", "apollo"]):
        return "HOSPITAL"
    return "GENERAL"


async def run_drip_campaign(app=None, zoho=None, limit: int = None):
    """One sweep of the drip campaign."""
    if state.is_drip_paused():
        logger.info("⏸️ Drip is PAUSED")
        if app:
            await telegram_bot.send_notification(app, "⏸️ Drip sweep skipped — paused. /resume_drip to start.")
        return

    if not zoho:
        zoho = ZohoMailService()

    # Pre-upload attachments once for the entire sweep
    zoho.upload_attachments()

    actionable = database.get_actionable_targets()
    if limit:
        actionable = actionable[:limit]

    if not actionable:
        logger.info("📭 No targets need emails")
        if app:
            await telegram_bot.send_notification(app, "📭 <b>Drip Sweep:</b> No targets need emails right now.")
        return

    results = {"initial": 0, "followup": 0, "errors": 0}

    for item in actionable:
        if state.is_drip_paused():
            logger.info("⏸️ Drip paused mid-sweep")
            break

        email    = item["email"]
        action   = item["action"]
        raw_name = item["row"].get("Name", "")
        source   = item["row"].get("Context", item["row"].get("Source", ""))

        # Determine stage number
        if action == "send_initial":
            stage_num = 0
        elif action.startswith("followup_from_Sent_"):
            match = re.search(r'\d+$', action)
            stage_num = int(match.group()) if match else 0
        else:
            stage_num = 0

        # NO CAP on stage_num — drip continues forever until reply or event date
        # Stages 3+ all use the stage 2 (final follow-up) template, which is gentle

        org_type   = _classify_org(source)
        clean_name = ai_orchestrator.clean_name(email, raw_name)

        # For prompts: stages 0,1,2 use their own templates. Stage 3+ reuse template 2.
        prompt_stage = min(stage_num, 2)

        logger.info(f"✍️ Drip for {email} (stage {stage_num}, template {prompt_stage}, name='{clean_name}')...")

        try:
            body = ai_orchestrator.generate_drip_email(clean_name, org_type, prompt_stage)
            if not body:
                logger.error(f"Empty draft for {email}")
                results["errors"] += 1
                continue

            actual_to = state.get_target_email(email)

            # Subject line varies by stage
            if stage_num == 0:
                subject = "Invitation: Horizon Series — GI Oncology Webinar (May 23, 2026)"
            elif stage_num == 1:
                subject = "Follow-Up: Horizon Series Webinar"
            elif stage_num == 2:
                subject = "Gentle Reminder: Horizon Series (May 23, 2026)"
            else:
                subject = f"Horizon Series — We Would Love to Have You (Reminder {stage_num})"

            result = zoho.send_new_email(actual_to, subject, body, attach=True)

            if result is not None:
                new_status = f"Sent_{stage_num + 1}"
                database.update_status(email, new_status)
                if stage_num == 0:
                    results["initial"] += 1
                else:
                    results["followup"] += 1

                if app:
                    await telegram_bot.notify_send_confirmation(
                        app, actual_to, subject,
                        f"[Intended: {email} | Stage: {stage_num}]\n\n{body[:300]}"
                    )
            else:
                results["errors"] += 1

        except Exception as e:
            logger.error(f"Drip error for {email}: {e}")
            results["errors"] += 1

        import random
        await asyncio.sleep(random.randint(config.BULK_SEND_DELAY_MIN, config.BULK_SEND_DELAY_MAX))

    if app:
        mode = "🟡 TEST" if state.is_safe_test_mode() else "🔴 LIVE"
        await telegram_bot.send_notification(
            app,
            f"💧 <b>Drip Sweep Complete</b> [{mode}]\n\n"
            f"📧 Initial: {results['initial']}\n"
            f"🔥 Follow-ups: {results['followup']}\n"
            f"❌ Errors: {results['errors']}"
        )
