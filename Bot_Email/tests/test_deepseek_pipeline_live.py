import asyncio
import sys
import os
import time

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import local_ai
import ai_orchestrator
import logging

logging.basicConfig(level=logging.INFO, format='\n%(levelname)s: %(message)s')

def print_header(title):
    print("\n" + "="*80)
    print(f"🌟 {title.upper()}")
    print("="*80)

async def print_progress(stage, name, summary):
    print(f"   [{name}] {summary}")

async def run_scenario(name, thread_text, from_addr, is_drip=False):
    print_header(name)
    print(f"📩 FROM: {from_addr}")
    print(f"📝 TEXT: {thread_text}")
    print("-" * 40)
    
    start = time.perf_counter()
    if is_drip:
        # Generate a drip email (Stage 0)
        print("   [Pipeline] Generating Drip Email (Cold Outreach)...")
        draft = ai_orchestrator.generate_drip_email("Assistant Professor", "GENERAL", 0)
        result = {"draft": draft, "intent": "N/A", "escalate_to_human": False, "name": "Assistant Professor"}
    else:
        result = await ai_orchestrator.run_full_pipeline(thread_text, from_addr, progress_cb=print_progress)
        
    latency = time.perf_counter() - start
    print("-" * 40)
    print(f"⏱️  Duration: {latency:.1f}s")
    print(f"🎯 Intent Verified: {result['intent']}")
    print(f"👤 Name Extracted: {result['name']}")
    print(f"🚨 Escalate to Human: {result['escalate_to_human']}")
    print("\n📧 FINAL PAYLOAD (What the recipient actually sees):")
    print("~"*60)
    print(result['draft'])
    print("~"*60)
    
    # Assertions for formatting checking
    if result['draft']:
        if "**" in result['draft']:
            print("❌ FAILURE: Markdown asterisks leaked into output!")
        if "[" in result['draft'] and "]" in result['draft']:
            print("❌ FAILURE: Placeholder brackets leaked into output!")
        if "Dear Dr. Assistant" in result['draft']:
            print("❌ FAILURE: Garbage 'Assistant Professor' name leaked into greeting!")
        if "partnership@jarurat.care" not in result['draft'] and "UNSUBSCRIBE" not in result['draft'] and result['escalate_to_human'] == False:
            print("❌ FAILURE: Canonical JCF Signature is missing!")

async def main():
    print("🧪 INITIALIZING DEEPSEEK LIVE FIRE TEST SUITE")
    print("This will execute full AI generation using the active 8b and 14b models.\n")
    
    # Scenario 1: The "Assistant Professor" Edge Case (HK Scenario)
    await run_scenario(
        "SCENARIO 1: Academic Title Edge Case & Normal Registration",
        "Hello, I am interested in attending the upcoming GI Oncology Webinar on May 23. Please send me the link. Dr. Raj",
        "dr.raj.oncology@hospital.org"
    )
    
    # Scenario 2: Unsubscribe Trigger
    await run_scenario(
        "SCENARIO 2: Hard Unsubscribe",
        "Stop emailing me. Remove me from your mailing list immediately. I am not interested.",
        "angry_doctor@gmail.com"
    )
    
    # Scenario 3: Complex Partnership / Human Escalation
    await run_scenario(
        "SCENARIO 3: Complex Partnership Inquiry",
        "My hospital is interested in formally partnering with the Jarurat Care Foundation to provide fellowship training for GI oncology. Could we set up a meeting?",
        "dean.medical@univ.edu.in"
    )
    
    # Scenario 4: Drip Campaign Generator with Garbage Input
    # Passing "Assistant Professor" intentionally to ensure nuclear processor fixes it to "Hello,"
    # and ensuring the draft formats correctly.
    await run_scenario(
        "SCENARIO 4: Drip Cold-Email Generator",
        "N/A",
        "test@example.com",
        is_drip=True
    )
    
    print_header("TEST SUITE COMPLETE")

if __name__ == "__main__":
    asyncio.run(main())
