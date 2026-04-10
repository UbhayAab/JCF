"""
Local AI Pipeline (v4.0 — Gemma 4 Powered, Council-Reviewed, Name-Safe)

5-Stage pipeline plus:
- Google Gemma 4 (27B MoE) via Ollama for all AI stages
- Bulletproof name cleaning (strips "Assistant Professor", "Associate Professor", etc.)
- Council review: critic runs 2 passes, post-processor does 3 more format checks
- When name is truly unknown → "Hello" (NEVER "Dear Dr. Assistant Professor")
- Signature is ALWAYS injected from config, NEVER from LLM output
"""

import requests
import json
import logging
import re
import os
import time
import config

logger = logging.getLogger("local_ai")

OLLAMA_URL  = "http://localhost:11434/api/generate"
FAST_MODEL  = config.OLLAMA_TRIAGE_MODEL   # gemma4 (triage/critic)
SMART_MODEL = config.OLLAMA_DRAFT_MODEL    # gemma4 (strategist/copywriter)


# ─────────────────────────────────────────────────────────────────────────────
# NAME CLEANING (deterministic, no LLM)
# ─────────────────────────────────────────────────────────────────────────────

def clean_name(raw: str, email_addr: str = "") -> str:
    """
    Deterministically clean any raw name string.
    Returns a proper first/last name or empty string if garbage.
    
    RULES:
    - Strip all academic titles (Assistant Professor, Associate Professor, etc.)
    - Strip all prefixes (Dr., Prof., Mr., Ms.)
    - Strip all suffixes (MD, MBBS, DM, PhD, etc.)
    - If result is < 2 chars or still looks like garbage → return ""
    """
    if not raw:
        raw = ""
    raw = str(raw).strip()
    
    # If it's an email address, extract the prefix part
    if "@" in raw:
        raw = raw.split("@")[0]
    
    # Remove angle bracket format: "Name <email>"
    if "<" in raw:
        raw = raw.split("<")[0].strip()
    
    # Remove quotes
    raw = raw.strip('"').strip("'").strip()
    
    # Remove all title garbage (case insensitive)
    text = raw
    for title in config.TITLE_GARBAGE:
        text = re.sub(r'\b' + re.escape(title) + r'\b', ' ', text, flags=re.IGNORECASE)
    
    # Remove prefixes
    text = re.sub(r'^(Dr\.?|Prof\.?|Mr\.?|Ms\.?|Mrs\.?|Shri\.?|Smt\.?)\s*', '', text, flags=re.IGNORECASE)
    
    # Remove suffixes (medical degrees, etc.)
    text = re.sub(r',?\s*(MD|MBBS|DM|DNB|MCh|MS|PhD|FRCS|FRCP|MRCP|FACP|FACS|MDS|BDS|DO|MPH|FRCPath)\b.*$', '', text, flags=re.IGNORECASE)
    
    # Remove numbers
    text = re.sub(r'\d+', '', text)
    
    # Clean up separators
    text = text.replace('.', ' ').replace('_', ' ').replace('-', ' ')
    text = re.sub(r'\s+', ' ', text).strip()
    
    # Title case
    text = text.title()
    
    # Final validation
    if len(text) < 2:
        return ""
    
    # Check if what's left is still a title/garbage word
    lower_text = text.lower().strip()
    garbage_words = {"doctor", "dr", "prof", "professor", "email", "user", "admin", "info", "contact", "test", "noreply"}
    if lower_text in garbage_words:
        return ""
    
    # If it's a single word that could still be a title part
    if len(text.split()) == 1 and lower_text in {"assistant", "associate", "senior", "junior", "clinical", "chief", "head"}:
        return ""
    
    return text


def build_greeting(name: str) -> str:
    """Build the email greeting line. Uses Hello when name is unknown."""
    cleaned = clean_name(name)
    if not cleaned:
        return "Hello,"
    return f"Dear Dr. {cleaned},"


def extract_name_from_email(email_addr: str) -> str:
    """Extract name from email address (deterministic, no LLM)."""
    if not email_addr or "@" not in email_addr:
        return ""
    
    prefix = email_addr.split("@")[0].lower()
    
    # Remove common prefix patterns
    prefix = re.sub(r'^(dr|prof|doctor|associate|assistant|physician|faculty|resident|hod|contact|info|admin|office)', '', prefix, flags=re.IGNORECASE)
    
    # Clean separators and numbers
    prefix = re.sub(r'\d+', '', prefix)
    prefix = prefix.replace('.', ' ').replace('_', ' ').replace('-', ' ')
    prefix = re.sub(r'\s+', ' ', prefix).strip()
    
    if len(prefix) < 2:
        return ""
    
    return prefix.title()


# ─────────────────────────────────────────────────────────────────────────────
# Low-level Ollama caller
# ─────────────────────────────────────────────────────────────────────────────

def _call_ollama(prompt: str, model: str, timeout: int = 180, expect_json: bool = False) -> str | None:
    start = time.perf_counter()
    try:
        payload = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "num_ctx": 8192,
                # Gemma 4 best practices: temp=1.0, top_p=0.95, top_k=64
                "temperature": 0.3 if expect_json else 1.0,
                "top_p": 0.95,
                "top_k": 64,
            }
        }
        if expect_json:
            payload["format"] = "json"

        resp = requests.post(OLLAMA_URL, json=payload, timeout=timeout)
        resp.raise_for_status()
        raw = resp.json().get("response", "")

        # Strip reasoning blocks (supports DeepSeek <think> AND Gemma 4 <|channel>thought)
        # --- Gemma 4 format: <|channel>thought\n...reasoning...\n<channel|>\nFinal answer
        if "<channel|>" in raw:
            raw = raw.split("<channel|>")[-1].strip()
        elif "<|channel>thought" in raw:
            raw = ""  # Pure reasoning block with no final answer
        # --- DeepSeek format: <think>...reasoning...</think>Final answer
        if "</think>" in raw:
            raw = raw.split("</think>")[-1].strip()
        elif "<think>" in raw and not raw.strip().startswith("<think>"):
            raw = raw.split("<think>")[0].strip()
        elif "<think>" in raw:
            raw = ""  # Pure think block with no output

        latency = time.perf_counter() - start
        logger.info(f"⚡ [{model}] {latency:.1f}s → {len(raw)} chars")
        return raw.strip() if raw.strip() else None

    except requests.exceptions.Timeout:
        logger.error(f"⏱ Ollama TIMEOUT after {timeout}s [{model}]")
        return None
    except Exception as e:
        logger.error(f"Ollama error [{model}]: {e}")
        return None


def _parse_json(text: str, fallback: dict) -> dict:
    if not text:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        pass
    match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except Exception:
            pass
    return fallback


def _load_prompt(filename: str, replacements: dict = None) -> str:
    path = os.path.join(config.PROMPTS_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if replacements:
        for key, val in replacements.items():
            text = text.replace(f"{{{key}}}", str(val))
    return text


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 1 — CLASSIFIER
# ─────────────────────────────────────────────────────────────────────────────

def stage1_classify(thread_text: str) -> dict:
    fallback = {"relevant": True, "confidence": 5, "reason": "Classifier unavailable"}

    prompt = _load_prompt("classifier_prompt.txt", {"thread_text": thread_text[:3000]})
    raw = _call_ollama(prompt, FAST_MODEL, timeout=60, expect_json=True)
    result = _parse_json(raw, fallback)

    result["relevant"] = bool(result.get("relevant", True))
    result.setdefault("confidence", 5)
    result.setdefault("reason", "")

    logger.info(f"🔍 STAGE 1 — relevant={result['relevant']} conf={result['confidence']}/10")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 2 — TRIAGE
# ─────────────────────────────────────────────────────────────────────────────

def stage2_triage(thread_text: str, from_address: str) -> dict:
    fallback = {
        "intent": "OTHER", "needs_assets": [], "name": "",
        "sentiment": "neutral", "urgency": "normal", "summary": "Could not triage",
    }

    prompt = _load_prompt("triage_prompt.txt", {
        "thread_text": thread_text[:4000],
        "from_address": from_address,
    })

    raw = _call_ollama(prompt, FAST_MODEL, timeout=60, expect_json=True)
    result = _parse_json(raw, fallback)

    # CLEAN THE NAME — this is where "Assistant Professor" was leaking through
    raw_name = str(result.get("name", "")).strip()
    cleaned = clean_name(raw_name, from_address)
    
    # If LLM returned garbage, try email extraction
    if not cleaned:
        cleaned = extract_name_from_email(from_address)
    
    result["name"] = cleaned  # May be "" — that's OK, greeting builder handles it
    result.setdefault("intent", "OTHER")
    result.setdefault("needs_assets", [])
    result.setdefault("sentiment", "neutral")

    logger.info(f"🎯 STAGE 2 — intent={result['intent']} name='{result['name']}' raw='{raw_name}'")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 3 — STRATEGIST
# ─────────────────────────────────────────────────────────────────────────────

def stage3_strategize(triage_result: dict, thread_text: str, knowledge_base: str) -> dict:
    fallback = {
        "strategy": "Respond warmly with event details and invite questions",
        "key_points": [
            "Event is May 23 2026, Saturday 7:30 PM IST",
            "Free Zoom webinar with international GI oncology faculty",
            "Certificate of Participation for all attendees",
        ],
        "tone": "warm", "opening_hook": "", "escalate_to_human": False,
        "human_escalation_reason": "",
    }

    prompt = _load_prompt("strategist_prompt.txt", {
        "intent": triage_result.get("intent", "OTHER"),
        "name": triage_result.get("name", ""),
        "sentiment": triage_result.get("sentiment", "neutral"),
        "summary": triage_result.get("summary", ""),
        "thread_text": thread_text[:3000],
        "knowledge_base": knowledge_base[:2000],
    })

    raw = _call_ollama(prompt, SMART_MODEL, timeout=240, expect_json=True)
    result = _parse_json(raw, fallback)

    result.setdefault("strategy", fallback["strategy"])
    result.setdefault("key_points", fallback["key_points"])
    result.setdefault("tone", "warm")
    result.setdefault("escalate_to_human", False)

    logger.info(f"💡 STAGE 3 — tone={result['tone']} escalate={result['escalate_to_human']}")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 4 — COPYWRITER
# ─────────────────────────────────────────────────────────────────────────────

def stage4_draft(strategy_result: dict, triage_result: dict, thread_text: str) -> str:
    name = triage_result.get("name", "")
    greeting = build_greeting(name)
    key_points_str = "\n".join(f"- {p}" for p in strategy_result.get("key_points", []))

    prompt = _load_prompt("copywriter_prompt.txt", {
        "name": name,
        "greeting": greeting,
        "intent": triage_result.get("intent", "OTHER"),
        "tone": strategy_result.get("tone", "warm"),
        "strategy": strategy_result.get("strategy", ""),
        "key_points": key_points_str,
        "thread_text": thread_text[:2000],
    })

    raw = _call_ollama(prompt, SMART_MODEL, timeout=360)
    result = raw.strip() if raw else ""

    logger.info(f"✍️ STAGE 4 — draft length: {len(result)} chars")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 5 — CRITIC (now runs 2 passes)
# ─────────────────────────────────────────────────────────────────────────────

def stage5_critique(draft_text: str) -> dict:
    """
    Council review: 2 passes of the critic.
    Pass 1: Find issues. Pass 2: Verify the fix.
    """
    fallback = {"approved": True, "corrected_draft": draft_text, "issues_found": []}

    if not draft_text or len(draft_text) < 50:
        return {"approved": False, "corrected_draft": draft_text, "issues_found": ["Draft empty/too short"]}

    rules = """RULES TO CHECK:
1. NO markdown: no asterisks (*), no underscores for emphasis (_), no ## headers
2. NO placeholder brackets: [Name], [Date], [Event], [FILL IN], [Recipient Name], [Your Name]
3. Greeting MUST be "Dear Dr. [real name]," or "Hello," — NEVER "Dear Dr. Assistant Professor" or "Dear Dr. Doctor" or "Dear Dr. Email"
4. NO double/triple signatures — there must be EXACTLY ONE signature block at the end
5. The signature block must be EXACTLY: Warm regards,\\nUbhay Anand\\nPartnerships Team, Jarurat Care Foundation\\npartnership@jarurat.care
6. NO disclaimer footers like "This email is sent for informational purposes only" or "Please do not reply to this email" or "This message is for the recipient's use only"
7. NO double commas, double periods, or stray punctuation
8. Content must be 2-4 short paragraphs between greeting and signature (not counting signature)
9. DO NOT repeat information already in the greeting"""

    prompt = _load_prompt("critic_prompt.txt", {"rules": rules, "draft": draft_text})

    # Pass 1
    raw = _call_ollama(prompt, FAST_MODEL, timeout=120, expect_json=True)
    result = _parse_json(raw, fallback)

    corrected = result.get("corrected_draft", "") or draft_text
    issues = result.get("issues_found", [])

    # Pass 2: verify the corrected version
    if issues:
        verify_prompt = f"""You are a FINAL REVIEWER. Check this email draft for ANY remaining issues:

{rules}

DRAFT TO VERIFY:
{corrected}

If there are still issues, output JSON: {{"approved": false, "corrected_draft": "the fixed version", "issues_found": ["issue1"]}}
If it's clean, output JSON: {{"approved": true, "corrected_draft": "the clean version", "issues_found": []}}"""

        raw2 = _call_ollama(verify_prompt, FAST_MODEL, timeout=90, expect_json=True)
        result2 = _parse_json(raw2, {"approved": True, "corrected_draft": corrected, "issues_found": []})
        corrected = result2.get("corrected_draft") or corrected
        issues = issues + result2.get("issues_found", [])

    if not corrected or len(corrected) < 30:
        corrected = draft_text

    logger.info(f"🔎 STAGE 5 — approved={not bool(issues)} issues={issues}")
    return {"approved": not bool(issues), "corrected_draft": corrected, "issues_found": issues}


# ─────────────────────────────────────────────────────────────────────────────
# DRIP EMAIL DRAFTING
# ─────────────────────────────────────────────────────────────────────────────

def draft_drip_email(name: str, org_type: str, stage_number: int, knowledge_base: str) -> str:
    """Draft a cold outreach email for the drip campaign."""
    stage_files = {0: "drip_stage_0.txt", 1: "drip_stage_1.txt", 2: "drip_stage_2.txt"}
    prompt_file = stage_files.get(stage_number, "drip_stage_2.txt")

    org_context_map = {
        "UNIVERSITY": "The recipient is at a university. Encourage sharing with students and faculty.",
        "HOSPITAL": "The recipient is at a hospital. Encourage sharing with clinical colleagues.",
        "GENERAL": "The recipient is an oncology professional. Encourage sharing with their network.",
    }
    org_context = org_context_map.get(org_type, org_context_map["GENERAL"])
    
    # Build greeting for the prompt
    greeting = build_greeting(name)

    prompt = _load_prompt(prompt_file, {
        "name": name if name else "",
        "greeting": greeting,
        "org_type": org_type,
        "org_context": org_context,
        "knowledge_base": knowledge_base[:1500],
        "stage_number": str(stage_number + 1),
    })

    raw = _call_ollama(prompt, SMART_MODEL, timeout=360)
    return raw.strip() if raw else ""


# ─────────────────────────────────────────────────────────────────────────────
# MEETING CONFIRMATION
# ─────────────────────────────────────────────────────────────────────────────

def draft_meeting_confirmation(name: str, meeting_details: str, original_thread: str) -> str:
    greeting = build_greeting(name)
    prompt = (
        f"You are Ubhay Anand from Jarurat Care Foundation (JCF).\n\n"
        f"TASK: Write a brief professional email confirming a meeting/call.\n\n"
        f"RECIPIENT GREETING: {greeting}\n"
        f"MEETING DETAILS: {meeting_details}\n"
        f"CONTEXT:\n{original_thread[:800]}\n\n"
        f"RULES:\n"
        f"1. Plain text only — no markdown, no asterisks, no bold\n"
        f"2. Start with EXACTLY: {greeting}\n"
        f"3. Confirm the meeting date and time\n"
        f"4. Ask them to confirm and keep it under 3 sentences\n"
        f"5. DO NOT add any signature — it will be added automatically\n"
        f"6. DO NOT add any disclaimer footers\n\n"
        f"Write ONLY the email body (greeting + paragraphs). No signature."
    )
    raw = _call_ollama(prompt, SMART_MODEL, timeout=180)
    return raw.strip() if raw else ""


# ─────────────────────────────────────────────────────────────────────────────
# THREAD ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

def check_if_last_message_from_us(thread_text: str, our_email: str) -> bool:
    prompt = (
        f"The JCF email is: {our_email}\n\n"
        f"THREAD:\n{thread_text[-2000:]}\n\n"
        f"Was the LAST message sent BY {our_email}? Output ONLY: YES or NO"
    )
    raw = _call_ollama(prompt, FAST_MODEL, timeout=30)
    if raw:
        return "YES" in raw.strip().upper()
    return False


# ─────────────────────────────────────────────────────────────────────────────
# SELF-TEST
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    # Test name cleaning
    test_names = [
        ("Assistant Professor", "prof@aiims.edu"),
        ("Dr. Associate Professor", "assoc@hospital.com"),
        ("shrutijuyal2", "shrutijuyal2@gmail.com"),
        ("Dr. Rohit Sharma", "rohit@aiims.edu"),
        ("", "dr.amitkumar@hospital.org"),
        ("Professor", "professor@univ.edu"),
        ("Dr. Amit Kumar, MD, DM", "dramitkumar@aiims.edu"),
        ("Senior Consultant", "sconsultant@max.com"),
    ]
    
    print("=== NAME CLEANING TESTS ===")
    for raw, email in test_names:
        cleaned = clean_name(raw, email)
        greeting = build_greeting(cleaned)
        print(f"  '{raw}' ({email}) → '{cleaned}' → {greeting}")
    
    print("\n=== DONE ===")
