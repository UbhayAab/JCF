"""
Comprehensive Stress Test Suite (Phase 22)
Tests the bot's resilience against complex medical inquiries and deterministic flows.
"""

import sys
import os
import asyncio
import logging

# Add parent dir to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ai_orchestrator
import local_ai

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stress_test")

SCENARIOS = [
    {
        "name": "Scenario A: Unsubscribe Request",
        "input": "Please unsubscribe me from this list. I do not want any more emails.",
        "expected_logic": "Should be handled by main.py detector (Deterministic)",
    },
    {
        "name": "Scenario B: Real Brochure Request",
        "input": "This sounds interesting. Can you send me the brochure and the registration link?",
        "contains": ["horizon-brochure.pdf", "horizon-registration"],
    },
    {
        "name": "Scenario C: Complex Speaker Verification",
        "input": "Is Dr. Vinay Kapoor or Dr. Amit from AIIMS joining the summit?",
        "contains": ["flagged", "leadership"], # Should trigger human assist
    },
    {
        "name": "Scenario D: Language Barrier",
        "input": "Do you have any materials in Hindi? I want to share with my local clinic.",
        "contains": ["flagged", "team"], # Should trigger human assist
    },
    {
        "name": "Scenario E: Student Fellowship Inquiry",
        "input": "I am a 3rd year resident. Are there any travel fellowships for this series?",
        "contains": ["flagged", "leadership"], # Should trigger human assist
    }
]

async def run_tests():
    logger.info("🚀 Starting Comprehensive Stress Test (Phase 22)...")
    
    for s in SCENARIOS:
        logger.info(f"\n--- 🧪 Testing {s['name']} ---")
        logger.info(f"Input: {s['input']}")
        
        # Test AI Response
        reply = ai_orchestrator.smart_reply(s["input"])
        logger.info(f"AI Output: {reply[:300]}...")
        
        # Verification
        if "contains" in s:
            match = any(word.lower() in reply.lower() for word in s["contains"])
            if match:
                logger.info("✅ SUCCESS: Grounding/Flagging correct.")
            else:
                logger.error("❌ FAILURE: AI hallucinated or failed to ground.")
                
        if "[HUMAN_ASSIST_REQUIRED]" in reply:
             logger.info("🚩 HUMAN ASSIST: Correctly flagged for complex query.")

    logger.info("\n🏁 Stress Test Suite Complete.")

if __name__ == "__main__":
    asyncio.run(run_tests())
