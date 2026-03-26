# Configuration & Examples

## Project Configuration

### Default Settings

```python
# Crawl Configuration
MAX_PAGES = 20          # Maximum pages to crawl per session
CRAWL_DEPTH = [1,2,3]   # Available depth options (1=minimal, 3=comprehensive)
TIMEOUT = 10            # Request timeout in seconds

# Selenium Configuration (Advanced Scraper)
HEADLESS = True         # Run browser in background
BROWSER = "chrome"      # Options: "chrome", "firefox"
WINDOW_SIZE = "1920x1080"

# SSL Configuration
VERIFY_SSL = False      # Safe for problematic certificates

# Data Configuration
CSV_FILENAME = "output.csv"
DUPLICATE_CHECK = True  # Always enabled
```

---

## Usage Patterns

### Pattern 1: Single URL Scraping

**Best For**: One-time extraction from a single website

```
1. Run: python main.py
2. Choose: Option 1 (Basic) or 2 (Advanced)
3. URL: example-hospital.com
4. Depth: 2
5. Save: Yes
6. Output: output.csv
```

### Pattern 2: Batch Processing

For multiple URLs (manual loop):

```bash
# Create a script: batch_scrape.py
urls = [
    "hospital1.com",
    "hospital2.com", 
    "hospital3.com"
]

for url in urls:
    scraper = BasicScraper(max_pages=20)
    scraper.crawl(url, depth=2)
    # Process results...
```

### Pattern 3: JavaScript-Heavy Sites

```
1. Choose: Option 2 (Advanced)
2. Browser: Chrome (recommended)
3. Depth: 2
4. Watch: Browser will appear briefly for dynamic loading
```

### Pattern 4: PDF Extraction

```
1. Choose: Option 3
2. Path: /path/to/doctor_directory.pdf
3. Automatic extraction of all emails/phones
```

---

## Website Detection Guide

### When to Use Basic Scraper (Option 1)
✅ **Use if:**
- Website content visible in page source
- Standard HTML structure
- No JavaScript rendering needed
- Fast extraction required

❌ **Don't use if:**
- Page only shows "Loading..." in view source
- Content appears after 2+ seconds
- Uses React/Angular/Vue frameworks

### When to Use Advanced Scraper (Option 2)
✅ **Use if:**
- Page source shows minimal content
- JavaScript renders the data
- Uses modern frameworks (React, Angular, Vue)
- Need to handle dynamic content
- Can wait for page loading

❌ **Don't use if:**
- Website blocks automated browsers
- Too-strict rate limiting
- Need maximum speed (use Basic instead)

---

## Example Extractions

### Website Type 1: Static HTML Hospital Directory

```
Website: hospital.com/doctors
Content Type: Plain HTML
JavaScript: None
Recommendation: Option 1 (Basic) - Fastest

Expected Results:
- 50-200 contacts per page
- Names from directory lists
- Emails in visible text
- Phone numbers in contact info
```

### Website Type 2: React-Based Doctor Portal

```
Website: portal.hospital.com/find-doctors
Content Type: React SPA
JavaScript: Heavy
Recommendation: Option 2 (Advanced) - Required

Expected Results:
- Dynamic filtering works
- Lazy-loaded content captured
- AJAX requests handled
- JavaScript events triggered
```

### Website Type 3: Government Medical Institution

```
Website: aiims.gov.in/doctors
Content Type: Mixed (HTML + JS)
JavaScript: Moderate
Recommendation: Try Option 1 first, then Option 2

Known Issues:
- SSL certificates might cause issues (handled)
- Slow loading times (increase patience)
- Rate limiting possible
```

---

## Extraction Quality Examples

### Email Extraction Success Cases

**Cases Handled Successfully:**
```
Standard:      doctor@hospital.com ✅
Hidden [at]:   doctor[at]hospital.com ✅
Hidden (at):   doctor(at)hospital.com ✅
Space-separated: doctor at hospital dot com ✅
No-space:      doctorathospital.com ✅
Subdomain:     dr.name@dept.hospital.com ✅
```

**Cases That Might Fail:**
```
Image-based:   [email image] ❌
JavaScript:    document.write(email) ❌
Encoded:       .emdoc@latigih.moc ❌
```

### Phone Extraction Success Cases

**Cases Handled Successfully:**
```
US Format:     (212) 555-1234 ✅
International: +1-212-555-1234 ✅
Dashes:        212-555-1234 ✅
Dots:          212.555.1234 ✅
Spaces:        212 555 1234 ✅
Parentheses:   (212)5551234 ✅
Extended:      +91-712-235-2033 ✅ (Indian format)
```

**Cases That Might Fail:**
```
Text-based:    "Call at two-one-two" ❌
Image:         [phone image] ❌
Mixed:         Call: ext 123 ❌
```

### Name Extraction Success Cases

**Cases Handled Successfully:**
```
Email-derived: drmanishshrigiriwar@ → Manish Shrigiriwar ✅
Text-found:    "Dr. John Smith" → John Smith ✅
Full Name:     "Rajesh Kumar Verma" → Rajesh Kumar Verma ✅
With Title:    "Professor Dr. Sarah Jo..." → Sarah Jo... ✅
```

**Cases That Might Fail:**
```
No text name, complex email: xyzabc123@ → Cannot parse ❌
Only initials: "Dr. A.B.C." → Skip ❌
Foreign characters: "डॉक्टर नाम" → May need improvement ⚠️
```

---

## Performance Metrics

### Basic Scraper (Option 1)
```
Speed: ~2-5 pages/minute
Memory: ~50-100 MB
CPU: Low
Network: Optimal
Best For: Large crawls, fast results
```

### Advanced Scraper (Option 2)
```
Speed: ~1-2 pages/minute
Memory: ~200-400 MB (browser overhead)
CPU: Moderate
Network: Optimal
Best For: JavaScript sites, smaller crawls
```

### PDF Extraction (Option 3)
```
Speed: Instant for single PDFs
Memory: Depends on PDF size
CPU: Low
Scalability: Good for bulk PDFs
Best For: Batch processing documents
```

---

## Common Issues & Solutions

### Issue: "BasicScraper not found"
**Cause**: Using old import statements
**Fix**: 
```python
from scraper import BasicScraper  # NEW
# OLD: from scraper import crawl, reset_visited
```

### Issue: Selenium timeout
**Cause**: Site is slow or JavaScript heavy
**Fix**:
- Increase timeout in advanced_scraper.py
- Reduce crawl depth
- Check internet speed

### Issue: CSV not updating
**Cause**: Duplicate checking prevents new entries
**Check**: Email format consistency in output.csv
**Fix**: Delete output.csv and start fresh

### Issue: Hidden emails not extracted
**Cause**: Non-standard format
**Add to normalize_hidden_emails()** in utils.py

---

## Configuration Customization

### Modify Max Pages
```python
# In main.py, line ~60
scraper = BasicScraper(max_pages=50)  # Increase from 20
```

### Modify Crawl Depth Default
```python
# In main.py, scrape_website_basic function
depth = int(depth) if depth else 3  # Change from 2
```

### Modify Timeout
```python
# In scraper.py, fetch_page method
response = requests.get(url, timeout=15)  # Change from 10
```

### Add Custom Keywords
```python
# In utils.py, is_doctor function
keywords = [
    "dr", "doctor", "md", ... 
    "your_custom_keyword"  # Add here
]
```

---

## Output CSV Structure

```csv
Name,Email,Phone,URL,Source
Manish Shrigiriwar,drmanishshrigiriwar@hospital.com,+1-712-235-2033,https://hospital.com/team,Advanced (Selenium)
Dr. Rajesh Kumar,drajeshkumar@hospital.com,712-235-2034,https://hospital.com/doctors,Basic (Requests+BS4)
Sarah Johnson,sarah.johnson@hospital.com,(712) 235-2035,https://hospital.com/staff,PDF
```

**Column Definitions:**
- **Name**: Extracted doctor name (from text or email)
- **Email**: Valid email address
- **Phone**: Formatted phone number
- **URL**: Page where found
- **Source**: Extraction method used

---

## Scaling the Project

### For 1000+ URLs

```python
# Use multiprocessing
from multiprocessing import Pool

def scrape_url(url):
    scraper = BasicScraper(max_pages=10)
    scraper.crawl(url, depth=1)
    return scraper.get_results()

with Pool(4) as pool:
    results = pool.map(scrape_url, url_list)
```

### For Real-Time Updates

```python
# Use scheduling
import schedule

def scrape_jobs():
    # Run scraping every day at 2 AM
    scraper.crawl(url, depth=2)

schedule.every().day.at("02:00").do(scrape_jobs)
```

---

**Last Updated:** March 2026
**Version:** 2.0
