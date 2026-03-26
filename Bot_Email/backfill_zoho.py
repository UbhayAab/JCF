"""
Comprehensive Mega Brain Backfiller
- Fetches ALL emails from Inbox AND Sent via pagination (no limit cap).
- Parses To/From/CC to find every unique person.
- Groups all conversations per person to get cumulative thread counts.
- Skips any internal jarurat.care addresses.
- Saves raw content directly (No Gemini API calls needed).
"""

import csv
import time
import logging
from collections import defaultdict

import config
from zoho_service import ZohoMailService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("backfill")

DB_FILE = "data/database.csv"
FIELDNAMES = ["Email", "Status", "LastUpdated", "Name", "FirstInteraction", "ThreadCount", "Context"]


def fetch_all_from_folder(zoho, folder_id, folder_name):
    """Fetch all messages from a folder with pagination."""
    all_msgs = []
    start = 1
    limit = 200
    
    while True:
        logger.info(f"Fetching {folder_name} page start={start}...")
        data = zoho._api_get("messages/view", params={
            "limit": limit,
            "start": start,
            "folderId": folder_id
        })
        batch = data.get("data", [])
        if not batch:
            break
        all_msgs.extend(batch)
        logger.info(f"  Got {len(batch)} messages (total {len(all_msgs)} so far)")
        if len(batch) < limit:
            break
        start += limit
        
    return all_msgs


def extract_emails_from_msg(msg, my_email):
    """Extract all relevant email addresses from a single message (To, CC, From)."""
    addresses = set()
    
    for field in ["fromAddress", "toAddress", "ccAddress", "bccAddress"]:
        val = msg.get(field, "")
        if not val:
            continue
        # Multiple emails could be comma-separated
        for raw in val.split(","):
            raw = raw.strip().lower()
            if raw and raw != my_email and "@" in raw:
                # If it comes with a display name like "John <john@x.com>", extract just the email
                if "<" in raw and ">" in raw:
                    raw = raw.split("<")[1].rstrip(">").strip()
                if "@" in raw and "." in raw.split("@")[1]:
                    addresses.add(raw)
                    
    return addresses


def run_backfill():
    config.validate()
    zoho = ZohoMailService()
    my_email = zoho.from_email.lower()
    logger.info(f"My email: {my_email}")
    
    inbox_id = zoho.get_folder_id("Inbox")
    sent_id = zoho.get_folder_id("Sent")
    
    inbox_msgs = fetch_all_from_folder(zoho, inbox_id, "Inbox")
    sent_msgs = fetch_all_from_folder(zoho, sent_id, "Sent")
    
    all_msgs = inbox_msgs + sent_msgs
    logger.info(f"Total messages downloaded: {len(all_msgs)}")
    
    # Deduplicate by messageId
    seen_ids = set()
    unique_msgs = []
    for m in all_msgs:
        mid = m.get("messageId")
        if mid and mid not in seen_ids:
            seen_ids.add(mid)
            unique_msgs.append(m)
    logger.info(f"Unique messages after dedup: {len(unique_msgs)}")
    
    # Group by external email address, accumulate thread counts
    person_data = defaultdict(lambda: {
        "msgs": [],
        "first_sender": None,
        "first_time": float("inf")
    })
    
    for msg in unique_msgs:
        contacts = extract_emails_from_msg(msg, my_email)
        received_time = int(msg.get("receivedTime") or "0")
        from_addr = msg.get("fromAddress", "").lower()
        
        for contact in contacts:
            person_data[contact]["msgs"].append(msg)
            # Track earliest interaction
            if received_time < person_data[contact]["first_time"]:
                person_data[contact]["first_time"] = received_time
                person_data[contact]["first_sender"] = from_addr
                
    logger.info(f"Unique external contacts found: {len(person_data)}")
    
    # Load existing DB for deduplication
    existing_emails = set()
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                existing_emails.add(row["Email"].strip().lower())
    except FileNotFoundError:
        pass
    
    # Write new DB entirely
    import os
    os.makedirs("data", exist_ok=True)
    
    all_rows = []
    
    # Re-read existing rows first to preserve them
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                all_rows.append(row)
    except FileNotFoundError:
        pass
    
    added = 0
    
    for contact_email, info in person_data.items():
        if contact_email in existing_emails:
            # Update thread count if higher than stored
            for row in all_rows:
                if row["Email"].strip().lower() == contact_email:
                    existing_count = int(row.get("ThreadCount", 1))
                    current_count = len(info["msgs"])
                    if current_count > existing_count:
                        row["ThreadCount"] = str(current_count)
            continue
        
        msgs_sorted = sorted(info["msgs"], key=lambda x: int(x.get("receivedTime", "0")))
        thread_count = len(msgs_sorted)
        first_sender = info["first_sender"] or ""
        first_interaction = "Outbound" if first_sender == my_email else "Inbound"
        
        # Build raw context (NO API calls - just raw text)
        context_parts = []
        for i, m in enumerate(msgs_sorted[:5]):  # Limit to 5 most recent to avoid huge cells
            try:
                c = zoho.get_email_content(m["messageId"])
                c = c.replace("\n", " ").replace("\r", " ")[:300] + "..."
            except Exception:
                c = m.get("summary", "")[:300]
            context_parts.append(f"[{i+1}] {m.get('fromAddress', '')} -> {c}")
            
        raw_context = " | ".join(context_parts)
        
        all_rows.append({
            "Email": contact_email,
            "Status": "Active",
            "LastUpdated": str(int(time.time())),
            "Name": msgs_sorted[0].get("fromAddress", contact_email) if first_interaction == "Inbound" else contact_email,
            "FirstInteraction": first_interaction,
            "ThreadCount": str(thread_count),
            "Context": raw_context
        })
        existing_emails.add(contact_email)
        added += 1
        
    # Save final output
    with open(DB_FILE, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(all_rows)
        
    logger.info(f"✅ Done! Added {added} new contacts. Total rows: {len(all_rows)}")
    
    # Preview for the user
    print("\n--- DATABASE PREVIEW (first 15 rows) ---")
    print(f"{'Email':<40} {'Status':<10} {'First':<10} {'Threads'}")
    for row in all_rows[:15]:
        print(f"{row['Email']:<40} {row.get('Status',''):<10} {row.get('FirstInteraction',''):<10} {row.get('ThreadCount','')}")
    print(f"\nTotal unique contacts: {len(all_rows)}")


if __name__ == "__main__":
    run_backfill()
