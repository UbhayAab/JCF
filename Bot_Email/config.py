import os
import sys
from dotenv import load_dotenv

load_dotenv()

# ── Zoho Mail ──────────────────────────────────────────────
ZOHO_CLIENT_ID     = os.getenv("ZOHO_CLIENT_ID", "")
ZOHO_CLIENT_SECRET = os.getenv("ZOHO_CLIENT_SECRET", "")
ZOHO_REFRESH_TOKEN = os.getenv("ZOHO_REFRESH_TOKEN", "")
ZOHO_ACCOUNT_ID    = os.getenv("ZOHO_ACCOUNT_ID", "")
ZOHO_FROM_EMAIL    = os.getenv("ZOHO_FROM_EMAIL", "")

# ── Telegram ───────────────────────────────────────────────
TELEGRAM_BOT_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_GROUP_CHAT_ID = os.getenv("TELEGRAM_GROUP_CHAT_ID", "")

# ── Local AI (Ollama) ───────────────────────────────────────
# Currently using DeepSeek models for the live testing phase
OLLAMA_TRIAGE_MODEL = os.getenv("OLLAMA_TRIAGE_MODEL", "deepseek-r1:8b")
OLLAMA_DRAFT_MODEL  = os.getenv("OLLAMA_DRAFT_MODEL",  "deepseek-r1:14b")

# ── Zoho API ───────────────────────────────────────────────
ZOHO_API_BASE  = "https://mail.zoho.in/api"
ZOHO_AUTH_BASE = "https://accounts.zoho.in/oauth/v2"

# ── Polling & Sending ──────────────────────────────────────
POLL_INTERVAL_SECONDS = 120     # Check inbox every 2 minutes
BULK_SEND_DELAY_MIN   = 8       # Min seconds between drip emails
BULK_SEND_DELAY_MAX   = 15      # Max seconds between drip emails

# ── Paths ───────────────────────────────────────────────────
BASE_DIR          = os.path.dirname(os.path.abspath(__file__))
PROMPTS_DIR       = os.path.join(BASE_DIR, "prompts")
DATA_DIR          = os.path.join(BASE_DIR, "data")
DOCS_DIR          = os.path.join(BASE_DIR, "docs")
STATE_FILE        = os.path.join(DATA_DIR, "state.json")
EMAIL_LIST_PATH   = os.path.join(DATA_DIR, "email_list.txt")

# Individual prompt paths
CLASSIFIER_PROMPT_PATH  = os.path.join(PROMPTS_DIR, "classifier_prompt.txt")
TRIAGE_PROMPT_PATH      = os.path.join(PROMPTS_DIR, "triage_prompt.txt")
STRATEGIST_PROMPT_PATH  = os.path.join(PROMPTS_DIR, "strategist_prompt.txt")
COPYWRITER_PROMPT_PATH  = os.path.join(PROMPTS_DIR, "copywriter_prompt.txt")
CRITIC_PROMPT_PATH      = os.path.join(PROMPTS_DIR, "critic_prompt.txt")
KB_PROMPT_PATH          = os.path.join(PROMPTS_DIR, "jcf_knowledge_base.txt")

# ── PDF Attachments ─────────────────────────────────────────
# Actual PDF files to attach to emails via Zoho upload API
ATTACHMENT_PDFS = [
    {"display_name": "Horizon_Series_Deck.pdf",        "path": os.path.join(DOCS_DIR, "Horizon Deck .pdf")},
    {"display_name": "Past_Event_Summary.pdf",          "path": os.path.join(DOCS_DIR, "Horizon I Event Summary_July25.pdf")},
    {"display_name": "JCF_Foundation_Profile.pdf",      "path": os.path.join(DOCS_DIR, "JCF Deck.pdf")},
]

# ── JCF Signature (single source of truth) ─────────────────
JCF_SIGNATURE = (
    "Warm regards,\n"
    "Ubhay Anand\n"
    "Partnerships Team, Jarurat Care Foundation\n"
    "partnership@jarurat.care"
)

# ── CC recipients (get CC'd on every outgoing email) ────────
CC_EMAILS = "jarurat.care@gmail.com,shrutijuyal2@gmail.com"

# ── Name Cleaning: titles to strip ─────────────────────────
TITLE_GARBAGE = [
    "assistant professor", "associate professor", "professor",
    "senior resident", "junior resident", "resident",
    "head of department", "hod", "director", "dean",
    "consultant", "sr. consultant", "sr consultant",
    "additional professor", "adjunct professor",
    "clinical fellow", "fellow", "lecturer", "reader",
    "registrar", "sr. registrar", "chief", "incharge",
    "chairman", "chairperson", "coordinator",
]


def validate():
    """Validate required env vars. Exit on failure."""
    required = {
        "ZOHO_CLIENT_ID":     ZOHO_CLIENT_ID,
        "ZOHO_CLIENT_SECRET": ZOHO_CLIENT_SECRET,
        "ZOHO_REFRESH_TOKEN": ZOHO_REFRESH_TOKEN,
        "ZOHO_ACCOUNT_ID":    ZOHO_ACCOUNT_ID,
        "ZOHO_FROM_EMAIL":    ZOHO_FROM_EMAIL,
        "TELEGRAM_BOT_TOKEN": TELEGRAM_BOT_TOKEN,
    }
    optional = {
        "TELEGRAM_GROUP_CHAT_ID": TELEGRAM_GROUP_CHAT_ID,
    }

    def _mask(v):
        return v[:8] + "..." if len(v) > 12 else v[:4] + "..."

    missing = [k for k, v in required.items() if not v or v.startswith("your_")]
    if missing:
        print("❌ Missing required environment variables:")
        for m in missing:
            print(f"   - {m}")
        print("\n   → Fill them in .env and retry.")
        sys.exit(1)

    print("✅ Config loaded:")
    for k, v in required.items():
        print(f"   {k} = {_mask(v)}")
    for k, v in optional.items():
        status = _mask(v) if (v and not v.startswith("WILL_")) else "(auto-detect)"
        print(f"   {k} = {status}")

    # Check PDFs
    for pdf in ATTACHMENT_PDFS:
        exists = os.path.exists(pdf["path"])
        size = os.path.getsize(pdf["path"]) if exists else 0
        status = f"✅ {size/1024:.0f}KB" if exists else "❌ MISSING"
        print(f"   PDF: {pdf['display_name']} {status}")

    print(f"\n   DRAFT_MODEL  = {OLLAMA_DRAFT_MODEL}")
    print(f"   TRIAGE_MODEL = {OLLAMA_TRIAGE_MODEL}\n")


if __name__ == "__main__":
    validate()
