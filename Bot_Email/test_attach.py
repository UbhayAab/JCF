"""Test: Upload all 3 PDFs and send with attachments"""
import zoho_logic, config, requests, os, json

z = zoho_logic.ZohoMailService()
z._ensure_token()

pdfs = [
    ("Horizon_Series_Deck.pdf", os.path.join(config.DOCS_DIR, "Horizon Deck .pdf")),
    ("Event_Summary.pdf", os.path.join(config.DOCS_DIR, "Horizon I Event Summary_July25.pdf")),
    ("JCF_Foundation_Profile.pdf", os.path.join(config.DOCS_DIR, "JCF Deck.pdf")),
]

# Step 1: Upload all PDFs
uploaded = []
url = z._url("messages/attachments") + "?uploadType=multipart&isInline=false"

for display_name, path in pdfs:
    if not os.path.exists(path):
        print(f"MISSING: {path}")
        continue
    print(f"Uploading {display_name} ({os.path.getsize(path)} bytes)...")
    with open(path, "rb") as f:
        r = requests.post(url, headers=z._headers(), files={"attach": (display_name, f, "application/pdf")}, timeout=120)
        if r.status_code == 200:
            data = r.json().get("data", [])
            if isinstance(data, list) and data:
                info = data[0]
            elif isinstance(data, dict):
                info = data
            else:
                print(f"  Unexpected response: {r.text[:200]}")
                continue
            uploaded.append({
                "storeName": info["storeName"],
                "attachmentName": info["attachmentName"],
                "attachmentPath": info["attachmentPath"],
            })
            print(f"  ✅ Uploaded: {info['attachmentName']}")
        else:
            print(f"  ❌ Failed: {r.status_code} {r.text[:200]}")

print(f"\nUploaded {len(uploaded)} attachments")
print(json.dumps(uploaded, indent=2))

# Step 2: Send email with attachments
if uploaded:
    body = (
        "<div style='font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;'>"
        "<p>Hello,</p>"
        "<p>This is a test email with PDF attachments from the JCF Bot v4.</p>"
        "<p>Please find the Horizon Series materials attached.</p>"
        "<br>"
        "<p>Warm regards,<br>Ubhay Anand<br>Partnerships Team, Jarurat Care Foundation<br>partnership@jarurat.care</p>"
        "</div>"
    )
    
    payload = {
        "fromAddress": config.ZOHO_FROM_EMAIL,
        "toAddress": "jarurat.care@gmail.com",
        "subject": "TEST: Email with 3 PDF attachments",
        "content": body,
        "mailFormat": "html",
        "askReceipt": "no",
        "attachments": uploaded,
    }
    
    print("\nSending email with attachments...")
    res = z._post("messages", payload)
    print("Send result:", json.dumps(res.get("status", {}), indent=2))
