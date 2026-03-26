"""Get Telegram group chat ID from bot updates."""
import requests

TOKEN = "8573008182:AAGxUlD41vrxXE5KdUVM-qwAAdmPPGrquhM"
r = requests.get(f"https://api.telegram.org/bot{TOKEN}/getUpdates")
data = r.json()

print(f"OK: {data.get('ok')}")
print(f"Updates: {len(data.get('result', []))}\n")

found = False
for u in data.get("result", []):
    if "message" in u:
        chat = u["message"]["chat"]
        if chat["type"] in ("group", "supergroup"):
            print(f"=== GROUP FOUND ===")
            print(f"Chat ID: {chat['id']}")
            print(f"Title: {chat.get('title', 'N/A')}")
            print(f"Type: {chat['type']}")
            print(f"===================")
            
            # Update .env
            chat_id = str(chat["id"])
            with open(".env", "r") as f:
                content = f.read()
            content = content.replace("TELEGRAM_GROUP_CHAT_ID=WILL_AUTO_DETECT", 
                                      f"TELEGRAM_GROUP_CHAT_ID={chat_id}")
            with open(".env", "w") as f:
                f.write(content)
            print(f"\nUpdated .env with Group Chat ID: {chat_id}")
            found = True
            break

if not found:
    print("No group chat found in recent updates.")
    print("Please send /start in the Telegram group with the bot, then run this again.")
