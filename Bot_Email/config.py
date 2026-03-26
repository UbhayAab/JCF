import os
import sys
from dotenv import load_dotenv

load_dotenv()

# ── Zoho Mail ──────────────────────────────────────────────
ZOHO_CLIENT_ID = os.getenv("ZOHO_CLIENT_ID", "")
ZOHO_CLIENT_SECRET = os.getenv("ZOHO_CLIENT_SECRET", "")
ZOHO_REFRESH_TOKEN = os.getenv("ZOHO_REFRESH_TOKEN", "")
ZOHO_ACCOUNT_ID = os.getenv("ZOHO_ACCOUNT_ID", "")
ZOHO_FROM_EMAIL = os.getenv("ZOHO_FROM_EMAIL", "")

# ── Telegram ───────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_GROUP_CHAT_ID = os.getenv("TELEGRAM_GROUP_CHAT_ID", "")

# ── Gemini (Role-Based API Keys) ───────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_API_KEY_SPAM = os.getenv("GEMINI_API_KEY_SPAM", "") or GEMINI_API_KEY
GEMINI_API_KEY_REPLY = os.getenv("GEMINI_API_KEY_REPLY", "") or GEMINI_API_KEY
GEMINI_API_KEY_FOLLOWUP = os.getenv("GEMINI_API_KEY_FOLLOWUP", "") or GEMINI_API_KEY
GEMINI_API_KEY_COLD = os.getenv("GEMINI_API_KEY_COLD", "") or GEMINI_API_KEY

# ── Constants ──────────────────────────────────────────────
POLL_INTERVAL_SECONDS = 60       # How often to check for new emails
BULK_SEND_DELAY_MIN = 5          # Min seconds between bulk emails
BULK_SEND_DELAY_MAX = 10         # Max seconds between bulk emails
ZOHO_API_BASE = "https://mail.zoho.in/api"
ZOHO_AUTH_BASE = "https://accounts.zoho.in/oauth/v2"

# ── Paths ──────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROMPTS_DIR = os.path.join(BASE_DIR, "prompts")
DATA_DIR = os.path.join(BASE_DIR, "data")
POSITIVE_PROMPT_PATH = os.path.join(PROMPTS_DIR, "positive_prompt.txt")
NEGATIVE_PROMPT_PATH = os.path.join(PROMPTS_DIR, "negative_prompt.txt")
SYSTEM_PROMPT_PATH = os.path.join(PROMPTS_DIR, "system_prompt.txt")  # legacy fallback
INITIAL_TEMPLATE_PATH = os.path.join(PROMPTS_DIR, "initial_email_template.txt")
EMAIL_LIST_PATH = os.path.join(DATA_DIR, "email_list.txt")


def validate():
    """Validate that all required env vars are set. Prints status and exits on error."""
    required = {
        "ZOHO_CLIENT_ID": ZOHO_CLIENT_ID,
        "ZOHO_CLIENT_SECRET": ZOHO_CLIENT_SECRET,
        "ZOHO_REFRESH_TOKEN": ZOHO_REFRESH_TOKEN,
        "ZOHO_ACCOUNT_ID": ZOHO_ACCOUNT_ID,
        "ZOHO_FROM_EMAIL": ZOHO_FROM_EMAIL,
        "TELEGRAM_BOT_TOKEN": TELEGRAM_BOT_TOKEN,
        "GEMINI_API_KEY": GEMINI_API_KEY,
    }
    
    # Group Chat ID is optional at startup (auto-detect mode)
    optional = {
        "TELEGRAM_GROUP_CHAT_ID": TELEGRAM_GROUP_CHAT_ID,
    }

    missing = [k for k, v in required.items() if not v or v.startswith("PASTE") or v == "your_"]
    
    if missing:
        print("❌ Missing required environment variables:")
        for m in missing:
            print(f"   - {m}")
        print("\n   → Fill them in .env file and retry.")
        sys.exit(1)
    
    print("✅ All required config loaded:")
    for k, v in required.items():
        masked = v[:8] + "..." if len(v) > 12 else v[:4] + "..."
        print(f"   {k} = {masked}")
    
    for k, v in optional.items():
        if v and not v.startswith("WILL_"):
            masked = v[:8] + "..." if len(v) > 12 else v[:4] + "..."
            print(f"   {k} = {masked}")
        else:
            print(f"   {k} = (will auto-detect)")
    
    print()


if __name__ == "__main__":
    validate()
