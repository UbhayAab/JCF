"""
Zoho Mail API Service (Refactored Logic Layer)
Handles OAuth token refresh, fetching emails, reading threads, and sending replies.
"""

import os
import json
import time
import requests
import html
import config

class ZohoMailService:
    def __init__(self):
        self.client_id = config.ZOHO_CLIENT_ID
        self.client_secret = config.ZOHO_CLIENT_SECRET
        self.refresh_token = config.ZOHO_REFRESH_TOKEN
        self.account_id = str(config.ZOHO_ACCOUNT_ID).strip().strip("/")
        self.from_email = config.ZOHO_FROM_EMAIL
        self.access_token = None
        self.token_expiry = 0
        self.token_cache_file = os.path.join(config.BASE_DIR, "zoho_token.json")
        self.seen_ids_file = os.path.join(config.DATA_DIR, "seen_ids.txt")
        self.seen_message_ids = set()
        self._load_cached_token()
        self._load_seen_ids()

    def _load_seen_ids(self):
        """Load previously processed message IDs from disk."""
        if os.path.exists(self.seen_ids_file):
            try:
                with open(self.seen_ids_file, "r") as f:
                    self.seen_message_ids = set(line.strip() for line in f if line.strip())
                print(f"✅ Loaded {len(self.seen_message_ids)} processed message IDs from cache.")
            except Exception as e:
                print(f"⚠️ Failed to load seen_ids: {e}")

    def _save_seen_id(self, message_id):
        """Append a newly processed message ID to the persistent cache."""
        try:
            os.makedirs(os.path.dirname(self.seen_ids_file), exist_ok=True)
            with open(self.seen_ids_file, "a") as f:
                f.write(f"{str(message_id).strip()}\n")
        except Exception as e:
            print(f"⚠️ Failed to save seen_id {message_id}: {e}")

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
            raise Exception(f"Zoho auth error: {data['error']}")
        
        self.access_token = data["access_token"]
        self.token_expiry = time.time() + data.get("expires_in", 3600) - 60
        self._save_cached_token()
        print("✅ Zoho access token refreshed.")

    def _headers(self):
        self._ensure_access_token()
        return {"Authorization": f"Zoho-oauthtoken {self.access_token}"}

    def _api_url(self, path):
        # 1. Base URL construction
        base = "https://mail.zoho.in/api"
        # 2. Strict ID sanitization
        acc_id = str(self.account_id).strip("/")
        # 3. Force clean 'accounts' string (No triple-c)
        url = f"{base}/accounts/{acc_id}/{path}"
        # 4. Final safety replace (Fix typo ghost)
        url = url.replace("acccounts", "accounts")
        # 5. Global Double-Slash Kill
        return url.replace("https://", "HTTPS_TEMP").replace("//", "/").replace("HTTPS_TEMP", "https://")

    def _api_get(self, path, params=None):
        resp = requests.get(self._api_url(path), headers=self._headers(), params=params)
        if resp.status_code == 401:
            self.access_token = None
            resp = requests.get(self._api_url(path), headers=self._headers(), params=params)
        resp.raise_for_status()
        return resp.json()

    def _api_post(self, path, json_data=None):
        resp = requests.post(self._api_url(path), headers=self._headers(), json=json_data)
        if resp.status_code == 401:
            self.access_token = None
            resp = requests.post(self._api_url(path), headers=self._headers(), json=json_data)
        
        if resp.status_code >= 400:
            print(f"❌ Zoho API Error ({resp.status_code}): {resp.text}")
            
        resp.raise_for_status()
        return resp.json()

    def _api_put(self, path, json_data=None):
        resp = requests.put(self._api_url(path), headers=self._headers(), json=json_data)
        if resp.status_code == 401:
            self.access_token = None
            resp = requests.put(self._api_url(path), headers=self._headers(), json=json_data)
        resp.raise_for_status()
        return resp.json()

    # ── Fetch Emails ───────────────────────────────────────

    def get_folder_id(self, folder_name="Inbox"):
        data = self._api_get("folders")
        for folder in data.get("data", []):
            if folder.get("folderName", "").lower() == folder_name.lower():
                return folder["folderId"]
        return None

    def fetch_unread_emails(self):
        folder_id = self.get_folder_id("Inbox")
        if not folder_id: return []
        
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
                self._save_seen_id(msg_id)
                new_emails.append(email)
        return new_emails

    # ── Read Thread ────────────────────────────────────────

    def get_email_content(self, message_id):
        """Global content fetch."""
        try:
            data = self._api_get(f"messages/{str(message_id).strip()}/content")
            return data.get("data", {}).get("content", "")
        except Exception as e:
            print(f"⚠️ Content 404 for {message_id}: {e}")
            return "[Content Unavailable]"

    def get_email_thread(self, message_id):
        """Returns tuple (thread_text, last_sender)."""
        msg_id_str = str(message_id).strip()
        last_sender = "Unknown"
        target_email = "Unknown"
        subject = "No Subject"
        
        try:
            # 1. Get current message metadata
            msg_data = self._api_get(f"messages/{msg_id_str}")
            msg_info = msg_data.get("data", {})
            subject = msg_info.get("subject", "No Subject")
            target_email = msg_info.get("fromAddress", "Unknown")
            
            if target_email.lower() == self.from_email.lower():
                target_email = msg_info.get("toAddress", "Unknown")
            
            # 2. Build thread by searching Inbox & Sent for this contact
            inbox_id = self.get_folder_id("Inbox")
            sent_id = self.get_folder_id("Sent")
            
            inbox_msgs = []
            sent_msgs = []
            try:
                if inbox_id: inbox_msgs = self._api_get("messages/view", params={"limit": 50, "folderId": inbox_id}).get("data", [])
                if sent_id: sent_msgs = self._api_get("messages/view", params={"limit": 50, "folderId": sent_id}).get("data", [])
            except: pass
            
            all_msgs = inbox_msgs + sent_msgs
            filtered = []
            for m in all_msgs:
                if target_email.lower() in m.get("fromAddress", "").lower() or target_email.lower() in m.get("toAddress", "").lower():
                    filtered.append(m)
            
            # Sort chronologically
            unique_msgs = {m.get("messageId"): m for m in filtered}.values()
            messages = sorted(unique_msgs, key=lambda x: int(x.get("receivedTime", "0")))
            
            if not messages:
                # Fallback to single message
                content = self.get_email_content(msg_id_str)
                return f"From: {target_email}\nSubject: {subject}\n\n{content}", target_email

            # 3. Build thread text
            thread_parts = []
            for m in messages:
                m_sender = m.get("fromAddress", "Unknown")
                m_content = self.get_email_content(m["messageId"]) if m["messageId"] != msg_id_str else self.get_email_content(msg_id_str)
                thread_parts.append(f"--- Message ---\nFrom: {m_sender}\nSubject: {m.get('subject')}\nDate: {m.get('receivedTime')}\n\n{m_content}\n")
            
            # Determine last sender
            last_msg = messages[-1]
            last_sender_raw = html.unescape(last_msg.get("fromAddress", "Unknown"))
            if "<" in last_sender_raw:
                last_sender = last_sender_raw.split("<")[1].split(">")[0].strip().lower()
            else:
                last_sender = last_sender_raw.lower()
            
            return "\n".join(thread_parts), last_sender

        except Exception as e:
            print(f"⚠️ get_email_thread failed: {e}")
            return f"From: {target_email}\nSubject: {subject}\n\n[Thread Construction Failed]", target_email

    # ── Send & Update ──────────────────────────────────────

    def upload_attachment(self, file_path):
        """Uploads a local file to Zoho File Store and returns attachment metadata."""
        if not os.path.exists(file_path):
            print(f"❌ File not found: {file_path}")
            return None
            
        url = self._api_url("messages/attachments")
        file_name = os.path.basename(file_path)
        
        with open(file_path, "rb") as f:
            files = {"attach": (file_name, f, "application/pdf")}
            resp = requests.post(url, headers=self._headers(), files=files)
            
        resp.raise_for_status()
        data = resp.json().get("data", [])
        if data:
            print(f"📎 Attached {file_name} (ID: {data[0].get('attachmentId')})")
            return data[0]
        return None

    def send_new_email(self, to_email, subject, body_html, attachments=None):
        """Sends email with optional attachments (list of local paths)."""
        attachment_data = []
        if attachments:
            for path in attachments:
                meta = self.upload_attachment(path)
                if meta: attachment_data.append(meta)

        payload = {
            "fromAddress": self.from_email,
            "toAddress": to_email,
            "subject": subject,
            "content": body_html,
        }
        if attachment_data:
            payload["attachments"] = attachment_data
            
        return self._api_post("messages", json_data=payload)

    def send_reply(self, message_id, reply_content, attachments=None):
        """Sends reply with optional attachments."""
        attachment_data = []
        if attachments:
            for path in attachments:
                meta = self.upload_attachment(path)
                if meta: attachment_data.append(meta)

        msg_data = self._api_get(f"messages/{message_id}")
        msg_info = msg_data.get("data", {})
        to_address = msg_info.get("fromAddress")
        subject = msg_info.get("subject", "")
        if not subject.lower().startswith("re:"): subject = f"Re: {subject}"

        payload = {
            "fromAddress": self.from_email,
            "toAddress": to_address,
            "subject": subject,
            "content": reply_content,
            "action": "reply",
            "inReplyTo": message_id,
        }
        if attachment_data:
            payload["attachments"] = attachment_data
            
        return self._api_post("messages", json_data=payload)

    def mark_as_read(self, message_id):
        payload = {"mode": "markAsRead", "messageId": [str(message_id).strip()]}
        try:
            self._api_put("updatemessage", json_data=payload)
        except: pass
