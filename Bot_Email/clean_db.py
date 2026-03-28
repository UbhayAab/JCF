import csv
import html
import re

DB_FILE = "data/database.csv"
FIELDNAMES = ["Email", "Status", "LastUpdated", "Name", "FirstInteraction", "ThreadCount", "Context"]
MY_EMAIL = "partnership@jarurat.care"

def extract_clean_email(raw_val):
    """Extract just the pure email address from a string like 'Name <email@domain.com>'"""
    val = html.unescape(raw_val).strip()
    if "<" in val and ">" in val:
        return val.split("<")[1].split(">")[0].strip().lower()
    
    # Fallback regex if it's just floating in the string
    match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', val)
    if match:
        return match.group(0).lower()
    return val.lower()


def clean_database():
    print("Reading current database...")
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
    except FileNotFoundError:
        print("Database not found!")
        return

    cleaned_rows = {}
    
    for row in rows:
        raw_email = row["Email"]
        clean_email = extract_clean_email(raw_email)
        
        # Skip garbage or our own email (which slipped in due to HTML encoding!)
        if not clean_email or clean_email == MY_EMAIL:
            continue
            
        clean_name = html.unescape(row["Name"])
        # If name is still an email format with < >, clean it
        if "<" in clean_name and ">" in clean_name:
            clean_name = clean_name.split("<")[0].replace('"', '').strip()
            if not clean_name:
                clean_name = clean_email
                
        clean_context = html.unescape(row["Context"])
        
        # We need to deduplicate in case cleaning the emails creates duplicates!
        # E.g., maybe "john@x.com" and "&lt;john@x.com&gt;" were separate rows
        if clean_email in cleaned_rows:
            # Keep the one with higher thread count
            existing = cleaned_rows[clean_email]
            if int(row["ThreadCount"]) > int(existing["ThreadCount"]):
                cleaned_rows[clean_email] = {
                    "Email": clean_email,
                    "Status": row["Status"],
                    "LastUpdated": row["LastUpdated"],
                    "Name": clean_name,
                    "FirstInteraction": row["FirstInteraction"],
                    "ThreadCount": row["ThreadCount"],
                    "Context": clean_context
                }
        else:
            cleaned_rows[clean_email] = {
                "Email": clean_email,
                "Status": row["Status"],
                "LastUpdated": row["LastUpdated"],
                "Name": clean_name,
                "FirstInteraction": row["FirstInteraction"],
                "ThreadCount": row["ThreadCount"],
                "Context": clean_context
            }

    final_list = list(cleaned_rows.values())
    
    print(f"Cleaned {len(rows)} down to {len(final_list)} unique valid contacts.")
    
    with open(DB_FILE, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(final_list)
        
    print("Database overwritten with clean, formatted data!")


if __name__ == "__main__":
    clean_database()
