"""
Central Brain (CRM) for Jarurat Care Outreach
Manages the state of all email targets via a local CSV file.
"""

import os
import csv
import time
import logging

logger = logging.getLogger("database")

DB_FILE = "data/database.csv"
FIELDNAMES = ["Email", "Status", "LastUpdated", "Name", "Context", "FirstInteraction", "ThreadCount"]

# Time Thresholds (in seconds)
# e.g., Sent_1 -> Sent_2 requires 24h (86400s)
THRESHOLDS = {
    "Sent_1": 24 * 3600,   # 1 Day
    "Sent_2": 48 * 3600,   # 2 Days
    "Sent_3": 96 * 3600,   # 4 Days
}

def ensure_db():
    """Ensure the database file and directory exist."""
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    if not os.path.exists(DB_FILE):
        with open(DB_FILE, mode='w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()


def load_db():
    ensure_db()
    with open(DB_FILE, mode='r', newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)


def save_db(rows):
    ensure_db()
    with open(DB_FILE, mode='w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def add_target(email, name="", context="", status="Pending", first_interaction="Unknown", thread_count=1):
    """Add a new target if it doesn't already exist."""
    rows = load_db()
    email_clean = email.strip().lower()
    
    for row in rows:
        if row["Email"].strip().lower() == email_clean:
            return False  # Already exists
            
    rows.append({
        "Email": email_clean,
        "Status": status,
        "LastUpdated": str(int(time.time())),
        "Name": name,
        "Context": context,
        "FirstInteraction": first_interaction,
        "ThreadCount": str(thread_count)
    })
    save_db(rows)
    return True


def get_target(email):
    """Get a target's full record."""
    rows = load_db()
    email_clean = email.strip().lower()
    for row in rows:
        if row["Email"].strip().lower() == email_clean:
            return row
    return None


def update_status(email, new_status):
    """Safely transitions a target's status and updates the timestamp."""
    rows = load_db()
    email_clean = email.strip().lower()
    updated = False
    
    for row in rows:
        if row["Email"].strip().lower() == email_clean:
            row["Status"] = new_status
            row["LastUpdated"] = str(int(time.time()))
            updated = True
            break
            
    if updated:
        save_db(rows)
    return updated


def get_actionable_targets():
    """
    Returns targets that need immediate action based on the drip campaign rules.
    - Pending (needs initial cold outreach)
    - Sent_X where LastUpdated threshold has passed (needs followup)
    """
    rows = load_db()
    actionable = []
    current_time = int(time.time())
    
    for row in rows:
        status = row.get("Status", "Unknown")
        
        # Fresh targets
        if status == "Pending":
            actionable.append({"email": row["Email"], "action": "send_initial", "row": row})
            continue
            
        # Follow-up targets
        if status in THRESHOLDS:
            last_updated = int(row.get("LastUpdated", "0"))
            threshold_seconds = THRESHOLDS[status]
            
            if current_time - last_updated >= threshold_seconds:
                actionable.append({
                    "email": row["Email"], 
                    "action": f"followup_from_{status}", 
                    "row": row
                })
                
    return actionable

# ── Standalone Test ──
if __name__ == "__main__":
    print("Testing Database...")
    add_target("test@jarurat.care", "Test User", "VIP")
    update_status("test@jarurat.care", "Sent_1")
    print(get_target("test@jarurat.care"))
    print("Actionable:", get_actionable_targets())
