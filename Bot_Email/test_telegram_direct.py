import asyncio
import config
import telegram_bot
from gemini_service import classify_email, generate_reply

async def test_telegram_direct():
    config.validate()
    print("Building app...")
    app = telegram_bot.build_telegram_app()
    await app.initialize()
    await app.start()
    
    print("Testing direct message to group...")
    try:
        await telegram_bot.send_notification(
            app, 
            "👋 <b>TEST MESSAGE FROM BOT</b>\n\nIf you see this, the Telegram connection is working perfectly!"
        )
        print("✅ Direct message sent successfully.")
    except Exception as e:
        print(f"❌ Failed to send message: {e}")

    print("\nSimulating an email flow...")
    dummy_email_thread = (
        "--- Message ---\n"
        "From: dr.smith@example.com\n"
        "Subject: RE: Invitation to Medical Conference — 23rd May 2025\n\n"
        "Hello, thank you for the invite. I would love to attend, but could you tell me if there is parking available at the venue?\n\nBest, Dr. Smith"
    )
    
    print("1. Classifying email...")
    is_relevant = classify_email(dummy_email_thread)
    
    if is_relevant:
        print("✅ Classified as relevant. Generating reply...")
        draft = generate_reply(dummy_email_thread)
        
        print("2. Sending simulated AI flow to Telegram...")
        msg = (
            f"🧪 <b>SIMULATED EMAIL TEST</b>\n\n"
            f"<b>From:</b> dr.smith@example.com\n"
            f"<b>Subject:</b> RE: Invitation to Medical Conference\n\n"
            f"<b>🤖 AI Drafted Response:</b>\n"
            f"{telegram_bot._escape_html(draft)}\n\n"
            f"<i>This was a simulated test to prove the funnel works.</i>"
        )
        await telegram_bot.send_notification(app, msg)
        print("✅ Simulated flow sent to Telegram.")
    else:
        print("❌ Classified as spam (unexpected for this test).")
        
    await app.stop()
    await app.shutdown()

if __name__ == "__main__":
    asyncio.run(test_telegram_direct())
