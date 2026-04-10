"""
Zoho Mail API Service (v5.0 — Real Attachments)

VERIFIED WORKING on Zoho India (mail.zoho.in):
1. Upload PDF via POST multipart → /messages/attachments?uploadType=multipart
2. Include storeName/attachmentPath/attachmentName in send payload's "attachments" array
3. NO ccAddress (causes EXTRA_KEY_FOUND_IN_JSON)
4. Direct POST to /messages sends immediately (no 2-step PUT)
"""

import os
import json
import time
import requests
import logging
import html
import re
import config

logger = logging.getLogger("zoho_logic")


class ZohoMailService:

    def __init__(self):
        self.client_id     = config.ZOHO_CLIENT_ID
        self.client_secret = config.ZOHO_CLIENT_SECRET
        self.refresh_token = config.ZOHO_REFRESH_TOKEN
        self.account_id    = str(config.ZOHO_ACCOUNT_ID).strip().strip("/")
        self.from_email    = config.ZOHO_FROM_EMAIL.strip().lower()
        self.access_token  = None
        self.token_expiry  = 0
        self._token_file   = os.path.join(config.BASE_DIR, "zoho_token.json")
        self._seen_file    = os.path.join(config.DATA_DIR, "seen_ids.txt")
        self.seen_ids      = set()
        self._folder_cache = {}
        self._attachment_cache = None   # Cache uploaded attachment refs
        self._attachment_cache_time = 0 # Timestamp when attachments were uploaded
        self._ATTACHMENT_TTL = 90       # Re-upload every 90s (Zoho expires refs in ~2min)
        self._load_token_cache()
        self._load_seen_ids()

    # ─── Seen IDs ─────────────────────────────────────────────────────────────

    def _load_seen_ids(self):
        if os.path.exists(self._seen_file):
            try:
                with open(self._seen_file, "r") as f:
                    self.seen_ids = set(l.strip() for l in f if l.strip())
                logger.info(f"✅ Loaded {len(self.seen_ids)} seen message IDs")
            except Exception as e:
                logger.warning(f"Could not load seen_ids: {e}")

    def _mark_seen(self, message_id: str):
        sid = str(message_id).strip()
        self.seen_ids.add(sid)
        try:
            os.makedirs(os.path.dirname(self._seen_file), exist_ok=True)
            with open(self._seen_file, "a") as f:
                f.write(f"{sid}\n")
        except Exception as e:
            logger.warning(f"Could not save seen_id: {e}")

    # ─── Auth & Token ─────────────────────────────────────────────────────────

    def _load_token_cache(self):
        if os.path.exists(self._token_file):
            try:
                with open(self._token_file) as f:
                    d = json.load(f)
                    if d.get("expiry", 0) > time.time() + 60:
                        self.access_token = d["access_token"]
                        self.token_expiry = d["expiry"]
            except Exception:
                pass

    def _save_token_cache(self):
        try:
            with open(self._token_file, "w") as f:
                json.dump({"access_token": self.access_token, "expiry": self.token_expiry}, f)
        except Exception as e:
            logger.warning(f"Token cache save failed: {e}")

    def _ensure_token(self):
        if self.access_token and time.time() < self.token_expiry:
            return
        logger.info("🔄 Refreshing Zoho OAuth token...")
        resp = requests.post(
            f"{config.ZOHO_AUTH_BASE}/token",
            data={
                "grant_type":    "refresh_token",
                "client_id":     self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": self.refresh_token,
            },
            timeout=30,
        )
        resp.raise_for_status()
        d = resp.json()
        if "error" in d:
            raise RuntimeError(f"Zoho auth error: {d['error']}")
        self.access_token = d["access_token"]
        self.token_expiry = time.time() + d.get("expires_in", 3600) - 60
        self._save_token_cache()
        logger.info("✅ Zoho token refreshed")

    def _headers(self):
        self._ensure_token()
        return {"Authorization": f"Zoho-oauthtoken {self.access_token}"}

    def _url(self, path: str) -> str:
        acc = self.account_id.strip("/")
        return f"https://mail.zoho.in/api/accounts/{acc}/{path}"

    # ─── HTTP Helpers ─────────────────────────────────────────────────────────

    def _get(self, path: str, params: dict = None) -> dict:
        for attempt in range(2):
            resp = requests.get(self._url(path), headers=self._headers(), params=params, timeout=60)
            if resp.status_code == 401 and attempt == 0:
                self.access_token = None
                continue
            resp.raise_for_status()
            return resp.json()
        return {}

    def _post_json(self, path: str, payload: dict) -> dict:
        """POST JSON. Retries once on 401. Strips optional fields on 400."""
        for attempt in range(2):
            resp = requests.post(self._url(path), headers=self._headers(), json=payload, timeout=120)
            if resp.status_code == 401 and attempt == 0:
                self.access_token = None
                continue
            if resp.status_code == 400 and attempt == 0:
                logger.warning(f"⚠️ POST 400: {resp.text[:300]}. Retrying stripped...")
                stripped = {
                    "fromAddress": payload.get("fromAddress", ""),
                    "toAddress":   payload.get("toAddress", ""),
                    "subject":     payload.get("subject", ""),
                    "content":     payload.get("content", ""),
                    "mailFormat":  payload.get("mailFormat", "html"),
                }
                # Keep attachments if present
                if "attachments" in payload:
                    stripped["attachments"] = payload["attachments"]
                payload = stripped
                continue
            if resp.status_code >= 400:
                logger.error(f"❌ Zoho POST {resp.status_code}: {resp.text[:300]}")
            resp.raise_for_status()
            return resp.json()
        return {}

    def _put(self, path: str, payload: dict = None) -> dict:
        for attempt in range(2):
            resp = requests.put(self._url(path), headers=self._headers(), json=payload, timeout=60)
            if resp.status_code == 401 and attempt == 0:
                self.access_token = None
                continue
            if resp.status_code >= 400:
                logger.error(f"❌ Zoho PUT {resp.status_code}: {resp.text[:200]}")
            resp.raise_for_status()
            return resp.json()
        return {}

    # ─── Folder Helper ────────────────────────────────────────────────────────

    def _folder_id(self, name: str) -> str | None:
        if name in self._folder_cache:
            return self._folder_cache[name]
        try:
            data = self._get("folders")
            for f in data.get("data", []):
                if f.get("folderName", "").lower() == name.lower():
                    self._folder_cache[name] = f["folderId"]
                    return f["folderId"]
        except Exception as e:
            logger.warning(f"Folder lookup failed ({name}): {e}")
        return None

    # ═══════════════════════════════════════════════════════════════════════════
    # ATTACHMENT UPLOAD (verified working on Zoho India)
    # ═══════════════════════════════════════════════════════════════════════════

    def upload_attachments(self, pdf_list: list = None, force: bool = False) -> list:
        """
        Upload PDFs to Zoho file store. Returns list of attachment refs.
        Caches for 1 hour, then re-uploads (Zoho expires upload refs).
        """
        import time as _time
        now = _time.time()
        if not force and self._attachment_cache is not None and (now - self._attachment_cache_time) < self._ATTACHMENT_TTL:
            return self._attachment_cache

        if pdf_list is None:
            pdf_list = config.ATTACHMENT_PDFS

        self._ensure_token()
        uploaded = []
        url = self._url("messages/attachments") + "?uploadType=multipart&isInline=false"

        for pdf in pdf_list:
            display_name = pdf["display_name"]
            path = pdf["path"]

            if not os.path.exists(path):
                logger.warning(f"📎 PDF not found: {path}")
                continue

            try:
                with open(path, "rb") as f:
                    resp = requests.post(
                        url,
                        headers=self._headers(),
                        files={"attach": (display_name, f, "application/pdf")},
                        timeout=180,
                    )

                if resp.status_code == 200:
                    data = resp.json().get("data", [])
                    if isinstance(data, list) and data:
                        info = data[0]
                    elif isinstance(data, dict):
                        info = data
                    else:
                        logger.warning(f"📎 Unexpected upload response for {display_name}")
                        continue

                    uploaded.append({
                        "storeName":      info["storeName"],
                        "attachmentName": info["attachmentName"],
                        "attachmentPath": info["attachmentPath"],
                    })
                    size_kb = os.path.getsize(path) / 1024
                    logger.info(f"📎 Uploaded {display_name} ({size_kb:.0f}KB)")
                else:
                    logger.error(f"📎 Upload failed for {display_name}: {resp.status_code} {resp.text[:200]}")

            except Exception as e:
                logger.error(f"📎 Upload error for {display_name}: {e}")

        self._attachment_cache = uploaded
        import time as _time
        self._attachment_cache_time = _time.time()
        logger.info(f"📎 Total attachments ready: {len(uploaded)} (expires in 1h)")
        return uploaded

    def _invalidate_attachment_cache(self):
        """Force re-upload on next send (used when 500 error occurs)."""
        self._attachment_cache = None
        self._attachment_cache_time = 0

    # ─── Fetch Unread ─────────────────────────────────────────────────────────

    def fetch_unread_emails(self) -> list:
        """Fetch new unread emails, skipping system/own emails and already-seen IDs."""
        fid = self._folder_id("Inbox")
        if not fid:
            logger.error("Could not find Inbox folder")
            return []

        try:
            data = self._get("messages/view", params={"folderId": fid, "status": "unread", "limit": 20})
        except Exception as e:
            logger.error(f"fetch_unread_emails failed: {e}")
            return []

        SKIP_DOMAINS = (
            "noreply@", "no-reply@", "mailer-daemon", "postmaster@",
            "do-not-reply@", "donotreply@", "zohocalendar", "zohomail",
            "accounts.google.com", "bounce", "notifications@",
        )

        new_emails = []
        for msg in data.get("data", []):
            msg_id    = str(msg.get("messageId", "")).strip()
            from_addr = msg.get("fromAddress", "").lower()

            if any(skip in from_addr for skip in SKIP_DOMAINS):
                self.mark_as_read(msg_id)
                self._mark_seen(msg_id)
                continue

            if self.from_email in from_addr:
                self.mark_as_read(msg_id)
                self._mark_seen(msg_id)
                continue

            if msg_id in self.seen_ids:
                continue

            self._mark_seen(msg_id)
            new_emails.append(msg)

        return new_emails

    # ─── Thread Construction ──────────────────────────────────────────────────

    def get_email_thread(self, message_id: str):
        """Returns (thread_text, last_sender_email, last_message_is_from_us)."""
        msg_id_str  = str(message_id).strip()
        last_sender = "unknown"
        from_us     = False

        try:
            msg_data = self._get(f"messages/{msg_id_str}")
            msg_info = msg_data.get("data", {})
            subject      = msg_info.get("subject", "No Subject")
            target_email = msg_info.get("fromAddress", "unknown").lower()
            thread_id    = msg_info.get("threadId", "")

            if "<" in target_email:
                target_email = target_email.split("<")[1].split(">")[0].strip()

            if self.from_email in target_email:
                from_content = self.get_email_content(msg_id_str)
                return f"[OWN EMAIL]\nSubject: {subject}\n\n{from_content}", self.from_email, True

            thread_messages = []
            if thread_id:
                try:
                    t_data = self._get("messages/view", params={"threadId": thread_id, "limit": 50})
                    thread_messages = t_data.get("data", [])
                except Exception:
                    pass

            if not thread_messages:
                inbox_id = self._folder_id("Inbox")
                sent_id  = self._folder_id("Sent")
                all_msgs = []
                try:
                    if inbox_id:
                        all_msgs += self._get("messages/view", params={"folderId": inbox_id, "limit": 50}).get("data", [])
                    if sent_id:
                        all_msgs += self._get("messages/view", params={"folderId": sent_id, "limit": 50}).get("data", [])
                except Exception:
                    pass
                for m in all_msgs:
                    mfrom = m.get("fromAddress", "").lower()
                    mto   = m.get("toAddress", "").lower()
                    if target_email in mfrom or target_email in mto:
                        thread_messages.append(m)

            unique = {m.get("messageId"): m for m in thread_messages}
            try:
                messages = sorted(unique.values(), key=lambda x: int(x.get("messageId", "0")))
            except Exception:
                messages = list(unique.values())

            thread_parts = []
            for m in messages:
                m_id    = str(m.get("messageId", ""))
                m_from  = m.get("fromAddress", "Unknown")
                m_subj  = m.get("subject", "No Subject")
                content = self.get_email_content(m_id)
                thread_parts.append(f"--- Message ---\nFrom: {m_from}\nSubject: {m_subj}\n\n{content}\n")

            if messages:
                last_msg = messages[-1]
                raw_from = html.unescape(last_msg.get("fromAddress", "unknown"))
                if "<" in raw_from:
                    last_sender = raw_from.split("<")[1].split(">")[0].strip().lower()
                else:
                    last_sender = raw_from.strip().lower()
                from_us = (self.from_email in last_sender)
            else:
                content = self.get_email_content(msg_id_str)
                thread_parts = [f"From: {target_email}\nSubject: {subject}\n\n{content}"]
                last_sender = target_email
                from_us = False

            full_thread = "\n".join(thread_parts) if thread_parts else f"[No thread content]"
            return full_thread, last_sender, from_us

        except Exception as e:
            # 404s are expected for deleted/moved messages — don't spam logs
            if "404" in str(e):
                logger.debug(f"get_email_thread: message {msg_id_str} not found (deleted/moved)")
            else:
                logger.error(f"get_email_thread failed for {msg_id_str}: {e}")
            return f"[Thread error: {e}]", "unknown", False

    # ─── Content Fetch ────────────────────────────────────────────────────────

    def get_email_content(self, message_id: str) -> str:
        try:
            data = self._get(f"messages/{str(message_id).strip()}/content")
            raw = data.get("data", {}).get("content", "")
            clean = re.sub(r'<[^>]+>', ' ', raw)
            clean = re.sub(r'&[a-z]+;', ' ', clean)
            clean = re.sub(r'\s+', ' ', clean).strip()
            return clean or "[Empty content]"
        except Exception as e:
            logger.warning(f"get_email_content failed for {message_id}: {e}")
            return "[Content unavailable]"

    # ═══════════════════════════════════════════════════════════════════════════
    # SEND EMAIL — with real PDF attachments
    # ═══════════════════════════════════════════════════════════════════════════

    def _build_html(self, body_text: str) -> str:
        """Convert plain text to proper HTML with <br> for newlines."""
        # Replace actual newlines with <br>
        html_body = body_text.replace("\n", "<br>\n")
        return (
            f"<div style='font-family: Arial, sans-serif; font-size: 14px; "
            f"line-height: 1.6; color: #333;'>{html_body}</div>"
        )

    def send_new_email(self, to_email: str, subject: str, body_text: str, attach: bool = True) -> dict | None:
        """
        Send email with real PDF attachments + CC.
        Retries once with fresh upload on 500 (expired attachment refs).
        """
        for attempt in range(2):
            attachments = self.upload_attachments(force=(attempt > 0)) if attach else []

            payload = {
                "fromAddress": config.ZOHO_FROM_EMAIL,
                "toAddress":   to_email,
                "subject":     subject,
                "content":     self._build_html(body_text),
                "mailFormat":  "html",
                "askReceipt":  "no",
            }
            # CC — only if config has CC emails
            if config.CC_EMAILS:
                payload["ccAddress"] = config.CC_EMAILS
            if attachments:
                payload["attachments"] = attachments

            try:
                res = self._post_json("messages", payload)
                status_code = res.get("status", {}).get("code")
                if status_code == 200:
                    logger.info(f"✅ Email sent to {to_email} ({len(attachments)} PDFs, CC: {bool(config.CC_EMAILS)})")
                    return res
                elif status_code == 500 and attempt == 0:
                    logger.warning("⚠️ Zoho 500 — attachments may have expired. Re-uploading...")
                    self._invalidate_attachment_cache()
                    continue
                else:
                    logger.error(f"Zoho send error for {to_email}: {res}")
                    return None
            except Exception as e:
                if "500" in str(e) and attempt == 0:
                    logger.warning("⚠️ Zoho 500 — re-uploading attachments...")
                    self._invalidate_attachment_cache()
                    continue
                logger.error(f"send_new_email failed for {to_email}: {e}")
                return None
        return None

    def send_reply(self, message_id: str, reply_body: str, attach: bool = True) -> dict | None:
        """Send reply with real PDF attachments + CC."""
        for attempt in range(2):
            attachments = self.upload_attachments(force=(attempt > 0)) if attach else []
            try:
                msg_data = self._get(f"messages/{message_id}")
                msg_info = msg_data.get("data", {})
                to_addr  = msg_info.get("fromAddress", "")
                subj     = msg_info.get("subject", "")
                if not subj.lower().startswith("re:"):
                    subj = f"Re: {subj}"

                payload = {
                    "fromAddress": config.ZOHO_FROM_EMAIL,
                    "toAddress":   to_addr,
                    "subject":     subj,
                    "content":     self._build_html(reply_body),
                    "mailFormat":  "html",
                    "askReceipt":  "no",
                }
                if config.CC_EMAILS:
                    payload["ccAddress"] = config.CC_EMAILS
                if attachments:
                    payload["attachments"] = attachments

                res = self._post_json("messages", payload)
                status_code = res.get("status", {}).get("code")
                if status_code == 200:
                    logger.info(f"✅ Reply sent to {to_addr} (CC: {bool(config.CC_EMAILS)})")
                    return res
                elif status_code == 500 and attempt == 0:
                    self._invalidate_attachment_cache()
                    continue
                else:
                    logger.error(f"Reply send error: {res}")
                    return None
            except Exception as e:
                if "500" in str(e) and attempt == 0:
                    self._invalidate_attachment_cache()
                    continue
                logger.error(f"send_reply failed for {message_id}: {e}")
                return None
        return None

    # ─── Utilities ────────────────────────────────────────────────────────────

    def mark_as_read(self, message_id: str):
        try:
            self._put("updatemessage", {"mode": "markAsRead", "messageId": [str(message_id).strip()]})
        except Exception:
            pass

    def get_unread_count(self) -> int:
        try:
            fid = self._folder_id("Inbox")
            if not fid:
                return -1
            data = self._get("folders")
            for folder in data.get("data", []):
                if folder.get("folderId") == fid:
                    return int(folder.get("unreadCount", 0))
            return 0
        except Exception:
            return -1

    def test_connection(self) -> bool:
        try:
            self._ensure_token()
            self._get("folders")
            return True
        except Exception as e:
            logger.error(f"Zoho connection test failed: {e}")
            return False
