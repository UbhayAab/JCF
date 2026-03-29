"""
Interactive AI Performance Demo (v2.0)
Witness the intelligence of your local RTX 4050.
"""

import os
import sys
# Ensure we can import local modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import local_ai
import logging

# Load actual project prompts
def load_p(filename):
    ppath = os.path.join("prompts", filename)
    if os.path.exists(ppath):
        with open(ppath, "r", encoding="utf-8") as f:
            return f.read()
    return ""

POS_P = load_p("positive_prompt.txt")
NEG_P = load_p("negative_prompt.txt")

print("="*60)
print("🚀 LOCAL AI STRESS TEST: DeepSeek-R1-8B @ RTX 4050")
print("="*60)

# SCENARIO 1: COMPLEX TRIAGE
print("\n[TEST 1] Scenario: Subtle Inquiry (WHO Partnership Request)")
inquiry = (
    "Subject: Re: Horizon Series\n"
    "Hi Ubhay, I am Dr. Elena from the WHO. I saw your foundation mentioned in a paper on GI Oncology. "
    "I would love to discuss a potential data-sharing partnership for our upcoming global report, but I cannot "
    "attend your webinar due to a scheduling conflict. Is there another way to sync?"
)
print(f"INPUT: {inquiry[:100]}...")
res1 = local_ai.classify_spam_locally(inquiry)
print(f"DECISION: {'✅ RELEVANT' if res1 else '❌ SPAM'}")

# SCENARIO 2: COMPLEX REPLY
print("\n[TEST 2] Scenario: Specific Medical Question")
thread = (
    "From: dr.smith@hospital.com\n"
    "Subject: Oncology Webinar Question\n\n"
    "Dear Ubhay, I saw the invite for the Horizon Series. Who is the lead speaker for the pancreatic session? "
    "I have a specific interest in robotic surgery outcomes."
)
print(f"INPUT: {thread[:100]}...")
res2 = local_ai.generate_reply_locally(thread)
print(f"LOCAL AI DRAFT:\n{res2}")

# SCENARIO 3: NESTED CHAIN FOLLOW-UP
print("\n[TEST 3] Scenario: High-Profile Polished Nudge")
nudge_prompt = "Generate a polished 3rd follow-up for a high-profile GI surgeon. Emphasize legacy and organizational networking."
res3 = local_ai.run_local_prompt(nudge_prompt)
print(f"LOCAL AI NUDGE:\n{res3}")

print("\n" + "="*60)
print("🏁 DEMO COMPLETE. Zero costs. Total Autonomy.")
print("="*60)
