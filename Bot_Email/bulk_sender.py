"""
Bulk Email Sender
Reads email list, applies template with Dr. prefix, and sends via Zoho with delays.
"""

import os
import time
import random
import config
from zoho_service import ZohoMailService
from gemini_service import polish_template


def load_email_list():
    """Load and deduplicate emails from data/email_list.txt."""
    if not os.path.exists(config.EMAIL_LIST_PATH):
        print(f"⚠️ Email list not found: {config.EMAIL_LIST_PATH}")
        return []
    
    with open(config.EMAIL_LIST_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()
    
    emails = []
    seen = set()
    for line in lines:
        line = line.strip()
        # Skip empty lines and comments
        if not line or line.startswith("#"):
            continue
        # Basic email validation
        email = line.lower()
        if "@" in email and "." in email and email not in seen:
            seen.add(email)
            emails.append(email)
    
    return emails


def load_template():
    """Load the initial email template."""
    if not os.path.exists(config.INITIAL_TEMPLATE_PATH):
        print(f"⚠️ Template not found: {config.INITIAL_TEMPLATE_PATH}")
        return None
    
    with open(config.INITIAL_TEMPLATE_PATH, "r", encoding="utf-8") as f:
        return f.read()


def extract_name_from_email(email):
    """
    Extract a name from an email address.
    e.g., 'john.smith@hospital.com' -> 'John Smith'
          'drpatel@gmail.com' -> 'Drpatel'
    """
    local = email.split("@")[0]
    # Remove common prefixes
    local = local.replace("dr.", "").replace("dr_", "").replace("dr", "", 1) if local.lower().startswith("dr") else local
    # Split on dots, underscores, hyphens
    parts = []
    for sep in [".", "_", "-"]:
        if sep in local:
            parts = local.split(sep)
            break
    
    if not parts:
        parts = [local]
    
    # Capitalize each part
    name = " ".join(p.capitalize() for p in parts if p)
    return name if name else "Sir/Madam"


def run_bulk_send(progress_callback=None):
    """
    Execute bulk email send.
    
    Args:
        progress_callback: Optional function(message_str) to report progress
    
    Returns:
        Summary string
    """
    emails = load_email_list()
    if not emails:
        return "❌ No emails found in email_list.txt"
    
    template = load_template()
    if not template:
        return "❌ No template found in prompts/initial_email_template.txt"
    
    # Polish template through Gemini (once)
    if progress_callback:
        progress_callback("✨ Polishing email template with AI...")
    polished = polish_template(template)
    
    # Extract subject from template (first line starting with "Subject:")
    subject = "Invitation to Medical Conference — 23rd May 2025"
    for line in polished.split("\n"):
        if line.strip().lower().startswith("subject:"):
            subject = line.split(":", 1)[1].strip()
            # Remove this line from the body
            polished = polished.replace(line + "\n", "", 1)
            break
    
    # Initialize Zoho
    zoho = ZohoMailService()
    
    total = len(emails)
    sent = 0
    failed = 0
    skipped_dupes = 0
    results = []
    
    if progress_callback:
        progress_callback(f"📧 Sending to {total} recipients (with 5-10s delays)...")
    
    for i, email in enumerate(emails, 1):
        doctor_name = extract_name_from_email(email)
        # Always prefix with Dr.
        personalized = polished.replace("{doctor_name}", f"Dr. {doctor_name}")
        
        try:
            zoho.send_new_email(email, subject, personalized)
            sent += 1
            if progress_callback and (i % 5 == 0 or i == total):
                progress_callback(f"📬 Progress: {i}/{total} sent ({sent} ok, {failed} failed)")
        except Exception as e:
            failed += 1
            results.append(f"❌ {email}: {e}")
            print(f"❌ Failed to send to {email}: {e}")
        
        # Delay between sends (except last one)
        if i < total:
            delay = random.uniform(config.BULK_SEND_DELAY_MIN, config.BULK_SEND_DELAY_MAX)
            time.sleep(delay)
    
    summary = (
        f"📊 <b>Bulk Send Complete</b>\n\n"
        f"✅ Sent: {sent}/{total}\n"
        f"❌ Failed: {failed}\n"
    )
    if results:
        summary += "\n<b>Failures:</b>\n" + "\n".join(results[:10])
    
    return summary


# ── Standalone test ────────────────────────────────────────
if __name__ == "__main__":
    config.validate()
    
    emails = load_email_list()
    print(f"📋 Found {len(emails)} emails in list:")
    for e in emails[:5]:
        name = extract_name_from_email(e)
        print(f"   {e} → Dr. {name}")
    if len(emails) > 5:
        print(f"   ... and {len(emails) - 5} more")
    
    print(f"\n   Template: {'Found ✅' if load_template() else 'Missing ❌'}")
    print("\n⚠️ To actually send, use /bulksend in Telegram or run main.py")
