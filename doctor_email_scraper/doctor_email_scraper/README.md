# Doctor Contact Scraper

A professional-grade Python scraper for extracting doctor emails, phone numbers, and contact information from websites and PDFs. Supports both basic HTML scraping and advanced Selenium-based scraping for JavaScript-heavy websites.

## Features

### 🎯 Core Capabilities
- **Dual Scraping Modes**: 
  - Basic mode (Requests + BeautifulSoup) - Fast and efficient
  - Advanced mode (Selenium) - JavaScript support, dynamic content
- **Multi-Format Support**:
  - Websites with configurable crawl depth (1-3 levels)
  - PDF documents
- **Contact Information Extraction**:
  - Email addresses (including hidden formats like [at], [dot])
  - Phone numbers (multiple formats)
  - Doctor/person names
- **Advanced Data Processing**:
  - Automatic duplicate removal
  - Name extraction from email addresses
  - Medical context detection
  - Hidden email format normalization

### 🔒 Reliability Features
- SSL certificate error handling
- Automatic duplicate prevention
- Same-domain crawling only
- Configurable page limits
- Comprehensive error handling

### 📊 Output
- CSV export with columns: Name, Email, Phone, URL, Source
- Beautiful formatted console display
- Duplicate checking across sessions

## Installation

### Prerequisites
- Python 3.7+
- pip (Python package manager)

### Setup

1. **Clone or download the project**
   ```bash
   cd doctor_email_scraper
   ```

2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **For Advanced (Selenium) Scraping**
   
   **Option A: Automatic (Recommended)**
   ```bash
   pip install webdriver-manager
   ```
   
   **Option B: Manual Setup**
   - Download ChromeDriver from: https://chromedriver.chromium.org/
   - Add to PATH or place in project directory

## Usage

### Quick Start
```bash
python main.py
```

### Menu Options

```
╔════════════════════════════════════════════════════════════════════════════╗
║          Doctor Email & Contact Scraper - Advanced Edition                 ║
╚════════════════════════════════════════════════════════════════════════════╝

Select Input Type:
  1) Website - Basic Scraping (Requests + BeautifulSoup) - Fast
  2) Website - Advanced Scraping (Selenium) - JavaScript Support
  3) PDF File - Extract from PDF Document
  4) Exit
```

### Example Workflows

#### Option 1: Basic Website Scraping
```
Enter your choice (1-4): 1
Enter Website URL: example-hospital.com
Enter crawl depth (1-3, default 2): 2
```

#### Option 2: Advanced Website Scraping (JavaScript)
```
Enter your choice (1-4): 2
Enter Website URL: reactjs-hospital-site.com
Enter crawl depth (1-3, default 2): 2
Select Browser:
  1) Chrome (Recommended)
  2) Firefox
Select browser (1-2, default 1): 1
```

#### Option 3: PDF Processing
```
Enter your choice (1-4): 3
Enter PDF file path: /path/to/doctor_directory.pdf
```

## Project Structure

```
doctor_email_scraper/
├── main.py                 # Main entry point with menu UI
├── scraper.py              # Basic scraper (Requests + BeautifulSoup)
├── advanced_scraper.py     # Advanced scraper (Selenium)
├── pdf_extractor.py        # PDF text extraction
├── utils.py                # Utilities (email, phone, name extraction)
├── requirements.txt        # Dependencies
├── output.csv              # Generated output file
└── README.md               # This file
```

## File Descriptions

### `main.py`
- Menu-driven user interface
- Orchestrates different scraping modes
- Handles CSV export and formatting
- Result display and user interaction

### `scraper.py`
**BasicScraper Class**
- Fast HTML scraping with Requests + BeautifulSoup
- Internal link crawling (same domain only)
- Configurable depth and page limits
- Automatic duplicate prevention

### `advanced_scraper.py`
**AdvancedScraper Class**
- Selenium WebDriver integration
- JavaScript content rendering
- Dynamic content loading
- Browser selection (Chrome/Firefox)
- Headless mode for server environments

### `pdf_extractor.py`
- PDF text extraction using pdfplumber
- Handles multi-page PDFs
- Error handling for corrupted PDFs

### `utils.py`
Utility Functions:
- `normalize_hidden_emails()` - Convert [at] and [dot] formats
- `extract_emails()` - Email extraction with hidden format support
- `extract_phones()` - Phone number extraction (multiple formats)
- `extract_names()` - Doctor name extraction
- `extract_name_from_email()` - Parse names from email addresses
- `is_doctor()` - Medical context detection

## Data Extraction Examples

### Email Formats Handled
- Standard: `doctor@hospital.com`
- Hidden: `doctor[at]hospital[dot]com`, `doctor(at)hospital(dot)com`
- Spaced: `doctor at hospital dot com`

### Phone Formats Handled
- `+1-234-567-8900`
- `(234) 567-8900`
- `234-567-8900`
- `234 567 8900`
- `+1 234 567 8900`

### Name Extraction
- From text: Extracts likely names from page content
- From email: `drmanishshrigiriwar@hospital.com` → `Manish Shrigiriwar`
- Removes prefixes: `dr.`, `doc.`
- Handles camelCase: `manishvyas` → `Manish Vyas`

## Configuration

### Crawl Depth
- **1**: Only the initial URL
- **2**: Initial URL + one level of internal links (Recommended)
- **3**: Initial URL + two levels of links (slower, more comprehensive)

### Page Limits
- Default: 20 pages maximum per session
- Prevents excessive crawling and resource usage

### Duplicate Prevention
- Tracks emails within session
- Checks existing CSV for previously extracted emails
- Prevents redundant data

## CSV Output Format

```csv
Name,Email,Phone,URL,Source
Manish Shrigirivwar,drmanishshrigiriwar@hospital.com,+1-712-235-2033,https://hospital.com/doctors,Advanced (Selenium)
Rajesh Kumar,drajeshkumar@hospital.com,+1-712-235-2034,https://hospital.com/directory,Basic (Requests+BS4)
```

## Troubleshooting

### Issue: Selenium Driver Not Found
**Solution:**
```bash
pip install webdriver-manager
python main.py  # Will auto-download driver
```

### Issue: SSL Certificate Error
**Status:** Already handled
- The code uses `verify=False` for SSL issues
- Safe for authenticated government sites

### Issue: No Contacts Found
**Possible Causes:**
- Website heavily JavaScript-based → Use Advanced Scraper
- Website blocks bots → Add delay between requests
- Emails in images or JavaScript → May require OCR

### Issue: Timeout During Crawling
**Solution:**
- Reduce crawl depth
- Use Basic Scraper instead of Advanced
- Check internet connection

## Performance Tips

1. **Basic Scraper is Faster**: Use for standard HTML sites
2. **Limit Depth**: Depth of 2 is usually sufficient
3. **Advanced Scraper for JS**: Only use when necessary
4. **Batch Processing**: Process multiple URLs sequentially

## Limitations

- Cannot extract emails from images without OCR
- JavaScript-rendered content requires Selenium
- Rate limiting on some websites may slow crawling
- PDF extraction quality depends on PDF structure

## Advanced Features

### Hidden Email Normalization
Automatically converts:
- `doctor[at]hospital[dot]com` → `doctor@hospital.com`
- `doctor at hospital dot com` → `doctor@hospital.com`

### Medical Context Detection
Recognizes keywords: doctor, MD, hospital, clinic, cardiology, surgery, etc.

### Email Name Parsing
Extracts professional names from email addresses with fallback support

## Contributing

To improve the scraper:
1. Add new extraction patterns in `utils.py`
2. Handle more email/phone formats
3. Improve name detection algorithms
4. Add more website handling logic

## License

This project is provided for educational and authorized use only.

## Support

For issues or feature requests, review the code documentation or check common troubleshooting solutions above.

---

**Last Updated:** March 2026
**Version:** 2.0 (Advanced Edition)
**Status:** Production Ready
