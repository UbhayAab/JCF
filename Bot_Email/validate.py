"""Full system validation"""
import sys

print("Testing imports...")
import config; print("  config OK")
import state; print("  state OK")
import database; database.ensure_db(); print("  database OK")
import local_ai; print("  local_ai OK")
import ai_orchestrator; print("  ai_orchestrator OK")
import zoho_logic; z = zoho_logic.ZohoMailService(); print("  zoho_logic OK")
import telegram_bot; print("  telegram_bot OK")
import drip_campaign; print("  drip_campaign OK")
import main; print("  main OK")

print("\n✅ ALL 9 MODULES IMPORTED CLEAN\n")

# Test attachment upload
print("Testing attachment upload...")
attachments = z.upload_attachments()
for a in attachments:
    print(f"  📎 {a['attachmentName']}")
print(f"\n✅ {len(attachments)} attachments uploaded\n")

# Test name cleaning
print("Testing name cleaning...")
tests = [
    ("Assistant Professor", "prof@aiims.edu"),
    ("shrutijuyal2", "shrutijuyal2@gmail.com"),
    ("Dr. Rohit Sharma", "rohit@hospital.com"),
    ("", "dramitkumar@aiims.edu"),
    ("Associate Professor", "assocprof@univ.edu"),
]
all_pass = True
for raw, email in tests:
    cleaned = local_ai.clean_name(raw, email)
    greeting = local_ai.build_greeting(cleaned)
    bad = any(x in greeting.lower() for x in ["professor", "email", "doctor,", "dr. ,", "dr. dr", "shrutijuyal2"])
    status = "❌ FAIL" if bad else "✅"
    if bad: all_pass = False
    print(f"  {status} '{raw}' → {greeting}")

if all_pass:
    print("\n✅ ALL NAME TESTS PASS")
else:
    print("\n❌ SOME NAME TESTS FAILED")

# Test nuclear post-processor
print("\nTesting nuclear post-processor...")
junk_email = """Dear Dr. Assistant Professor,

I hope this message finds you well.

Warm regards,
Ubhay Anand
Partnerships Team, Jarurat Care Foundation
partnership@jarurat.care

---

This email is sent for informational purposes only. Please do not hesitate to contact us.

Jarurat Care Foundation
www.jarurat.care"""

cleaned = ai_orchestrator._nuke_clean(junk_email, "")
cleaned = ai_orchestrator._add_signature(cleaned)
print(f"  Input had 'Assistant Professor': {'Assistant Professor' in junk_email}")
print(f"  Output has 'Assistant Professor': {'Assistant Professor' in cleaned}")
print(f"  Output has 'informational purposes': {'informational purposes' in cleaned}")
print(f"  Output has 'www.jarurat.care' in body: {'www.jarurat.care' in cleaned}")
print(f"  Output starts with 'Hello,': {cleaned.startswith('Hello,')}")
print(f"  Output has EXACTLY one signature: {cleaned.count('partnership@jarurat.care') == 1}")
print(f"\n--- FINAL OUTPUT ---\n{cleaned}\n---")
print("\n✅ ALL TESTS COMPLETE")
