"""
Filtering and scoring utilities for doctor email detection
Two-pass cross-referencing scoring with oncology priority
"""

import re

# ─── Medical & Oncology keyword lists ─────────────────────────
MEDICAL_TITLES = [
    'dr', 'dr.', 'doctor', 'md', 'mbbs', 'phd', 'prof', 'professor',
    'do', 'dds', 'dmd', 'rn', 'surgeon', 'physician',
    'ms', 'mch', 'dm', 'dnb', 'frcs', 'mrcp',
]

ONCO_KEYWORDS = [
    'onco', 'oncolog', 'oncology', 'oncologist',
    'cancer', 'tumor', 'tumour', 'carcinoma', 'sarcoma', 'lymphoma', 'leukemia',
    'chemo', 'chemotherapy', 'radiation', 'radiotherapy', 'immunotherapy',
    'hematolog', 'haematolog', 'neoplasm', 'malignant', 'metasta',
    'biopsy', 'palliative', 'remission',
]

MEDICAL_KEYWORDS = [
    'hospital', 'clinic', 'medical', 'medicine', 'healthcare', 'health care',
    'patient', 'treatment', 'surgery', 'surgical', 'cardiology', 'neurology',
    'gastroenterology', 'pathology', 'radiology', 'pediatric', 'dermatology',
    'orthopedic', 'urology', 'nephrology', 'pulmonology', 'endocrinology',
    'psychiatry', 'anesthesiology', 'ophthalmology', 'ent', 'gynecology',
    'obstetrics', 'research', 'clinical', 'pharma', 'biomedical',
]


def extract_names(text):
    """
    Extract potential doctor/researcher names from text
    """
    names = []

    # Medical titles followed by names
    medical_title_patterns = [
        r'\bdr\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})',
        r'\bprof\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})',
        r'\bprofessor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})',
        r'\bdoctor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})',
    ]

    for pattern in medical_title_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            clean_name = match.strip()
            if 3 <= len(clean_name) <= 50 and not any(char.isdigit() for char in clean_name):
                names.append(clean_name)

    # "Name - Title" patterns
    name_title_pattern = r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s*[-–]\s*(?:MD|PhD|DO|DDS|RN|Physician|Doctor|Professor|Oncologist|Surgeon)'
    matches = re.findall(name_title_pattern, text)
    for match in matches:
        clean_name = match.strip()
        if clean_name not in names and 3 <= len(clean_name) <= 50:
            names.append(clean_name)

    # Generic "Firstname Lastname" — two capitalized words together (less reliable)
    generic_name_pattern = r'\b([A-Z][a-z]{2,15}\s+[A-Z][a-z]{2,20})\b'
    generic_matches = re.findall(generic_name_pattern, text)
    for match in generic_matches:
        clean_name = match.strip()
        if clean_name not in names and _is_likely_name(clean_name):
            names.append(clean_name)

    # Remove duplicates and filter garbage
    unique_names = []
    garbage_keywords = [
        'skip', 'content', 'navigation', 'menu', 'footer', 'header', 'sidebar',
        'medical center', 'click here', 'read more', 'learn more', 'sign up',
        'log in', 'search', 'submit', 'download', 'upload', 'subscribe',
    ]

    for name in names:
        name_lower = name.lower()
        if any(keyword in name_lower for keyword in garbage_keywords):
            continue
        if len(name) < 3 or len(name) > 50:
            continue
        if any(char.isdigit() for char in name):
            continue
        unique_names.append(name)

    return list(dict.fromkeys(unique_names))  # Dedupe preserving order


def _is_likely_name(text):
    """Quick check if text looks like a person name"""
    words = text.split()
    if len(words) < 2 or len(words) > 5:
        return False
    garbage = [
        'hospital', 'office', 'center', 'department', 'university',
        'college', 'clinic', 'program', 'institute', 'click', 'read',
        'skip', 'menu', 'page', 'home', 'news', 'about', 'contact',
        'view', 'more', 'all', 'our', 'the', 'and',
    ]
    if any(w.lower() in garbage for w in words):
        return False
    return True


def is_doctor(text):
    """Check if text contains medical-related keywords"""
    text_lower = text.lower()
    return any(k in text_lower for k in MEDICAL_KEYWORDS + ONCO_KEYWORDS)


def name_matches_email(email, name):
    """
    Check if a name loosely matches an email local part.
    e.g. 'Manish Shrigiriwar' matches 'drmanishshrigiriwar@hospital.com'
    Returns True if match found.
    """
    if not email or not name or '@' not in email:
        return False

    local = email.split('@')[0].lower()
    # Remove common prefixes
    local = re.sub(r'^(dr\.?|doc\.?|prof\.?)', '', local)
    # Remove numbers
    local = re.sub(r'[0-9]', '', local)

    name_parts = name.lower().split()
    if not name_parts:
        return False

    # Check if all name parts appear in the email local part
    matches = sum(1 for part in name_parts if part in local)
    # At least the first OR last name should match
    if matches >= 1 and len(name_parts[0]) >= 3:
        return True

    return False


def has_medical_title(text):
    """Check if text contains medical titles"""
    text_lower = text.lower()
    for title in MEDICAL_TITLES:
        # Check as a word boundary match
        if re.search(r'\b' + re.escape(title) + r'\b', text_lower):
            return True
    return False


def has_onco_keywords(text):
    """Check if text contains oncology-related keywords"""
    text_lower = text.lower()
    return any(kw in text_lower for kw in ONCO_KEYWORDS)


def has_medical_keywords(text):
    """Check if text contains general medical keywords"""
    text_lower = text.lower()
    return any(kw in text_lower for kw in MEDICAL_KEYWORDS)


def calculate_advanced_score(email, nearby_name="", context="", all_site_names=None):
    """
    Advanced confidence scoring with cross-referencing.
    
    Score interpretation:
      80+   Very high confidence (likely a doctor/researcher)
      60-79 High confidence
      40-59 Medium confidence
      20-39 Low confidence
      <20   Very low confidence (generic/system email)
    """
    score = 20  # Base score for any valid email

    if not email or '@' not in email:
        return 0

    local, domain = email.split('@', 1)
    email_lower = email.lower()
    domain_lower = domain.lower()

    # ── Domain bonus ──
    if domain_lower.endswith(('.edu', '.edu.in', '.ac.uk', '.ac.in', '.gov', '.gov.in', '.org')):
        score += 15

    # ── Nearby name bonus ──
    if nearby_name and len(nearby_name.strip()) > 1 and nearby_name.lower() != 'unknown':
        score += 20  # A real name was found near this email

        # Medical title on the nearby name
        if has_medical_title(nearby_name):
            score += 20

        # Oncology in the nearby name
        if has_onco_keywords(nearby_name):
            score += 15

    # ── Context analysis (text around the email) ──
    if context:
        if has_onco_keywords(context):
            score += 15
        elif has_medical_keywords(context):
            score += 5

    # ── Cross-reference: does email local part match any name found on the site? ──
    if all_site_names:
        for site_name in all_site_names:
            if name_matches_email(email, site_name):
                score += 10
                # Extra if that cross-referenced name has medical title context
                if has_medical_title(site_name):
                    score += 5
                break  # Only count once

    # ── Email local part hints ──
    if re.match(r'^dr\.?', local, re.IGNORECASE):
        score += 10  # Email starts with "dr"

    # ── Penalties ──
    generic_prefixes = [
        'info', 'hello', 'contact', 'enquiry', 'mail', 'web', 'general',
        'admin', 'support', 'noreply', 'no-reply', 'marketing', 'sales',
        'hr', 'careers', 'jobs', 'billing', 'accounts', 'feedback',
    ]
    if any(email_lower.startswith(prefix + '@') for prefix in generic_prefixes):
        score -= 15

    system_patterns = [
        'system', 'webcontrols', 'template', 'framework', 'repeater',
        'verification', 'bounce', 'daemon', 'postmaster',
    ]
    if any(p in email_lower for p in system_patterns):
        score -= 20

    return max(score, 0)


# Backward-compatible wrapper
def calculate_score(email, context="", name=""):
    """Legacy wrapper — calls advanced scoring without cross-referencing"""
    return calculate_advanced_score(email, nearby_name=name, context=context, all_site_names=None)


def score_all_contacts(raw_contacts, all_site_names):
    """
    Two-pass scoring: take all raw contacts collected from the site
    and score them using cross-referencing with all discovered names.
    
    raw_contacts: list of dicts with keys: email, nearby_name, context, url, phone
    all_site_names: list of all names discovered across the site
    
    Returns: list of dicts with keys: email, name, phone, score, url
    """
    results = []
    seen = set()

    for contact in raw_contacts:
        email = contact['email']
        if email.lower() in seen:
            continue
        seen.add(email.lower())

        score = calculate_advanced_score(
            email=email,
            nearby_name=contact.get('nearby_name', ''),
            context=contact.get('context', ''),
            all_site_names=all_site_names,
        )

        # Use nearby_name if available, else fallback
        name = contact.get('nearby_name', '') or contact.get('fallback_name', '')

        results.append({
            'email': email,
            'name': name,
            'phone': contact.get('phone', ''),
            'score': score,
            'url': contact.get('url', ''),
        })

    # Sort by score descending
    results.sort(key=lambda x: x['score'], reverse=True)
    return results


def filter_doctor_emails(emails, context="", names=None, min_score=0):
    """
    Filter emails — kept for backward compatibility (PDF scraper).
    Now uses advanced scoring.
    """
    filtered = []

    name_map = {}
    if names:
        for i, email in enumerate(emails):
            if i < len(names):
                name_map[email] = names[i]

    for email in emails:
        associated_name = name_map.get(email, "")
        score = calculate_advanced_score(email, nearby_name=associated_name, context=context)
        if score >= min_score:
            filtered.append((email, score))

    return filtered