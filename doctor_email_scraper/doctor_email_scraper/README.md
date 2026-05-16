# Doctor Contact Scraper

A Python-based tool designed to extract doctor contact information such as emails, phone numbers, and names from websites and PDF files.

This project is built to handle both simple websites and complex, JavaScript-heavy pages, making it flexible for real-world use.

---

## Overview

This scraper helps you:

* Extract emails, phone numbers, and names
* Work with both static and dynamic websites
* Process PDF documents
* Export clean and structured data

It is designed to be simple enough for beginners while still being powerful for real-world data extraction tasks.

---

## Key Features

### Core Functionality

* Supports two scraping modes:

  * **Basic Scraping** (fast, for normal websites)
  * **Advanced Scraping** (handles JavaScript-heavy sites using Selenium)

* Works with:

  * Websites (with configurable crawl depth)
  * PDF documents

* Extracts:

  * Emails (including hidden formats like `[at]`, `[dot]`)
  * Phone numbers (multiple formats)
  * Names of doctors or professionals

---

### Data Handling

* Removes duplicate entries automatically
* Converts hidden email formats into valid emails
* Extracts names from emails if not explicitly available
* Filters data based on medical relevance
* Maintains structured and clean output

---

### Output

* Saves results in a clean **CSV file**
* Displays results in a readable format in the terminal
* Avoids duplicate entries across runs

---

## Installation

### Requirements

* Python 3.7+
* pip

---

### Setup Steps

1. Navigate to the project folder:

```bash
cd doctor_email_scraper
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

---

### For Advanced Scraping (Selenium)

**Recommended:**

```bash
pip install webdriver-manager
```

This will automatically handle browser drivers.

---

## How to Use

### Run the scraper

```bash
python main.py
```

---

### Choose your input type

You will see a menu like:

* Website (Basic scraping)
* Website (Advanced scraping with JavaScript support)
* PDF file

---

### Example Usage

#### Basic Website Scraping

* Enter website URL
* Choose crawl depth (1–3)

#### Advanced Scraping

* Use for dynamic websites
* Select browser (Chrome recommended)

#### PDF Extraction

* Provide file path of the PDF

---

## Project Structure

```
doctor_email_scraper/
├── main.py
├── scraper.py
├── advanced_scraper.py
├── pdf_extractor.py
├── utils.py
├── requirements.txt
├── output.csv
└── README.md
```

---

## How It Works

1. You provide a URL or PDF
2. The scraper collects raw data
3. It extracts emails, phone numbers, and names
4. Cleans and removes duplicates
5. Saves results into a CSV file

---

## Output Format

```
Name, Email, Phone, URL, Source
```

Example:

```
Manish Shrigirivwar, drmanish@hospital.com, +1-712-235-2033, https://example.com, Advanced
```

---

## Configuration

### Crawl Depth

* 1 → Only main page
* 2 → Recommended (main + linked pages)
* 3 → Deep crawl (slower but more data)

---

### Limits

* Default max pages: 20
* Prevents excessive crawling and resource usage

---

## Performance Tips

* Use **Basic Scraper** whenever possible (faster execution)
* Use **Advanced Scraper only for JavaScript-heavy sites**
* Keep crawl depth at **2** for best balance
* Avoid scraping too many pages at once
* Run scraping in smaller batches for better stability
* Ensure a stable internet connection for consistent results

---

## Hidden Features (Advanced Capabilities)

* **Hidden Email Normalization**
  Automatically converts:

  * `doctor[at]hospital[dot]com`
  * `doctor at hospital dot com`
    → into valid email format

* **Smart Name Extraction**

  * Extracts names from text
  * Converts emails into names
  * Handles formats like `drjohnsmith` → `John Smith`

* **Duplicate Detection System**

  * Prevents repeated emails within the same session
  * Avoids duplication across CSV outputs

* **Medical Context Filtering**

  * Identifies relevant data using keywords like:

    * doctor, clinic, hospital, surgery, etc.

---

## Common Issues & Fixes

### Selenium not working

Install:

```bash
pip install webdriver-manager
```

---

### No data found

* Try Advanced Scraper
* Increase crawl depth
* Check if website blocks bots

---

### Slow performance

* Use Basic Scraper
* Reduce crawl depth
* Avoid large-scale crawling in one run

---

### Timeout or errors

* Check internet connection
* Reduce number of pages
* Retry with smaller inputs

---

## Limitations

* Cannot extract emails from images (no OCR support)
* Some websites may block scraping requests
* JavaScript-heavy sites require Selenium
* PDF extraction depends on file formatting

---

## Best Practices

* Start with Basic Scraper first
* Use Advanced Scraper only when necessary
* Keep data clean and structured
* Avoid scraping restricted or sensitive websites
* Respect website policies and ethical usage

---

## Contributing

You can improve this project by:

* Adding new extraction patterns
* Supporting more file formats
* Improving accuracy of name detection
* Optimizing performance and speed

---

## License

This project is provided for educational and authorized use only.

## Support

For issues or feature requests, review the code documentation or check common troubleshooting solutions above.

---

**Last Updated:** March 2026
**Version:** 2.0 (Advanced Edition)
**Status:** Production Ready
