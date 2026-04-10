import asyncio
import os
import csv
import logging
import drip_campaign
import ai_orchestrator
import config

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("bulk_verification")

async def generate_50_drafts():
    """Generates 50 draft emails for the user to review from output.csv."""
    csv_path = os.path.join(config.BASE_DIR, "output.csv")
    output_path = os.path.join(config.BASE_DIR, "outputs", "draft_review_batch.txt")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    leads = []
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if i >= 50: break
            # Schema: Email, Name, Phone, Rank, Source
            if len(row) >= 5:
                leads.append({
                    "email": row[0],
                    "name": row[1],
                    "source": row[4]
                })

    logger.info(f"🚀 Starting bulk generation for {len(leads)} leads...")
    
    with open(output_path, "w", encoding="utf-8") as out:
        out.write("EQUIPMENT: Horizon Series outreach verification\n")
        out.write("BATCH SIZE: 50\n")
        out.write("="*80 + "\n\n")
        
        for i, lead in enumerate(leads):
            logger.info(f"📝 Draft {i+1}/50: {lead['email']}")
            org_type = drip_campaign.get_organization_type(lead['source'])
            clean_name = ai_orchestrator.smart_name_clean(lead['name'], lead['email'])
            
            prompt = drip_campaign.get_drip_prompt(clean_name, org_type, 0)
            # Use smart_reply to get the actual body
            body, _ = ai_orchestrator.smart_reply(prompt)
            
            out.write(f"DRAFT #{i+1}\n")
            out.write(f"TO: {lead['email']}\n")
            out.write(f"ORG TYPE: {org_type}\n")
            out.write("-" * 20 + "\n")
            out.write(body + "\n")
            out.write("="*80 + "\n\n")
            out.flush() # Force write for immediate review
            
            # Short sleep to prevent Ollama overload (local machine safety)
            await asyncio.sleep(0.5)

    logger.info(f"✅ Batch complete. Review at: {output_path}")

if __name__ == "__main__":
    asyncio.run(generate_50_drafts())
