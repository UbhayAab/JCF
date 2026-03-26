"""
PDF Scraper - Extract doctor emails from PDF documents
Supports both file-path and in-memory (bytes) extraction
"""

import pdfplumber
import os
import io
import tempfile

from .emailUtils import extract_emails, extract_phones, extract_name_from_email
from .filterUtils import extract_names, filter_doctor_emails


def extract_text_from_pdf(path):
    """Extract text content from PDF file"""
    if not os.path.exists(path):
        print(f"Error: PDF file not found at {path}")
        return ""

    text = ""
    try:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
    except Exception as e:
        print(f"Error reading PDF: {e}")

    return text


def extract_text_from_pdf_bytes(pdf_bytes):
    """Extract text content from PDF bytes (in-memory)"""
    text = ""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
    except Exception as e:
        print(f"  Error reading PDF from bytes: {e}")

    return text


def scrape_pdf_raw(text):
    """
    Extract raw contacts from PDF text.
    Returns (emails_list, names_list, phones_list, full_text)
    Used by scrapers for inline PDF processing.
    """
    if not text:
        return [], [], [], ""

    emails = extract_emails(text)
    phones = extract_phones(text)
    names = extract_names(text)

    return emails, names, phones, text


def scrape_pdf(pdf_path):
    """Extract doctor emails from PDF (standalone mode)"""
    if not os.path.exists(pdf_path):
        print(f"PDF not found: {pdf_path}")
        return []

    print(f"Extracting from PDF: {pdf_path}")
    text = extract_text_from_pdf(pdf_path)

    if not text:
        print("No content extracted from PDF.")
        return []

    # Extract contacts
    emails = extract_emails(text)
    phones = extract_phones(text)
    names = extract_names(text)

    results = []
    seen_emails = set()

    for email in emails:
        if email.lower() in seen_emails:
            continue
        seen_emails.add(email.lower())

        name = ""
        # Try to find name in context around the email
        email_context = _get_email_context(text, email)
        if email_context:
            context_names = extract_names(email_context)
            if context_names:
                name = context_names[0]

        # Fallback: extract name from email address itself
        if not name:
            name = extract_name_from_email(email)

        phone = phones[0] if phones else ""

        # Use advanced scoring
        from .filterUtils import calculate_advanced_score
        score = calculate_advanced_score(
            email=email,
            nearby_name=name,
            context=email_context or text[:1000],
            all_site_names=names,
        )

        results.append({
            "email": email,
            "name": name,
            "phone": phone,
            "score": score,
        })

    # Sort by score
    results.sort(key=lambda x: x['score'], reverse=True)
    return results


def _get_email_context(text, email):
    """Get surrounding context for an email address"""
    try:
        email_pos = text.find(email)
        if email_pos == -1:
            return ""
        start = max(0, email_pos - 300)
        end = min(len(text), email_pos + len(email) + 300)
        return text[start:end]
    except:
        return ""