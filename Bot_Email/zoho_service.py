"""
Zoho Mail API Service
Handles OAuth token refresh, fetching emails, reading threads, and sending replies.
"""

import os
import json
import time
import requests
import config

class ZohoMailService:
    def __init__(self):
        self.client_id = config.ZOHO_CLIENT_ID
        self.client_secret = config.ZOHO_CLIENT_SECRET
        self.refresh_token = config.ZOHO_REFRESH_TOKEN
        self.account_id = config.ZOHO_ACCOUNT_ID
        self.from_email = config.ZOHO_FROM_EMAIL
        self.access_token = None
        self.token_expiry = 0
        self.seen_message_ids = set()  # Deduplicate within a session
        self.token_cache_file = os.path.join(config.BASE_DIR, "zoho_token.json")
        self._load_cached_token()

    def _load_cached_token(self):
        """Load the access token from a local cache file if valid."""
        if os.path.exists(self.token_cache_file):
            try:
                with open(self.token_cache_file, "r") as f:
                    data = json.load(f)
                    if data.get("expiry", 0) > time.time() + 60:
                        self.access_token = data.get("access_token")
                        self.token_expiry = data.get("expiry")
            except Exception as e:
                print(f"⚠️ Failed to load cached token: {e}")

    def _save_cached_token(self):
        """Save the access token to a local cache file."""
        try:
            with open(self.token_cache_file, "w") as f:
                json.dump({
                    "access_token": self.access_token,
                    "expiry": self.token_expiry
                }, f)
        except Exception as e:
            print(f"⚠️ Failed to save token cache: {e}")

    # ── Auth ───────────────────────────────────────────────

    def _ensure_access_token(self):
        """Refresh access token if expired or missing."""
        if self.access_token and time.time() < self.token_expiry:
            return
        
        print("🔄 Refreshing Zoho access token...")
        resp = requests.post(
            f"{config.ZOHO_AUTH_BASE}/token",
            data={
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": self.refresh_token,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        
        if "error" in data:
            raise Exception(f"Zoho auth error: {data['error']} (If rate limited, wait 10 mins)")
        
        self.access_token = data["access_token"]
        self.token_expiry = time.time() + data.get("expires_in", 3600) - 60  # 1 min buffer
        self._save_cached_token()
        print("✅ Zoho access token refreshed and cached.")

    def _headers(self):
        self._ensure_access_token()
        return {"Authorization": f"Zoho-oauthtoken {self.access_token}"}

    def _api_url(self, path):
        return f"{config.ZOHO_API_BASE}/accounts/{self.account_id}/{path}"

    def _api_get(self, path, params=None):
        """GET request with 1 auto-retry on 401."""
        resp = requests.get(self._api_url(path), headers=self._headers(), params=params)
        if resp.status_code == 401:
            print("⚠️ 401 Unauthorized — attempting to refresh token once...")
            self.access_token = None  # Force refresh
            resp = requests.get(self._api_url(path), headers=self._headers(), params=params)
            if resp.status_code == 401:
                raise Exception(f"401 Unauthorized even after refresh. Check scopes! {resp.text}")
        resp.raise_for_status()
        return resp.json()

    def _api_post(self, path, json_data=None):
        """POST request with 1 auto-retry on 401."""
        resp = requests.post(self._api_url(path), headers=self._headers(), json=json_data)
        if resp.status_code == 401:
            print("⚠️ 401 Unauthorized — attempting to refresh token once...")
            self.access_token = None
            resp = requests.post(self._api_url(path), headers=self._headers(), json=json_data)
            if resp.status_code == 401:
                raise Exception(f"401 Unauthorized even after refresh. Check scopes! {resp.text}")
        resp.raise_for_status()
        return resp.json()

    def _api_put(self, path, json_data=None):
        """PUT request with 1 auto-retry on 401."""
        resp = requests.put(self._api_url(path), headers=self._headers(), json=json_data)
        if resp.status_code == 401:
            print("⚠️ 401 Unauthorized — attempting to refresh token once...")
            self.access_token = None
            resp = requests.put(self._api_url(path), headers=self._headers(), json=json_data)
            if resp.status_code == 401:
                raise Exception(f"401 Unauthorized even after refresh. Check scopes! {resp.text}")
        resp.raise_for_status()
        return resp.json()

    # ── Fetch Emails ───────────────────────────────────────

    def get_folder_id(self, folder_name="Inbox"):
        """Get the folder ID for a given folder name."""
        data = self._api_get("folders")
        for folder in data.get("data", []):
            if folder.get("folderName", "").lower() == folder_name.lower():
                return folder["folderId"]
        raise Exception(f"Folder '{folder_name}' not found. Available: {[f['folderName'] for f in data.get('data', [])]}")

    def fetch_unread_emails(self):
        """
        Fetch unread emails from inbox. 
        Returns list of new (unseen-this-session) email dicts.
        """
        try:
            folder_id = self.get_folder_id("Inbox")
        except Exception as e:
            print(f"⚠️ Could not get folder ID: {e}")
            return []

        data = self._api_get("messages/view", params={
            "folderId": folder_id,
            "status": "unread",
            "limit": 20,
        })

        emails = data.get("data", [])
        new_emails = []
        for email in emails:
            msg_id = email.get("messageId")
            if msg_id and msg_id not in self.seen_message_ids:
                self.seen_message_ids.add(msg_id)
                new_emails.append(email)
        
        return new_emails

    # ── Read Thread ────────────────────────────────────────

    def get_email_content(self, message_id):
        """Get full content of a single email."""
        data = self._api_get(f"messages/{message_id}/content")
        return data.get("data", {}).get("content", "")

    def get_email_thread(self, message_id):
        """
        Get the full conversation thread for context.
        Returns a formatted string of all messages in the thread.
        """
        # First get the message to find its thread ID
        msg_data = self._api_get(f"messages/{message_id}")
        msg_info = msg_data.get("data", {})
        
        thread_id = msg_info.get("threadId", message_id)
        
        # Fetch all messages in this thread
        thread_data = self._api_get("messages/view", params={
            "threadId": thread_id,
            "limit": 50,
        })
        
        messages = thread_data.get("data", [])
        
        if not messages:
            # Fallback: just get this single message
            content = self.get_email_content(message_id)
            sender = msg_info.get("fromAddress", "Unknown")
            subject = msg_info.get("subject", "No Subject")
            return f"From: {sender}\nSubject: {subject}\n\n{content}"
        
        # Build thread text (oldest first)
        thread_parts = []
        for msg in reversed(messages):
            sender = msg.get("fromAddress", "Unknown")
            subject = msg.get("subject", "")
            received = msg.get("receivedTime", "")
            
            # Get content for each message
            try:
                content = self.get_email_content(msg["messageId"])
            except Exception:
                content = msg.get("summary", "[Could not fetch content]")
            
            thread_parts.append(
                f"--- Message ---\n"
                f"From: {sender}\n"
                f"Subject: {subject}\n"
                f"Date: {received}\n"
                f"\n{content}\n"
            )
        
        return "\n".join(thread_parts)

    # ── Send ───────────────────────────────────────────────

    def send_reply(self, message_id, reply_content):
        """Send a reply to a specific email."""
        # Get original message info
        msg_data = self._api_get(f"messages/{message_id}")
        msg_info = msg_data.get("data", {})
        
        to_address = msg_info.get("fromAddress", "")
        subject = msg_info.get("subject", "")
        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"

        payload = {
            "fromAddress": self.from_email,
            "toAddress": to_address,
            "subject": subject,
            "content": reply_content,
            "action": "reply",
            "inReplyTo": message_id,
        }

        result = self._api_post("messages", json_data=payload)
        print(f"✅ Reply sent to {to_address}")
        return result

    def send_new_email(self, to_email, subject, body_html):
        """Send a new email (for initial outreach)."""
        payload = {
            "fromAddress": self.from_email,
            "toAddress": to_email,
            "subject": subject,
            "content": body_html,
        }
        result = self._api_post("messages", json_data=payload)
        print(f"✅ Email sent to {to_email}")
        return result

    def mark_as_read(self, message_id):
        """Mark a message as read."""
        try:
            self._api_put(f"messages/{message_id}", json_data={"isRead": "true"})
        except Exception as e:
            print(f"⚠️ Could not mark message {message_id} as read: {e}")


# ── Standalone test ────────────────────────────────────────
if __name__ == "__main__":
    config.validate()
    zoho = ZohoMailService()
    
    print("\n📬 Fetching unread emails...")
    emails = zoho.fetch_unread_emails()
    
    if not emails:
        print("   No unread emails found.")
    else:
        print(f"   Found {len(emails)} unread email(s):\n")
        for e in emails[:5]:
            sender = e.get("fromAddress", "?")
            subject = e.get("subject", "?")
            print(f"   📧 From: {sender}")
            print(f"      Subject: {subject}")
            print()
