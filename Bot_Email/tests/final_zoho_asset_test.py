from zoho_logic import ZohoMailService
import os
import config
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("final_test")

def verify_zoho_phase25():
    zoho = ZohoMailService()
    file_path = os.path.join(config.BASE_DIR, 'Docs', 'JCF Deck.pdf')
    
    if not os.path.exists(file_path):
        logger.error(f"❌ File not found: {file_path}")
        return

    logger.info(f"🚀 PHASE 25 Diagnostic: {os.path.basename(file_path)}")
    try:
        # This calls the refined logic using 'file' field and fileName URL param
        meta = zoho.upload_attachment(file_path)
        if meta:
            logger.info(f"✅ FINAL SUCCESS! Attachment ID: {meta.get('attachmentId')}")
            return True
        else:
            logger.error("❌ UPLOAD RETURNED EMPTY DATA")
    except Exception as e:
        logger.error(f"🔥 FATAL UPLOAD ERROR: {e}")
    return False

if __name__ == "__main__":
    verify_zoho_phase25()
