"""
AI Orchestrator (v3.0 - 100% Local Autonomy)
Zero-Cost High-Precision Outreach on your RTX 4050.
"""

import os
import logging
import config
import local_ai
from gemini_service import classify_email as gemini_classify, generate_reply as gemini_reply

logger = logging.getLogger("ai_orchestrator")

# DECOMMISSIONED: DeepSeek Cloud (unavailable in India)
# We now use the local DeepSeek-R1-8B as the Primary Engine.

def smart_classify(thread_text):
    """Zero-cost local classification."""
    res = local_ai.classify_spam_locally(thread_text)
    if res is not None:
        return res
    # Gemini (Free Tier) as Emergency Fallback only
    return gemini_classify(thread_text)

def smart_name_clean(name_str, email_addr):
    """High-precision local name cleaning."""
    import re
    # 1. Local AI First
    llm_name = local_ai.clean_name_locally(name_str, email_addr)
    if llm_name:
        return llm_name
        
    # 2. Algorithmic Fallback
    prefix = email_addr.split("@")[0]
    prefix = re.sub(r'^(dr|prof|doctor|associate|assistant)', '', prefix, flags=re.IGNORECASE)
    return prefix.replace(".", " ").replace("_", " ").strip().capitalize()

def smart_extract_intent(thread_text):
    """Router layer: Identifies query intent using a fast, local extraction prompt."""
    prompt = (
        "Analyze the following email thread and identify the user's primary intent.\n"
        "Categories: UNSUBSCRIBE, REGISTRATION_LINK, BROCHURE_REQUEST, SYLLABUS_REQUEST, MEDICAL_INQUIRY, PARTNERSHIP, OTHER.\n\n"
        f"THREAD:\n{thread_text}\n\n"
        "Output ONLY the category name."
    )
    # Use 8B model for fast routing
    intent = local_ai.run_local_prompt(prompt, model="deepseek-r1:8b")
    return intent.strip().upper() if intent else "OTHER"

def get_relevant_assets(thread_text):
    """Maps keywords to local PDF paths in the Docs/ folder."""
    assets = []
    text = thread_text.lower()
    
    # 1. Horizon Deck (Future/Concept/Brochure)
    if any(k in text for k in ["upcoming", "concept", "brochure", "future", "schedule"]):
        assets.append(os.path.join(config.BASE_DIR, "Docs", "Horizon Deck .pdf"))
        
    # 2. Horizon I Summary (Past Report)
    if any(k in text for k in ["summary", "last event", "report", "previous", "happened"]):
        assets.append(os.path.join(config.BASE_DIR, "Docs", "Horizon I Event Summary_July25.pdf"))
        
    # 3. JCF Deck (NGO Overview)
    if any(k in text for k in ["ngo", "foundation", "team", "who are you", "impact"]):
        assets.append(os.path.join(config.BASE_DIR, "Docs", "JCF Deck.pdf"))
        
    return list(set(assets)) # Unique paths

def smart_reply(thread_text, context=None):
    """Logic-First Reply Orchestrator. Returns (body, attachments)."""
    intent = smart_extract_intent(thread_text)
    logger.info(f"🎯 Router Verdict: {intent}")
    
    # 1. Deterministic Assets
    attachments = get_relevant_assets(thread_text)
    
    # 2. Deterministic Logic
    if intent == "UNSUBSCRIBE":
        return "[DETERMINISTIC_ACTION] UNSUBSCRIBE detected.", []
        
    if intent in ["PARTNERSHIP", "SYLLABUS_REQUEST"]:
        return "[HUMAN_ASSIST_REQUIRED] I have flagged this for our leadership team.", attachments

    # 3. Local DeepSeek-R1 (High-Fidelity Drafting)
    local_res = local_ai.generate_reply_locally(thread_text, context)
    
    if local_res:
        complex_keywords = ["flagged for", "leadership team", "academic team", "manual review"]
        if any(kw in local_res.lower() for kw in complex_keywords):
            return f"[HUMAN_ASSIST_REQUIRED] {local_res}", attachments
        return local_res, attachments
        
    return "[ERROR] Local-AI failed or timed out. Manually reply in Zoho.", []
