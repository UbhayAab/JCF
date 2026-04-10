"""
AI Orchestrator (v5.0 — Nuclear Post-Processor)

Key fixes:
- Signature is ALWAYS injected by code, NEVER from LLM output
- Post-processor strips ALL junk: duplicate sigs, disclaimers, markdown, brackets
- Name cleaning uses deterministic regex (no "Dear Dr. Assistant Professor" ever)
- Bodies are properly formatted with real newlines
"""

import os
import re
import logging
import config
import local_ai

logger = logging.getLogger("ai_orchestrator")


# ─────────────────────────────────────────────────────────────────────────────
# Knowledge Base Loader
# ─────────────────────────────────────────────────────────────────────────────

def _load_kb() -> str:
    try:
        with open(config.KB_PROMPT_PATH, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return (
            "JCF Horizon Series GI Oncology Webinar. Next event: May 23, 2026 (Saturday) "
            "7:30 PM IST. Free Zoom webinar. Topic: Biliary Tract Cancers. Free to attend."
        )


# ─────────────────────────────────────────────────────────────────────────────
# NUCLEAR POST-PROCESSOR
# Every single thing that can go wrong gets caught here.
# ─────────────────────────────────────────────────────────────────────────────

def _nuke_clean(text: str, name: str = "") -> str:
    """
    Deterministic cleanup. Runs AFTER LLM critic.
    This is the LAST line of defense before the email gets sent.
    """
    if not text:
        return text

    # ── 1. Kill ALL markdown ──────────────────────────────────────────────────
    text = re.sub(r'[\*]{1,3}([^*]+)[\*]{1,3}', r'\1', text)  # *bold* → bold
    text = re.sub(r'[_]{1,3}([^_]+)[_]{1,3}', r'\1', text)    # _italic_ → italic
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)  # ## Header → Header
    text = re.sub(r'^\s*[-*]\s+', '', text, flags=re.MULTILINE) # - bullet → bullet (only at line start)

    # ── 2. Kill ALL bracketed placeholders ────────────────────────────────────
    text = re.sub(r'\[(?:FOR|TEST|FILL|NAME|DATE|EVENT|RECIPIENT|YOUR|INSERT|ADD|PLACEHOLDER)[^\]]*\]', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\[[A-Z][^\]]{0,40}\]', '', text)  # Any remaining [CAPS STUFF]

    # ── 3. Fix greeting hallucinations ────────────────────────────────────────
    # "Dear Dr. Assistant Professor," → "Hello,"
    # "Dear Dr. Associate Professor," → "Hello,"
    # "Dear Dr. Dr.," → use real name or "Hello,"
    # "Dear Dr. shrutijuyal2," → clean name or "Hello,"
    # "Dear Dr. ," → "Hello,"
    # "Dear Dr. Email," → "Hello,"
    # "Dear Dr. Doctor," → "Hello,"
    
    greeting = local_ai.build_greeting(name)
    
    bad_greeting_patterns = [
        r'Dear\s+Dr\.?\s*(Assistant|Associate|Additional|Adjunct)?\s*Professor\s*,?',
        r'Dear\s+Dr\.?\s*Dr\.?\s*,?',
        r'Dear\s+Dr\.?\s*Doctor\s*,?',
        r'Dear\s+Dr\.?\s*Email\s*,?',
        r'Dear\s+Dr\.?\s*\d+\s*,?',
        r'Dear\s+Dr\.?\s*,\s*,?',
        r'Dear\s+Dr\.?\s+,',
        r'Dear\s+Dr\.\s*$',
        r'Dear\s+Sir/Madam\s*,?',
        r'Dear\s+Sir\s*,?',
        r'Dear\s+Madam\s*,?',
        r'Dear\s+Colleague\s*,?',
        r'Dear\s+Dr\.?\s*(Senior|Junior|Chief|Head|Resident|Consultant|Fellow|Lecturer)\s*,?',
    ]

    for pattern in bad_greeting_patterns:
        if re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE):
            text = re.sub(pattern, greeting, text, count=1, flags=re.IGNORECASE | re.MULTILINE)
            break

    # Also catch: "Dear Dr. username2," where username looks like email prefix
    text = re.sub(r'Dear\s+Dr\.?\s+\w*\d+\w*\s*,', greeting, text, flags=re.IGNORECASE)

    # ── 4. Strip ALL signature blocks (we add our own) ────────────────────────
    # Remove everything from "Warm regards" / "Best regards" / "Kind regards" onwards
    sig_patterns = [
        r'(?:Warm|Best|Kind|Sincerely|With)\s*regards?\s*,?\s*\n.*',
        r'Sincerely\s*,?\s*\n.*',
        r'Thank\s+you\s*,?\s*\n\s*Ubhay.*',
        r'\n\s*Ubhay\s+Anand\s*\n.*',
        r'\n\s*Partnerships?\s+Team.*Jarurat.*',
        r'\n\s*partnership@jarurat\.care.*',
    ]
    for pattern in sig_patterns:
        text = re.sub(pattern, '', text, flags=re.IGNORECASE | re.DOTALL)

    # ── 5. Kill disclaimer/footer junk ────────────────────────────────────────
    disclaimers = [
        r'[-—]{2,}\s*\n.*$',  # --- followed by anything = footer
        r'This\s+email\s+is\s+(on\s+behalf|sent\s+for|for\s+informational).*$',
        r'This\s+message\s+is\s+for\s+the\s+recipient.*$',
        r'Do\s+not\s+reply\s+to\s+this\s+email.*$',
        r'Please\s+do\s+not\s+hesitate.*$',
        r'If\s+received\s+in\s+error.*$',
        r'www\.jarurat\.care\s*$',
        r'Jarurat\s+Care\s+Foundation\s*$',
        r'Looking\s+forward\s+to\s+hearing\s+from\s+you\.\s*$',
    ]
    for pattern in disclaimers:
        text = re.sub(pattern, '', text, flags=re.IGNORECASE | re.DOTALL | re.MULTILINE)

    # ── 6. Fix punctuation ────────────────────────────────────────────────────
    text = text.replace(",,", ",").replace("..", ".").replace(" ,", ",")
    text = re.sub(r'\n{3,}', '\n\n', text)  # Max 2 newlines in a row

    # ── 7. Fix empty topic references ─────────────────────────────────────────
    text = re.sub(r'focus on\s+\.', 'focus on Advanced Biliary Tract Cancer (BTC)', text)

    # ── 8. Final cleanup ──────────────────────────────────────────────────────
    text = text.strip()

    # Ensure the greeting is at the start
    if not text.startswith(("Dear ", "Hello", "Hi ")):
        text = greeting + "\n\n" + text

    return text


def _add_signature(body: str) -> str:
    """Append the canonical signature. ALWAYS. Only source of truth."""
    body = body.strip()
    # Don't double-add if it somehow already has one
    if "partnership@jarurat.care" in body:
        return body
    return body + "\n\n" + config.JCF_SIGNATURE


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline Result Type
# ─────────────────────────────────────────────────────────────────────────────

def _make_result(
    draft="", assets=None, intent="OTHER", name="",
    escalate=False, escalation_reason="", is_relevant=True, stages=None
) -> dict:
    return {
        "draft": draft,
        "assets": assets or [],
        "intent": intent,
        "name": name,
        "escalate_to_human": escalate,
        "human_escalation_reason": escalation_reason,
        "is_relevant": is_relevant,
        "pipeline_stages": stages or {},
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main Pipeline
# ─────────────────────────────────────────────────────────────────────────────

async def run_full_pipeline(thread_text: str, from_address: str, progress_cb=None) -> dict:
    async def notify(stage: int, name: str, summary: str):
        if progress_cb:
            try:
                await progress_cb(stage, name, summary)
            except Exception:
                pass

    kb = _load_kb()
    stages = {}

    # ── Stage 1: Classify ─────────────────────────────────────────────────────
    await notify(1, "Classifier", "⏳ Checking relevance...")
    s1 = local_ai.stage1_classify(thread_text)
    stages["s1"] = s1

    if not s1.get("relevant", True):
        await notify(1, "Classifier", f"🚫 Not relevant: {s1.get('reason', '')}")
        return _make_result(intent="SPAM", is_relevant=False, stages=stages)
    await notify(1, "Classifier", f"✅ Relevant ({s1.get('confidence', '?')}/10)")

    # ── Stage 2: Triage ───────────────────────────────────────────────────────
    await notify(2, "Triage", "⏳ Identifying intent...")
    s2 = local_ai.stage2_triage(thread_text, from_address)
    stages["s2"] = s2
    
    name = s2.get("name", "")
    greeting = local_ai.build_greeting(name)
    await notify(2, "Triage", f"✅ {s2.get('intent')} | {greeting}")

    intent = s2.get("intent", "OTHER")

    if intent == "UNSUBSCRIBE":
        return _make_result(draft="[UNSUBSCRIBE]", intent="UNSUBSCRIBE", name=name, stages=stages)

    if intent == "MEETING_REQUEST":
        reason = f"{greeting.rstrip(',')} is requesting a meeting. Reply to this Telegram message with date/time."
        return _make_result(intent="MEETING_REQUEST", name=name, escalate=True, escalation_reason=reason, stages=stages)

    # ── Stage 3: Strategize ───────────────────────────────────────────────────
    await notify(3, "Strategist", "⏳ Planning response...")
    s3 = local_ai.stage3_strategize(s2, thread_text, kb)
    stages["s3"] = s3
    await notify(3, "Strategist", f"✅ Tone: {s3.get('tone')}")

    if s3.get("escalate_to_human"):
        return _make_result(
            draft=s3.get("human_escalation_reason", ""),
            intent=intent, name=name, escalate=True,
            escalation_reason=s3.get("human_escalation_reason", "Complex query."),
            stages=stages
        )

    # ── Stage 4: Draft ────────────────────────────────────────────────────────
    await notify(4, "Copywriter", "⏳ Writing draft...")
    s4_text = local_ai.stage4_draft(s3, s2, thread_text)
    stages["s4_len"] = len(s4_text) if s4_text else 0

    if not s4_text:
        return _make_result(
            draft="[ERROR] Draft generation failed.", intent=intent, name=name,
            escalate=True, escalation_reason="Stage 4 failed.", stages=stages
        )
    await notify(4, "Copywriter", f"✅ {len(s4_text)} chars")

    # ── Stage 5: Critic (2-pass council) ──────────────────────────────────────
    await notify(5, "Critic Council", "⏳ Reviewing (2 passes)...")
    s5 = local_ai.stage5_critique(s4_text)
    stages["s5"] = {"approved": s5.get("approved"), "issues": s5.get("issues_found", [])}

    final = s5.get("corrected_draft") or s4_text

    # ── NUCLEAR POST-PROCESSOR (catches everything the LLM missed) ────────────
    final = _nuke_clean(final, name)
    final = _add_signature(final)

    issues_log = ", ".join(s5.get("issues_found", [])) or "none"
    await notify(5, "Critic Council", f"✅ Review done | Issues: {issues_log[:60]}")

    return _make_result(draft=final, intent=intent, name=name, stages=stages)


# ─────────────────────────────────────────────────────────────────────────────
# Drip Email Generation
# ─────────────────────────────────────────────────────────────────────────────

def generate_drip_email(name: str, org_type: str, stage_number: int) -> str:
    """Draft + critique + nuclear-clean a drip email."""
    kb = _load_kb()
    
    # Clean the name BEFORE drafting
    cleaned = local_ai.clean_name(name)

    draft = local_ai.draft_drip_email(cleaned, org_type, stage_number, kb)
    if not draft:
        return ""

    s5 = local_ai.stage5_critique(draft)
    final = s5.get("corrected_draft") or draft
    
    # Nuclear post-process
    final = _nuke_clean(final, cleaned)
    final = _add_signature(final)
    
    return final


# ─────────────────────────────────────────────────────────────────────────────
# Name Cleaning (public interface)
# ─────────────────────────────────────────────────────────────────────────────

def clean_name(email_addr: str, name_hint: str = "") -> str:
    """Clean a name. Returns empty string if truly unknown.
    
    CRITICAL: If name_hint contains '@', it's corrupted data (email address
    stored in the Name column) — IGNORE it and extract from recipient's email.
    """
    # REJECT garbage name_hints: email addresses, empty, pure digits
    if name_hint:
        hint = str(name_hint).strip()
        # If name_hint IS an email address → ignore it completely
        if "@" in hint:
            hint = ""
        # If it's just digits or too short
        elif len(hint) < 2 or hint.isdigit():
            hint = ""
    else:
        hint = ""
    
    if hint:
        cleaned = local_ai.clean_name(hint, email_addr)
        if cleaned:
            return cleaned
    
    return local_ai.extract_name_from_email(email_addr)
