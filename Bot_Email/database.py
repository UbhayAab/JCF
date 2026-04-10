"""
Central Brain (CRM) for Jarurat Care Outreach (v5.0)

Drip strategy:
  Pending → Sent_1 (24h) → Sent_2 (48h) → Sent_3 (4 days) → Sent_4,5,6... (every 5 days until reply)

Terminal statuses (never dripped again):
  Replied, Unsubscribed, Spam, Meeting_Pending, Bounced

On reply/meeting: removed from drip automatically.
"""

import os
import csv
import time
import logging

logger = logging.getLogger("database")

DB_FILE    = "data/database.csv"
FIELDNAMES = ["Email", "Status", "LastUpdated", "Name", "Context", "FirstInteraction", "ThreadCount"]

# ── Time thresholds (seconds before next follow-up) ────────────────────────
THRESHOLDS = {
    "Sent_1":       24 * 3600,      # 1 day after initial
    "Sent_2":       48 * 3600,      # 2 days after first follow-up
    "Sent_3":       4 * 24 * 3600,  # 4 days after second follow-up
    "Sent_DEFAULT": 5 * 24 * 3600,  # 5 days for ALL subsequent (Sent_4, Sent_5, ...)
}

EVENT_DATE   = "2026-05-23"
EXTERNAL_CSV = "output.csv"

# Statuses that STOP drip forever
TERMINAL_STATUSES = {"Replied", "Unsubscribed", "Spam", "Meeting_Pending", "Bounced", "Exhausted_Manual"}


def ensure_db():
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    if not os.path.exists(DB_FILE):
        with open(DB_FILE, mode='w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()


def load_db():
    ensure_db()
    with open(DB_FILE, mode='r', newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def save_db(rows):
    ensure_db()
    with open(DB_FILE, mode='w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def add_target(email, name="", context="", status="Pending", first_interaction="Unknown", thread_count=1):
    rows = load_db()
    email_clean = email.strip().lower()
    for row in rows:
        if row["Email"].strip().lower() == email_clean:
            return False
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
    rows = load_db()
    email_clean = email.strip().lower()
    for row in rows:
        if row["Email"].strip().lower() == email_clean:
            return row
    return None


def update_status(email, new_status):
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
    else:
        # Auto-add if not in DB (e.g. someone emailed us who wasn't in the scrape list)
        add_target(email_clean, status=new_status)
        updated = True
    return updated


# ═══════════════════════════════════════════════════════════════════════════════
# DRIP ENGINE: get_actionable_targets
# Now supports INFINITE drip (Sent_4, Sent_5, ...) every 5 days until reply
# ═══════════════════════════════════════════════════════════════════════════════

def get_actionable_targets():
    """
    Returns targets needing email NOW.
    - Pending → needs initial email
    - Sent_N → needs follow-up if threshold has passed
    - NO cap on N — drip continues every 5 days until reply or event date
    - Terminal statuses are never returned
    """
    from datetime import datetime

    today_str = datetime.now().strftime("%Y-%m-%d")
    if today_str > EVENT_DATE:
        logger.info(f"⌛ Event date {EVENT_DATE} has passed. Drip halted.")
        return []

    rows = load_db()
    actionable = []
    current_time = int(time.time())

    for row in rows:
        status = row.get("Status", "Unknown")
        email  = row.get("Email", "")
        if not email:
            continue

        # Skip terminal statuses
        if status in TERMINAL_STATUSES:
            continue

        # Fresh targets
        if status == "Pending":
            actionable.append({"email": email, "action": "send_initial", "row": row})
            continue

        # Follow-up: Sent_1, Sent_2, Sent_3, Sent_4, Sent_5, ... (NO CAP)
        if status.startswith("Sent_"):
            try:
                sent_num = int(status.split("_")[1])
            except (ValueError, IndexError):
                continue

            last_updated = int(row.get("LastUpdated", "0"))
            threshold = THRESHOLDS.get(status, THRESHOLDS["Sent_DEFAULT"])

            if current_time - last_updated >= threshold:
                actionable.append({
                    "email": email,
                    "action": f"followup_from_{status}",
                    "row": row
                })

    return actionable


# ═══════════════════════════════════════════════════════════════════════════════
# RESET: Reset all drip statuses to Pending
# ═══════════════════════════════════════════════════════════════════════════════

def reset_all_drip_statuses():
    """
    Reset ALL Sent_* and Active statuses back to Pending.
    Preserves terminal statuses (Replied, Unsubscribed, Spam).
    Returns count of reset rows.
    """
    rows = load_db()
    reset_count = 0
    now_ts = str(int(time.time()))

    for row in rows:
        status = row.get("Status", "")
        if status.startswith("Sent_") or status in ("Active", "Exhausted", "Unknown", "Ignored"):
            row["Status"] = "Pending"
            row["LastUpdated"] = now_ts
            reset_count += 1

    save_db(rows)
    logger.info(f"🔄 Reset {reset_count} rows back to Pending")
    return reset_count


# ═══════════════════════════════════════════════════════════════════════════════
# SYNC: Import from output.csv
# ═══════════════════════════════════════════════════════════════════════════════

def sync_external_csv():
    if not os.path.exists(EXTERNAL_CSV):
        return 0, "External CSV not found."

    added_count = 0
    skipped_count = 0
    rows = load_db()
    existing_emails = {r["Email"].strip().lower() for r in rows}

    try:
        with open(EXTERNAL_CSV, mode='r', newline='', encoding='utf-8') as f:
            first_line = f.readline()
            f.seek(0)
            has_header = "email" in first_line.lower()

            if has_header:
                reader = csv.DictReader(f)
                new_data = list(reader)
            else:
                reader = csv.reader(f)
                new_data = [{"Email": row[0], "Name": row[1] if len(row) > 1 else "", "Link": row[2] if len(row) > 2 else ""} for row in reader if len(row) > 0]

            for entry in new_data:
                email = (entry.get("Email ID") or entry.get("Email") or "").strip().lower()
                if not email or "@" not in email:
                    continue

                if email not in existing_emails:
                    name    = (entry.get("Name of the doctor") or entry.get("Name") or "").strip()
                    website = (entry.get("Website link") or entry.get("Link") or "").strip()

                    rows.append({
                        "Email": email,
                        "Status": "Pending",
                        "LastUpdated": str(int(time.time())),
                        "Name": name,
                        "Context": f"Source: {website}",
                        "FirstInteraction": "External_CSV",
                        "ThreadCount": "1"
                    })
                    existing_emails.add(email)
                    added_count += 1
                else:
                    skipped_count += 1

        save_db(rows)
        return added_count, f"Synced! Added {added_count} leads. Skipped {skipped_count} duplicates."
    except Exception as e:
        return 0, f"Sync Error: {str(e)}"


def reset_spam_status(email):
    return update_status(email, "Pending")


def get_stats() -> dict:
    """Return a status breakdown dict."""
    rows = load_db()
    stats = {}
    for r in rows:
        s = r.get("Status", "Unknown")
        stats[s] = stats.get(s, 0) + 1
    return stats


# ── Standalone Test ──
if __name__ == "__main__":
    ensure_db()
    stats = get_stats()
    total = sum(stats.values())
    print(f"Database: {total} total rows")
    for s, c in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {s}: {c}")
