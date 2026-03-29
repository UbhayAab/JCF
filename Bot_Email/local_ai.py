"""
Local AI Bridge (v1.0)
Uses Ollama to provide zero-cost, high-precision AI on the RTX 4050.
"""

import requests
import json
import logging
import os
import config

logger = logging.getLogger("local_ai")

OLLAMA_BASE_URL = "http://localhost:11434/api/generate"
DEFAULT_MODEL = "deepseek-r1:14b" # Pro-tier Reasoning for RTX 4050/32GB

import time

def run_local_prompt(prompt, model=DEFAULT_MODEL, stream=False):
    """Bridge to Ollama API with detailed performance telemetry."""
    start_time = time.perf_counter()
    try:
        payload = {"model": model, "prompt": prompt, "stream": stream}
        resp = requests.post(OLLAMA_BASE_URL, json=payload, timeout=120)
        resp.raise_for_status()
        
        full_response = resp.json().get("response", "").strip()
        latency = time.perf_counter() - start_time
        
        # Extract reasoning think block if present
        think_text = ""
        if "<think>" in full_response and "</think>" in full_response:
            think_text = full_response.split("<think>")[-1].split("</think>")[0].strip()
            actual_reply = full_response.split("</think>")[-1].strip()
        else:
            actual_reply = full_response
            
        logger.info(f"📊 AI Perf: {model} | {latency:.2f}s | ReplyLen: {len(actual_reply)} chars")
        return actual_reply
    except Exception as e:
        logger.error(f"Local AI Error: {e}")
        return None

def classify_spam_locally(thread_text):
    """Uses Local AI to determine if an email is relevant to the Horizon Series."""
    prompt = (
        "You are an expert triage assistant for the Jarurat Care Foundation (GI Oncology Cancer NGO).\n"
        "Topic: Horizon Series International Webinar (Doctor outreach).\n\n"
        f"EMAIL THREAD:\n{thread_text}\n\n"
        "INSTRUCTIONS:\n"
        "Is this email relevant to our oncology event? (e.g. inquiry about the event, doctor introduction, collaboration request).\n"
        "Return 'RELEVANT' or 'SPAM'. Output ONLY the one word answer."
    )
    result = run_local_prompt(prompt)
    if result:
        clean_res = result.upper().strip()
        if "RELEVANT" in clean_res:
            return True
        if "SPAM" in clean_res:
            return False
    return False

def clean_name_locally(name_str, email_addr):
    """Crazy smarter name extraction using Local AI + Regex."""
    # If the CSV already has a good name, use it
    if name_str and len(name_str.split()) >= 2 and "Professor" not in name_str:
        return name_str.split()[0]
        
    prompt = (
        f"Extract the most likely first name of a doctor from these two pieces of info:\n"
        f"Name field from CSV: {name_str}\n"
        f"Email Address: {email_addr}\n\n"
        f"Output ONLY the first name (e.g. 'Biswajyoti' or 'Anand'). "
        f"Do NOT include 'Dr.' or titles. If you can't guess, output 'Doctor'."
    )
    res = run_local_prompt(prompt)
    return res.strip() if res else "Doctor"

def generate_reply_locally(thread_text, context=None):
    """Zero-cost medical drafting using Local DeepSeek-R1."""
    # Load grounded prompt from file
    try:
        with open(config.POSITIVE_PROMPT_PATH, "r", encoding="utf-8") as f:
            system_prompt = f.read()
    except Exception as e:
        logger.error(f"Failed to load positive prompt: {e}")
        system_prompt = "You are an AI assistant for Jarurat Care Foundation."

    user_prompt = f"THREAD:\n{thread_text}\n\nCONTEXT:\n{context}\n\nDraft:" if context else f"THREAD:\n{thread_text}\n\nDraft:"
    
    prompt = f"{system_prompt}\n\n{user_prompt}"
    return run_local_prompt(prompt)
