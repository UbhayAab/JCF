import config
from zoho_service import ZohoMailService

def test_send():
    config.validate()
    zoho = ZohoMailService()
    
    print("\nAttempting to send a test email...")
    try:
        data = zoho.send_new_email(
            "ubhayvatsaanand@gmail.com",
            "Test from Bot",
            "This is a test message to verify sending permissions."
        )
        print("✅ SUCCESS!")
        print(data)
    except Exception as e:
        print(f"❌ FAILED: {e}")

if __name__ == "__main__":
    test_send()
