"""
CSV saving utilities — includes URL source column
"""

import csv
import os


def save_to_csv(data, filename="output.csv"):
    """Save scraped data to CSV file"""
    if not data:
        print("No data to save.")
        return False

    # Check for duplicates in existing file
    existing_emails = set()
    file_exists = os.path.exists(filename)

    if file_exists:
        try:
            with open(filename, "r", encoding="utf-8") as f:
                reader = csv.reader(f)
                next(reader, None)  # Skip header
                for row in reader:
                    if row and len(row) >= 1:
                        existing_emails.add(row[0].lower())
        except:
            pass

    # Filter unique records
    unique_data = []
    for row in data:
        email = row.get("email", "").lower()
        if email and email not in existing_emails:
            unique_data.append(row)
            existing_emails.add(email)

    if not unique_data:
        print("No new unique records to save.")
        return False

    # Write to CSV
    with open(filename, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)

        # Write header if new file
        if not file_exists:
            writer.writerow(["email", "name", "phone", "score", "source_url"])

        for row in unique_data:
            writer.writerow([
                row.get("email", ""),
                row.get("name", ""),
                row.get("phone", ""),
                row.get("score", ""),
                row.get("url", ""),
            ])

    print(f"Saved {len(unique_data)} unique records to {filename}")
    return True