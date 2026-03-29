"""
Bulk Normal Test Suite (Phase 22)
Runs 50 variations of 'Normal' inquiries to measure latency and consistency.
"""

import sys
import os
import asyncio
import logging
import json
import time

# Add parent dir to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ai_orchestrator
import local_ai

logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger("bulk_test")

# 50 Variations of "Normal" Doctor Inquiries
NORMAL_QUERIES = [
    "How do I join the webinar?",
    "Is there a registration fee?",
    "When is the next session?",
    "Can I get a certificate of participation?",
    "Will the sessions be recorded?",
    "I am an oncologist from Mumbai. How can I contribute?",
    "Do you have any sessions on Pancreatic cancer specifically?",
    "Is this open to medical students?",
    "What time is it in IST?",
    "Can I invite my colleagues?",
] * 5 # Multiplying to get 50

async def run_bulk_test():
    print(f"🚀 Starting Bulk Performance Test (50 Scenarios)...")
    results = []
    start_total = time.perf_counter()
    
    for i, q in enumerate(NORMAL_QUERIES):
        print(f"[{i+1}/50] Testing: {q[:30]}...", end=" ", flush=True)
        t0 = time.perf_counter()
        
        # Test Orchestrator (Includes Router + Reply)
        res = ai_orchestrator.smart_reply(q)
        
        latency = time.perf_counter() - t0
        print(f"✅ {latency:.2f}s")
        
        results.append({
            "query": q,
            "latency": latency,
            "response_len": len(res),
            "is_flagged": "[HUMAN_ASSIST_REQUIRED]" in res
        })

    total_time = time.perf_counter() - start_total
    avg_latency = total_time / 50
    
    report = {
        "total_time": total_time,
        "avg_latency": avg_latency,
        "results": results
    }
    
    with open("latency_report.json", "w") as f:
        json.dump(report, f, indent=4)
        
    print(f"\n🏁 Bulk Test Complete!")
    print(f"📊 Average Latency: {avg_latency:.2f}s")
    print(f"📄 Report saved to latency_report.json")

if __name__ == "__main__":
    asyncio.run(run_bulk_test())
