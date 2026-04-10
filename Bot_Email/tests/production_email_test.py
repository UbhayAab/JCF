"""
Production Multi-Asset Delivery Test (Phase 23)
Simulates 10 doctor inquiries and SENDS them to the user via Zoho with real attachments.
"""

import sys
import os
import asyncio
import logging

# Add parent dir to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ai_orchestrator
from zoho_logic import ZohoMailService
import config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("prod_test")

TEST_TARGET = "jarurat.care@gmail.com"

TEST_SCENARIOS = [
    {
        "name": "Scenario 1: Future Schedule",
        "input": "Hi JCF team, what events do you have planned for 2026? Especially for GI cancers.",
    },
    {
        "name": "Scenario 2: NGO Overview",
        "input": "Who is behind this foundation and how many patients have you helped?",
    },
    {
        "name": "Scenario 3: Past Event Report",
        "input": "I missed the last session on Cholangiocarcinoma. Do you have a summary report?",
    },
    {
        "name": "Scenario 4: Generic Brochure Request",
        "input": "This looks professional. Can you send me your concept deck or brochure?",
    },
    {
        "name": "Scenario 5: Specific Speaker (Dec 25)",
        "input": "Is Dr. Renuka Iyer joining the December session?",
    }
]

async def run_production_test():
    zoho = ZohoMailService()
    logger.info(f"🚀 Starting Production Delivery Test to {TEST_TARGET}...")
    
    for i, s in enumerate(TEST_SCENARIOS):
        logger.info(f"\n--- 🧪 Executing {s['name']} ---")
        
        # 1. AI Reasoning & Asset Detection
        body, attachments = ai_orchestrator.smart_reply(s["input"])
        
        subject = f"TEST PHASE 23: {s['name']} Verification"
        
        # 2. Actual Zoho Send
        logger.info(f"📧 Sending email via Zoho (Attachments: {len(attachments)})...")
        try:
            res = zoho.send_new_email(TEST_TARGET, subject, body, attachments=attachments)
            logger.info(f"✅ SUCCESS: Email sent for {s['name']}")
        except Exception as e:
            logger.error(f"❌ FAILED to send email: {e}")
            
    logger.info("\n🏁 Production Verification Complete. Check your Gmail inbox!")

if __name__ == "__main__":
    asyncio.run(run_production_test())
