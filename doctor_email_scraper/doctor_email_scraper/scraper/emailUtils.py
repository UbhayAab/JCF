"""
Email and phone extraction utilities
Handles normal and obfuscated formats
"""

import re


def normalize_hidden_emails(text):
    """Convert hidden email formats to standard format"""
    # Handle [at] and (at)
    text = re.sub(r'\s*\[\s*at\s*\]\s*|\s*\(\s*at\s*\)\s*', '@', text, flags=re.IGNORECASE)
    # Handle [dot], (dot)
    text = re.sub(r'\s*\[\s*dot\s*\]\s*|\s*\(\s*dot\s*\)\s*', '.', text, flags=re.IGNORECASE)
    # Handle space-separated formats
    text = re.sub(r'\s+at\s+', '@', text, flags=re.IGNORECASE)
    text = re.sub(r'([a-zA-Z0-9])\s+dot\s+', r'\1.', text, flags=re.IGNORECASE)

    return text


def extract_emails(text):
    """
    Extract email addresses from text
    Handles normal and hidden formats like [at] and [dot]
    """
    # First normalize hidden formats
    normalized_text = normalize_hidden_emails(text)

    # Standard email regex - improved to avoid system-generated emails
    emails = re.findall(r"[a-zA-Z0-9][a-zA-Z0-9\._\-]*@[a-zA-Z0-9\._\-]+\.[a-zA-Z]{2,}", normalized_text)

    # Remove duplicates and filter - ADD VALIDATION
    unique_emails = []
    seen = set()
    for email in emails:
        if email.count('@') == 1 and email.count('.') >= 1:
            email_lower = email.lower()

            # SKIP only truly malformed emails
            if any(char in email for char in ['<', '>', '{', '}', '[', ']', '|', '\\', '^']):
                continue
            if len(email) > 100:  # Too long, probably garbage
                continue

            if email_lower not in seen:
                unique_emails.append(email)
                seen.add(email_lower)

    return unique_emails


def extract_phones(text):
    """
    Extract phone numbers with various formats
    """
    patterns = [
        r'(?:\+\d{1,3})?\s*(?:\(?\d{3}\)?)[\s.-]?\d{3}[\s.-]?\d{4}',
        r'\+\d{1,3}\s?\d{1,14}',
    ]

    phones = []
    for pattern in patterns:
        phones.extend(re.findall(pattern, text))

    unique_phones = []
    seen = set()

    for phone in phones:
        cleaned = re.sub(r'[^\d\+\-\(\)\s\.]', '', phone).strip()
        digits_only = re.sub(r'\D', '', cleaned)
        if len(digits_only) >= 10 and cleaned not in seen:
            unique_phones.append(cleaned)
            seen.add(cleaned)

    return list(dict.fromkeys(unique_phones))


def extract_name_from_email(email):
    """
    Extract doctor name from email address
    Example: drmanishshrigiriwar@aiimsnagpur.edu.in -> Manish Shrigiriwar
    """
    if not email or "@" not in email:
        return ""

    # Get the part before @
    local_part = email.split("@")[0]

    # Remove common prefixes like 'dr', 'doc', 'dr.', 'doc.'
    name_part = re.sub(r"^(dr\.?|doc\.?)", "", local_part, flags=re.IGNORECASE)

    # Remove numbers and underscores, replace dots and dashes with spaces
    name_part = re.sub(r"[0-9_]", "", name_part)
    name_part = re.sub(r"[\.\-]", " ", name_part)

    # Handle camelCase: insert space before uppercase
    name_part = re.sub(r"([a-z])([A-Z])", r"\1 \2", name_part)
    name_part = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", name_part)

    # Clean up spaces
    name_part = " ".join(name_part.split())

    # Capitalize properly
    name_part = " ".join(word.capitalize() for word in name_part.split())

    return name_part.strip()