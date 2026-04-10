import asyncio
import sys
import os
import time

# Add parent directory to path so we can import modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
import local_ai
import ai_orchestrator

def print_section(title):
    print(f"\n{'='*50}\n🚀 {title}\n{'='*50}")

def test_name_cleaner():
    print_section("TESTING DETERMINISTIC NAME EXTRACTION")
    
    cases = [
        ("dr.amitkumar@aiims.edu.in", "Assistant Professor", "Amitkumar"),
        ("shrutijuyal2@gmail.com", "shrutijuyal2", "Shrutijuyal"),
        ("prof.rajesh@hospital.com", "Dr. Rajesh, MD", "Rajesh"),
        ("hod.oncology@institute.org", "Head of Department", "Oncology"),
        ("contact@ngo.org", "", "Contact"),
    ]
    
    passed = 0
    for email, raw_name, expected_partial in cases:
        clean = local_ai.clean_name(raw_name, email)
        greeting = local_ai.build_greeting(clean)
        print(f"📧 Email: {email}\n   Raw Name: '{raw_name}'\n   Cleaned: '{clean}'\n   Greeting: '{greeting}'\n")
        passed += 1
        
    print(f"✅ Name Extraction: {passed}/{len(cases)} completed.")

def test_model_connectivity():
    print_section(f"TESTING GEMMA 4 ({config.OLLAMA_DRAFT_MODEL}) REASONING ENGINE")
    
    # Test a simple logic capability and proper formatting
    prompt = (
        "<|think|>\n"
        "You are an AI validating your reasoning.\n\n"
        "Draft a single short paragraph telling me why 31B models are better than 8B models. "
        "Do not use markdown, no asterisks, no headers."
    )
    
    start = time.perf_counter()
    print("⏳ Calling Gemma 4... this will take some time for 31B model to think...")
    response = local_ai._call_ollama(prompt, config.OLLAMA_DRAFT_MODEL, timeout=600)
    latency = time.perf_counter() - start
    
    print(f"\n⏱️ Latency: {latency:.2f} seconds")
    if response:
        print(f"\n🧠 GEMMA 4 OUTPUT:\n{response}")
    else:
        print("❌ Model failed to respond or timed out.")

def test_full_pipeline_mock():
    print_section("TESTING FULL PIPELINE & FORMATTING")
    
    thread_text = "Hello, I am interested in attending the Horizon Series webinar next month. Could you send me the agenda?"
    from_addr = "dr.smith.john@hospital.org"
    
    print("⏳ Running Ai Orchestrator (Stages 1-5 & Nuclear Post-Processor)...")
    
    # We use asyncio run to execute the orchestrator
    result = asyncio.run(ai_orchestrator.run_full_pipeline(thread_text, from_addr))
    
    print("\n🎯 PIPELINE VERDICT:")
    print(f"Intent: {result['intent']}")
    print(f"Relevant: {result['is_relevant']}")
    print(f"Extracted Name: {result['name']}")
    print(f"Escalate to Human: {result['escalate_to_human']}")
    
    print("\n📧 FINAL DRAFT EMAIL (Nuclear Post-Processed):")
    print("-" * 40)
    print(result['draft'])
    print("-" * 40)

if __name__ == "__main__":
    print("🧪 BEGINNING GEMMA 4 VERIFICATION SUITE")
    print(f"Targeting logic engine: {config.OLLAMA_DRAFT_MODEL}")
    
    test_name_cleaner()
    test_model_connectivity()
    test_full_pipeline_mock()
    print("\n✅ Verification complete.")
