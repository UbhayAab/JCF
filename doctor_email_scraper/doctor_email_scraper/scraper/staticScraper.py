"""
Static Website Scraper - Uses requests + BeautifulSoup
Two-pass architecture: crawl → collect → score
Auto-discovers and scrapes PDFs found on the site
Anti-crawler: rotating UAs, random delays, retries
"""

import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import urllib3
import random
import time
import re
import os
import tempfile

from .emailUtils import extract_emails, extract_phones, extract_name_from_email
from .filterUtils import extract_names, score_all_contacts, has_medical_title
from .pdfScraper import extract_text_from_pdf_bytes, scrape_pdf_raw

# Disable SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Rotating User-Agent pool
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]


class StaticScraper:
    """
    Static scraper with two-pass scoring and PDF auto-download.
    
    Pass 1 (crawl): Collect all emails, names, phone numbers, and PDF links.
    Pass 2 (score): Cross-reference everything and compute confidence scores.
    """

    def __init__(self, max_pages=500, follow_external=True):
        self.visited = set()
        self.all_emails = set()
        self.max_pages = max_pages
        self.follow_external = follow_external  # Follow related subdomains
        self.base_domain = None  # Set on first crawl
        self.session = requests.Session()

        # Two-pass data stores
        self.raw_contacts = []      # Raw email data with context
        self.all_site_names = []    # Every name found across the site
        self.pdf_urls = set()       # PDF links discovered during crawl
        self.scraped_pdfs = set()   # Track which PDFs we've already processed

    def _get_headers(self):
        """Return headers with a random User-Agent"""
        return {
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        }

    def _random_delay(self):
        """Sleep a random duration to mimic human browsing"""
        delay = random.uniform(1.0, 3.5)
        time.sleep(delay)

    def _get_root_domain(self, url):
        """Extract root domain: e.g. 'support.nhs.uk' → 'nhs.uk'"""
        netloc = urlparse(url).netloc.lower()
        parts = netloc.split('.')
        # Handle .co.uk, .ac.uk, .org.uk, .edu.in etc.
        if len(parts) >= 3 and parts[-2] in ('co', 'ac', 'org', 'edu', 'gov', 'net'):
            return '.'.join(parts[-3:])
        if len(parts) >= 2:
            return '.'.join(parts[-2:])
        return netloc

    def should_crawl_url(self, url):
        """Check if URL should be crawled — follows related subdomains"""
        parsed = urlparse(url)
        # Skip non-http
        if parsed.scheme not in ('http', 'https', ''):
            return False
        # Skip media/asset files
        skip_extensions = ('.jpg', '.jpeg', '.png', '.gif', '.svg', '.css', '.js',
                           '.mp4', '.mp3', '.zip', '.ico', '.woff', '.woff2', '.ttf')
        if any(parsed.path.lower().endswith(ext) for ext in skip_extensions):
            return False
        # If follow_external is on, allow related subdomains
        if self.follow_external and self.base_domain:
            url_root = self._get_root_domain(url)
            return url_root == self.base_domain
        # Same exact domain only
        return True

    def get_links(self, url, soup):
        """Extract ALL links (including cross-subdomain) and PDF links"""
        links = set()

        try:
            for tag in soup.find_all("a", href=True):
                href = tag["href"]
                full_url = urljoin(url, href).split("#")[0]

                # Check if it's a PDF
                if href.lower().endswith('.pdf') or '.pdf' in href.lower().split('?')[0]:
                    self.pdf_urls.add(full_url)
                    continue

                # Skip already visited
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

        # Find email in text nodes or mailto links
        string_match = soup.find(string=re.compile(escaped_email, re.IGNORECASE))
        if string_match:
            email_container_tag = string_match.parent
        else:
            a_tag = soup.find('a', href=re.compile(escaped_email, re.IGNORECASE))
            if a_tag:
                email_container_tag = a_tag

        if not email_container_tag:
            return ""

        # Walk up the DOM tree looking for heading/bold tags with names
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
        """
        Pass 1: Collect raw email data with context. No scoring.
        """
        emails = extract_emails(text)
        phones = extract_phones(text)
        names = extract_names(text)

        # Accumulate all names found across the site
        self.all_site_names.extend(names)

        if emails:
            print(f"  Found {len(emails)} email(s)")
        if names:
            print(f"  Found {len(names)} name(s)")

        for email in set(emails):
            if email in self.all_emails:
                continue
            self.all_emails.add(email)

            # Find name nearest to this email in the DOM
            nearby_name = self._find_nearby_name(soup, email)

            # Fallback: generate name from email address
            fallback_name = extract_name_from_email(email)

            # Get text context around the email
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
        """Download all discovered PDFs and extract contacts from them"""
        if not self.pdf_urls:
            return

        new_pdfs = self.pdf_urls - self.scraped_pdfs
        if not new_pdfs:
            return

        print(f"\n📄 Found {len(new_pdfs)} PDF(s) on the site. Downloading and scraping...")

        for pdf_url in new_pdfs:
            self.scraped_pdfs.add(pdf_url)
            try:
                print(f"  Downloading: {pdf_url}")
                self._random_delay()

                response = self.session.get(
                    pdf_url,
                    headers=self._get_headers(),
                    timeout=30,
                    verify=False,
                )
                if response.status_code != 200:
                    print(f"  ⚠ Failed to download (HTTP {response.status_code})")
                    continue

                content_type = response.headers.get('Content-Type', '')
                if 'pdf' not in content_type and not pdf_url.lower().endswith('.pdf'):
                    print(f"  ⚠ Not a PDF (Content-Type: {content_type})")
                    continue

                # Extract text from PDF bytes
                pdf_text = extract_text_from_pdf_bytes(response.content)
                if not pdf_text:
                    print(f"  ⚠ No text extracted from PDF")
                    continue

                # Get emails, names, phones from PDF
                pdf_emails, pdf_names, pdf_phones, _ = scrape_pdf_raw(pdf_text)
                self.all_site_names.extend(pdf_names)

                print(f"  ✓ Extracted {len(pdf_emails)} email(s), {len(pdf_names)} name(s) from PDF")

                for email in set(pdf_emails):
                    if email in self.all_emails:
                        continue
                    self.all_emails.add(email)

                    # Try to find a name near this email in the PDF text
                    email_context = ""
                    email_pos = pdf_text.find(email)
                    if email_pos != -1:
                        start = max(0, email_pos - 500)
                        end = min(len(pdf_text), email_pos + len(email) + 500)
                        email_context = pdf_text[start:end]

                    # Look for names in context
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

    def fetch_page(self, url, retries=3):
        """Fetch and parse a single page with retry logic"""
        for attempt in range(retries):
            try:
                headers = self._get_headers()
                response = self.session.get(url, headers=headers, timeout=15, verify=False)

                if response.status_code == 403:
                    print(f"  ⚠ 403 Forbidden — retrying with different UA ({attempt+1}/{retries})")
                    self._random_delay()
                    continue
                if response.status_code == 429:
                    wait = random.uniform(5, 10)
                    print(f"  ⚠ 429 Rate limited — waiting {wait:.1f}s ({attempt+1}/{retries})")
                    time.sleep(wait)
                    continue

                response.raise_for_status()

                soup = BeautifulSoup(response.text, "html.parser")
                for tag in soup(["script", "style"]):
                    tag.decompose()

                text = soup.get_text(separator=" ")
                return soup, text

            except requests.exceptions.RequestException as e:
                print(f"  Error fetching {url}: {e}")
                if attempt < retries - 1:
                    self._random_delay()

        return None, None

    def crawl(self, url, depth=10):
        """Crawl website recursively — deep and thorough"""
        if depth == 0 or url in self.visited or len(self.visited) >= self.max_pages:
            return

        # Set base domain on first call
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
        Pass 2: Download PDFs, then cross-reference and score everything.
        Returns sorted list of all contacts with confidence scores.
        """
        # First, download and scrape any PDFs found during crawling
        self._download_and_scrape_pdfs()

        # Deduplicate site-wide names
        unique_names = list(dict.fromkeys(self.all_site_names))

        print(f"\n📊 Scoring {len(self.raw_contacts)} emails against {len(unique_names)} names found across the site...")

        # Run two-pass scoring
        results = score_all_contacts(self.raw_contacts, unique_names)
        return results