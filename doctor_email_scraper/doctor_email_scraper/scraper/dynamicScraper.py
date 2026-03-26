"""
Dynamic Website Scraper - Uses Selenium
Two-pass architecture: crawl → collect → score
Auto-discovers and scrapes PDFs found on the site
Enhanced stealth to bypass anti-bot protection (Cloudflare, etc.)
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import time
import random
import re
import requests
import urllib3

from .emailUtils import extract_emails, extract_phones, extract_name_from_email
from .filterUtils import extract_names, score_all_contacts
from .pdfScraper import extract_text_from_pdf_bytes, scrape_pdf_raw

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class DynamicScraper:
    """
    Selenium scraper with two-pass scoring, PDF auto-download,
    and enhanced anti-detection stealth.
    """

    def __init__(self, max_pages=500, browser="chrome", headless=True, follow_external=True):
        self.visited = set()
        self.all_emails = set()
        self.max_pages = max_pages
        self.follow_external = follow_external
        self.base_domain = None
        self.browser_type = browser
        self.headless = headless
        self.driver = None
        self.wait = None

        # Two-pass data stores
        self.raw_contacts = []
        self.all_site_names = []
        self.pdf_urls = set()
        self.scraped_pdfs = set()

    def _random_delay(self, min_s=2.0, max_s=5.0):
        """Sleep a random duration to mimic human browsing"""
        time.sleep(random.uniform(min_s, max_s))

    def start_driver(self):
        """Initialize Selenium with maximum stealth anti-detection"""
        try:
            if self.browser_type.lower() == "chrome":
                chrome_options = Options()
                if self.headless:
                    chrome_options.add_argument("--headless=new")

                # Basic flags
                chrome_options.add_argument("--no-sandbox")
                chrome_options.add_argument("--disable-dev-shm-usage")
                chrome_options.add_argument("--disable-gpu")
                chrome_options.add_argument("--window-size=1920,1080")

                # ── Anti-detection stealth ──
                chrome_options.add_argument("--disable-blink-features=AutomationControlled")
                chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
                chrome_options.add_experimental_option("useAutomationExtension", False)

                # Realistic UA
                ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                chrome_options.add_argument(f"user-agent={ua}")

                # Extra stealth flags
                chrome_options.add_argument("--disable-infobars")
                chrome_options.add_argument("--disable-extensions")
                chrome_options.add_argument("--disable-popup-blocking")
                chrome_options.add_argument("--lang=en-US,en")
                chrome_options.add_argument("--start-maximized")

                # Disable webRTC leak
                prefs = {
                    "webrtc.ip_handling_policy": "disable_non_proxied_udp",
                    "webrtc.multiple_routes_enabled": False,
                    "webrtc.nonproxied_udp_enabled": False,
                    "credentials_enable_service": False,
                    "profile.password_manager_enabled": False,
                }
                chrome_options.add_experimental_option("prefs", prefs)

                self.driver = webdriver.Chrome(options=chrome_options)

                # Remove navigator.webdriver flag
                self.driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
                    "source": """
                        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                        Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
                        Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                        window.chrome = { runtime: {} };
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications' ?
                                Promise.resolve({ state: Notification.permission }) :
                                originalQuery(parameters)
                        );
                    """
                })
            else:
                firefox_options = webdriver.FirefoxOptions()
                if self.headless:
                    firefox_options.add_argument("--headless")
                firefox_options.set_preference("dom.webdriver.enabled", False)
                firefox_options.set_preference("useAutomationExtension", False)
                firefox_options.set_preference("general.useragent.override",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0")
                self.driver = webdriver.Firefox(options=firefox_options)

            self.wait = WebDriverWait(self.driver, 15)
            return True

        except Exception as e:
            print(f"Error starting {self.browser_type}: {e}")
            return False

    def stop_driver(self):
        """Close the browser"""
        if self.driver:
            self.driver.quit()
            self.driver = None

    def _get_root_domain(self, url):
        """Extract root domain: e.g. 'support.nhs.uk' → 'nhs.uk'"""
        netloc = urlparse(url).netloc.lower()
        parts = netloc.split('.')
        if len(parts) >= 3 and parts[-2] in ('co', 'ac', 'org', 'edu', 'gov', 'net'):
            return '.'.join(parts[-3:])
        if len(parts) >= 2:
            return '.'.join(parts[-2:])
        return netloc

    def should_crawl_url(self, url):
        """Check if URL should be crawled — follows related subdomains"""
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https', ''):
            return False
        skip_extensions = ('.jpg', '.jpeg', '.png', '.gif', '.svg', '.css', '.js',
                           '.mp4', '.mp3', '.zip', '.ico', '.woff', '.woff2', '.ttf')
        if any(parsed.path.lower().endswith(ext) for ext in skip_extensions):
            return False
        if self.follow_external and self.base_domain:
            url_root = self._get_root_domain(url)
            return url_root == self.base_domain
        return True

    def get_links(self, url, soup):
        """Extract ALL links (including cross-subdomain) and PDF links"""
        links = set()

        try:
            for tag in soup.find_all("a", href=True):
                href = tag["href"]
                full_url = urljoin(url, href).split("#")[0]

                if href.lower().endswith('.pdf') or '.pdf' in href.lower().split('?')[0]:
                    self.pdf_urls.add(full_url)
                    continue

                if full_url in self.visited:
                    continue

                if self.should_crawl_url(full_url):
                    links.add(full_url)
        except Exception as e:
            print(f"  Error extracting links: {e}")

        return links

    def _is_valid_person_name(self, name):
        """Check if text looks like a valid person name"""
        clean_name = re.sub(r'[^\w\s]', '', name)
        words = clean_name.split()
        if not (2 <= len(words) <= 5):
            return False
        garbage = [
            'hospital', 'office', 'center', 'department', 'university',
            'college', 'clinic', 'program', 'institute', 'director',
            'admin', 'manager', 'coordinator', 'click', 'skip', 'menu',
        ]
        name_words = clean_name.lower().split()
        if any(g in name_words for g in garbage):
            return False
        if any(char.isdigit() for char in name):
            return False
        return True

    def _find_nearby_name(self, soup, email):
        """Find the nearest person name to an email in the DOM"""
        if not soup:
            return ""

        escaped_email = re.escape(email)
        email_container_tag = None

        string_match = soup.find(string=re.compile(escaped_email, re.IGNORECASE))
        if string_match:
            email_container_tag = string_match.parent
        else:
            a_tag = soup.find('a', href=re.compile(escaped_email, re.IGNORECASE))
            if a_tag:
                email_container_tag = a_tag

        if not email_container_tag:
            return ""

        container = email_container_tag
        for _ in range(5):
            if not container or container.name == 'body':
                break
            tags = container.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'strong', 'b', 'span', 'p'])
            for t in tags:
                potential_name = t.get_text(strip=True)
                if self._is_valid_person_name(potential_name):
                    return potential_name
            container = container.parent

        return ""

    def _get_email_context(self, text, email):
        """Get 500 chars of surrounding context for an email"""
        try:
            email_pos = text.find(email)
            if email_pos == -1:
                return ""
            start = max(0, email_pos - 500)
            end = min(len(text), email_pos + len(email) + 500)
            return text[start:end]
        except:
            return ""

    def extract_contacts(self, soup, text, url):
        """Pass 1: Collect raw email data with context. No scoring."""
        emails = extract_emails(text)
        phones = extract_phones(text)
        names = extract_names(text)

        self.all_site_names.extend(names)

        if emails:
            print(f"  Found {len(emails)} email(s)")
        if names:
            print(f"  Found {len(names)} name(s)")

        for email in set(emails):
            if email in self.all_emails:
                continue
            self.all_emails.add(email)

            nearby_name = self._find_nearby_name(soup, email)
            fallback_name = extract_name_from_email(email)
            context = self._get_email_context(text, email)
            phone = phones[0] if phones else ""

            self.raw_contacts.append({
                'email': email,
                'nearby_name': nearby_name,
                'fallback_name': fallback_name,
                'context': context,
                'url': url,
                'phone': phone,
            })

    def _download_and_scrape_pdfs(self):
        """Download all discovered PDFs and extract contacts"""
        if not self.pdf_urls:
            return

        new_pdfs = self.pdf_urls - self.scraped_pdfs
        if not new_pdfs:
            return

        print(f"\n📄 Found {len(new_pdfs)} PDF(s) on the site. Downloading and scraping...")

        # Use requests for PDF downloads (faster than Selenium)
        session = requests.Session()
        for pdf_url in new_pdfs:
            self.scraped_pdfs.add(pdf_url)
            try:
                print(f"  Downloading: {pdf_url}")
                self._random_delay(1, 3)

                response = session.get(pdf_url, timeout=30, verify=False, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                })
                if response.status_code != 200:
                    print(f"  ⚠ Failed (HTTP {response.status_code})")
                    continue

                pdf_text = extract_text_from_pdf_bytes(response.content)
                if not pdf_text:
                    print(f"  ⚠ No text extracted")
                    continue

                pdf_emails, pdf_names, pdf_phones, _ = scrape_pdf_raw(pdf_text)
                self.all_site_names.extend(pdf_names)

                print(f"  ✓ Extracted {len(pdf_emails)} email(s), {len(pdf_names)} name(s)")

                for email in set(pdf_emails):
                    if email in self.all_emails:
                        continue
                    self.all_emails.add(email)

                    email_context = ""
                    email_pos = pdf_text.find(email)
                    if email_pos != -1:
                        start = max(0, email_pos - 500)
                        end = min(len(pdf_text), email_pos + len(email) + 500)
                        email_context = pdf_text[start:end]

                    context_names = extract_names(email_context) if email_context else []
                    nearby_name = context_names[0] if context_names else ""
                    phone = pdf_phones[0] if pdf_phones else ""

                    self.raw_contacts.append({
                        'email': email,
                        'nearby_name': nearby_name,
                        'fallback_name': extract_name_from_email(email),
                        'context': email_context or pdf_text[:1000],
                        'url': pdf_url,
                        'phone': phone,
                    })

            except Exception as e:
                print(f"  ⚠ Error processing PDF {pdf_url}: {e}")

    def _simulate_human_behavior(self):
        """Simulate human-like interactions on the page"""
        try:
            # Scroll down naturally
            total_height = self.driver.execute_script("return document.body.scrollHeight")
            viewport_height = self.driver.execute_script("return window.innerHeight")
            scroll_pos = 0

            while scroll_pos < total_height:
                scroll_step = random.randint(200, 500)
                scroll_pos += scroll_step
                self.driver.execute_script(f"window.scrollTo(0, {scroll_pos});")
                time.sleep(random.uniform(0.3, 0.8))

            # Scroll back to top
            self.driver.execute_script("window.scrollTo(0, 0);")
            time.sleep(random.uniform(0.5, 1.0))
        except Exception:
            pass

    def fetch_page(self, url, retries=3):
        """Fetch page with Selenium + retry + human simulation"""
        for attempt in range(retries):
            try:
                self.driver.get(url)

                # Wait for page to fully load
                time.sleep(random.uniform(3.0, 5.0))

                # Check for Cloudflare/bot challenge pages
                page_source = self.driver.page_source
                if 'challenge-platform' in page_source or 'cf-browser-verification' in page_source:
                    print(f"  ⚠ Bot challenge detected — waiting for it to resolve...")
                    time.sleep(8)  # Wait for challenge to auto-resolve
                    page_source = self.driver.page_source

                # Simulate human scrolling to trigger lazy content
                self._simulate_human_behavior()

                soup = BeautifulSoup(page_source, "html.parser")
                for tag in soup(["script", "style"]):
                    tag.decompose()

                text = soup.get_text(separator=" ")
                return soup, text

            except Exception as e:
                print(f"  Error fetching {url}: {e}")
                if attempt < retries - 1:
                    print(f"  Retrying ({attempt+2}/{retries})...")
                    self._random_delay()

        return None, None

    def crawl(self, url, depth=10):
        """Crawl website recursively — deep and thorough"""
        if depth == 0 or url in self.visited or len(self.visited) >= self.max_pages:
            return

        if self.base_domain is None:
            self.base_domain = self._get_root_domain(url)
            print(f"  Base domain: {self.base_domain}")

        print(f"Crawling ({len(self.visited)+1}/{self.max_pages}): {url}")

        self.visited.add(url)

        if len(self.visited) > 1:
            self._random_delay()

        soup, text = self.fetch_page(url)

        if soup and text:
            self.extract_contacts(soup, text, url)

            if depth > 1:
                links = self.get_links(url, soup)
                for link in links:
                    self.crawl(link, depth - 1)

    def get_results(self):
        """
        Pass 2: Download PDFs, cross-reference, and score everything.
        """
        self._download_and_scrape_pdfs()

        unique_names = list(dict.fromkeys(self.all_site_names))
        print(f"\n📊 Scoring {len(self.raw_contacts)} emails against {len(unique_names)} names found across the site...")

        results = score_all_contacts(self.raw_contacts, unique_names)
        return results