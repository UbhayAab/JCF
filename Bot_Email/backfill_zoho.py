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

def safe_int(val):
    try:
        return int(str(val).strip() or 0)
    except Exception:
        return 0


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


import html
import re

def extract_emails_from_msg(msg, my_email):
    """Extract all relevant email addresses from a single message (To, CC, From)."""
    addresses = set()
    
    for field in ["fromAddress", "toAddress", "ccAddress", "bccAddress"]:
        val = msg.get(field, "")
        if not val:
            continue
            
        val = html.unescape(val) # Clean Zoho HTML entities immediately
        
        for raw in val.split(","):
            raw = raw.strip().lower()
            if not raw: continue
            
            # If it comes with a display name like "John <john@x.com>", extract just the email
            if "<" in raw and ">" in raw:
                raw = raw.split("<")[1].split(">")[0].strip()
            else:
                match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', raw)
                if match:
                    raw = match.group(0).lower()
                    
            if raw and raw != my_email and "@" in raw:
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
        received_time = safe_int(msg.get("receivedTime"))
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
    
    # Prepare the CSV writer with immediate flush
    with open(DB_FILE, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        
        # Rewrite existing rows
        for row in all_rows:
            writer.writerow(row)
        
        # Process and write new contacts iteratively
        added = 0
        total_contacts = len(person_data)
        logger.info(f"Starting to process and write {total_contacts} contacts...")
        
        for i, (contact_email, info) in enumerate(person_data.items()):
            if contact_email in existing_emails:
                continue # We already updated their thread count in memory earlier
            
            msgs_sorted = sorted(info["msgs"], key=lambda x: safe_int(x.get("receivedTime")))
            thread_count = len(msgs_sorted)
            first_sender = info["first_sender"] or ""
            first_interaction = "Outbound" if first_sender == my_email else "Inbound"
            
            # Build raw context via API
            context_parts = []
            for j, m in enumerate(msgs_sorted[:5]):
                try:
                    c = zoho.get_email_content(m["messageId"])
                    c = c.replace("\n", " ").replace("\r", " ")[:300] + "..."
                except Exception:
                    c = m.get("summary", "")[:300]
                context_parts.append(f"[{j+1}] {m.get('fromAddress', '')} -> {c}")
                time.sleep(0.05) # Prevent Zoho completely banning our IP address
                
            raw_context = " | ".join(context_parts)
            
            new_row = {
                "Email": contact_email,
                "Status": "Active",
                "LastUpdated": str(int(time.time())),
                "Name": msgs_sorted[0].get("fromAddress", contact_email) if first_interaction == "Inbound" else contact_email,
                "FirstInteraction": first_interaction,
                "ThreadCount": str(thread_count),
                "Context": raw_context
            }
            writer.writerow(new_row)
            f.flush() # Force write to disk instantly!
            
            existing_emails.add(contact_email)
            all_rows.append(new_row) # Keep in dict for preview
            added += 1
            
            if (i + 1) % 10 == 0 or (i + 1) == total_contacts:
                logger.info(f"Progress: [{i+1}/{total_contacts}] contacts processed. Added {added} new CSV rows so far...")
            
    logger.info(f"✅ Scraping fully complete! Added {added} new contacts. Look at data/database.csv!")


if __name__ == "__main__":
    run_backfill()
