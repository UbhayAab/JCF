import asyncio
from drip_campaign import run_drip_campaign
import zoho_logic
import telegram_bot
import logging

logging.basicConfig(level=logging.INFO)

async def sweep():
    zoho = zoho_logic.ZohoMailService()
    app = telegram_bot.build_telegram_app()
    print('🚀 STARTING IMMEDIATE 50-LEAD SWEEP (PHASE 27)...')
    # Run a sweep on 50 leads using exclusively Local AI
    await run_drip_campaign(app, zoho, limit=50)

if __name__ == "__main__":
    asyncio.run(sweep())
