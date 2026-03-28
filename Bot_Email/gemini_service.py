"""
Gemini AI Service
- Classifies emails as relevant or spam using negative_prompt.txt
- Generates email replies using positive_prompt.txt
- Polishes templates for bulk sending
Uses Gemini 2.5 Flash-Lite (free tier: 1000 RPD, 15 RPM).
"""

import os
import google.generativeai as genai
import config


# Configure Gemini dynamically per function to support multiple API keys
# genai.configure() is called inside each function.

# Use Flash-Lite for best free tier limits (1000 RPD)
MODEL_NAME = "gemini-2.5-flash-lite"

_api_call_count = 0

def get_active_key():
    """Rotates through the 4 API keys every 4 calls."""
    global _api_call_count
    keys = config.GEMINI_KEYS
    idx = (_api_call_count // 4) % len(keys)
    _api_call_count += 1
    return keys[idx]


def _load_prompt_file(path, fallback="You are a professional email assistant."):
    """Load a prompt from file."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        print(f"⚠️ Prompt file not found: {path}")
        return fallback


def classify_email(thread_text):
    """
    Classify an email as relevant (YES) or spam/irrelevant (NO).
    Uses negative_prompt.txt as the classifier system prompt.
    
    Args:
        thread_text: Full email thread text
    
    Returns:
        True if relevant (should process), False if spam (should skip)
    """
    classifier_prompt = _load_prompt_file(
        config.NEGATIVE_PROMPT_PATH,
        fallback="Classify this email as relevant to an event invitation (YES) or spam/irrelevant (NO). Reply ONLY YES or NO."
    )
    
    user_message = (
        f"Here is the email thread to classify:\n\n"
        f"{thread_text}\n\n"
        f"---\n"
        f"Is this email relevant to our event campaign? Reply ONLY: YES or NO"
    )

    try:
        genai.configure(api_key=get_active_key())
        model = genai.GenerativeModel(
            MODEL_NAME,
            system_instruction=classifier_prompt
        )
        response = model.generate_content(user_message)
        answer = response.text.strip().upper()
        
        # Parse response — look for YES or NO
        if "YES" in answer:
            return True
        elif "NO" in answer:
            return False
        else:
            # If unclear, default to relevant (safer to show to human than miss)
            print(f"⚠️ Unclear classification: '{answer}' — defaulting to relevant")
            return True
    except Exception as e:
        print(f"❌ Classification error: {e} — defaulting to relevant")
        return True  # On error, don't skip


def generate_reply(thread_text, custom_context=None):
    """
    Generate an AI reply for an email thread.
    Uses positive_prompt.txt as the system prompt.
    
    Args:
        thread_text: Full email thread as text (ALL messages from first to latest)
        custom_context: Optional custom context from human-in-the-loop
    
    Returns:
        Generated reply text
    """
    system_prompt = _load_prompt_file(config.POSITIVE_PROMPT_PATH)
    
    # Replace custom context placeholder
    if custom_context:
        system_prompt = system_prompt.replace("{custom_context}", custom_context)
    else:
        system_prompt = system_prompt.replace("{custom_context}", "None — use default behavior.")
    
    user_message = (
        f"Here is the COMPLETE email thread from the very first message (oldest first):\n\n"
        f"{thread_text}\n\n"
        f"---\n\n"
        f"Please draft a professional reply to the LATEST email in this thread. "
        f"Use the FULL thread context to avoid repeating information or losing context. "
        f"Return ONLY the email body text (no subject line, no preamble like 'Here is a draft')."
    )

    try:
        genai.configure(api_key=get_active_key())
        model = genai.GenerativeModel(
            MODEL_NAME,
            system_instruction=system_prompt
        )
        response = model.generate_content(user_message)
        return response.text.strip()
    except Exception as e:
        print(f"❌ Gemini API error: {e}")
        return f"[ERROR: Could not generate reply — {e}]"


def polish_template(template_text):
    """
    Run an initial email template through Gemini once for grammar/formatting polish.
    Returns the polished template with placeholders intact.
    """
    prompt = (
        f"Polish the following email template for grammar, formatting, and professionalism. "
        f"Keep ALL placeholders like {{doctor_name}} exactly as they are. "
        f"Do NOT change the meaning or add new content. "
        f"Return ONLY the polished email body.\n\n"
        f"Template:\n{template_text}"
    )

    try:
        genai.configure(api_key=get_active_key())
        model = genai.GenerativeModel(MODEL_NAME)
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"⚠️ Could not polish template: {e}")
        return template_text  # Return original on failure


def generate_initial_email(doctor_name, template_text, extra_context=None):
    """
    Generate a personalized initial outreach email for a doctor.
    """
    # Simple placeholder replacement
    email_body = template_text.replace("{doctor_name}", f"Dr. {doctor_name}")
    
    if extra_context:
        prompt = (
            f"Here is an email we are sending to Dr. {doctor_name}:\n\n"
            f"{email_body}\n\n"
            f"Additional context about this doctor: {extra_context}\n\n"
            f"Please personalize this email slightly based on the context, "
            f"keeping it professional and concise. Return ONLY the email body."
        )
        try:
            genai.configure(api_key=get_active_key())
            model = genai.GenerativeModel(MODEL_NAME)
            response = model.generate_content(prompt)
            return response.text.strip()
        except Exception as e:
            print(f"⚠️ Could not personalize for {doctor_name}: {e}")
            return email_body
    
    return email_body


# ── Standalone test ────────────────────────────────────────
if __name__ == "__main__":
    config.validate()
    
    print("🤖 Testing Gemini API...\n")
    
    # Test classification
    print("--- Testing Spam Classifier ---")
    spam_email = "Subject: Internship Opportunity\n\nHi, I am a 3rd year student looking for an internship at your organization..."
    result = classify_email(spam_email)
    print(f"Spam email classified as: {'RELEVANT' if result else 'SPAM'} (expected: SPAM)")
    
    relevant_email = (
        "Subject: Re: Invitation to Medical Conference\n\n"
        "Thank you for the invitation. I am interested but I have a surgery scheduled that morning. "
        "Is there an afternoon session I could attend instead?"
    )
    result2 = classify_email(relevant_email)
    print(f"Relevant email classified as: {'RELEVANT' if result2 else 'SPAM'} (expected: RELEVANT)")
    
    # Test reply generation
    print("\n--- Testing Reply Generation ---")
    test_thread = (
        "--- Message ---\n"
        "From: partnership@jarurat.care\n"
        "Subject: Invitation to Medical Conference — 23rd May\n"
        "\nDear Dr. Sharma,\nWe would like to invite you to our upcoming medical conference...\n"
        "\n--- Message ---\n"
        "From: dr.sharma@hospital.com\n"
        "Subject: Re: Invitation to Medical Conference — 23rd May\n"
        "\nThank you for the invitation. I am interested but I have a surgery scheduled that morning. "
        "Is there an afternoon session I could attend instead?\n"
    )
    
    reply = generate_reply(test_thread)
    print(f"Generated reply:\n{reply}\n")
    
    print("✅ Gemini API tests complete.")
