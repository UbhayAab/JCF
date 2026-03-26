"""
Doctor Email Scraper - Main Entry Point
Extracts all emails from target websites with confidence scoring.
Oncologists and researchers get highest confidence.
"""

import sys
from scraper.staticScraper import StaticScraper
from scraper.dynamicScraper import DynamicScraper
from scraper.pdfScraper import scrape_pdf
from scraper.saveToCSV import save_to_csv


def scrape_website_static(url, depth=5, max_pages=500):
    """Scrape using static method (Requests + BeautifulSoup)"""
    scraper = StaticScraper(max_pages=max_pages)

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    print(f"\nStarting Static Scraper on: {url}")
    print(f"Crawl Depth: {depth}\n")

    scraper.crawl(url, depth=depth)
    return scraper.get_results()


def scrape_website_dynamic(url, depth=5, browser="chrome", max_pages=500):
    """Scrape using dynamic method (Selenium)"""
    try:
        scraper = DynamicScraper(max_pages=max_pages, browser=browser, headless=True)

        if not scraper.start_driver():
            return []

        if not url.startswith(("http://", "https://")):
            url = "https://" + url

        print(f"\nStarting Dynamic Scraper (Selenium) on: {url}")
        print(f"Crawl Depth: {depth}\n")

        scraper.crawl(url, depth=depth)
        results = scraper.get_results()
        scraper.stop_driver()

        return results

    except Exception as e:
        print(f"\nError with Selenium: {e}")
        print("Make sure ChromeDriver/GeckoDriver is installed and in PATH")
        print("Install: pip install webdriver-manager")
        return []


def display_results(data):
    """Display results in formatted table with confidence interpretation"""
    if not data:
        print("\nNo emails found.\n")
        return

    print("\n" + "=" * 110)
    print("  ALL EMAILS FOUND (sorted by confidence)")
    print("=" * 110)

    # Confidence legend
    print("  Score Guide: 80+ = Very High | 60-79 = High | 40-59 = Medium | 20-39 = Low | <20 = Very Low")
    print("-" * 110)

    print(f"  {'Email':<40} | {'Name':<25} | {'Phone':<15} | {'Score':<8} | {'Conf':<10}")
    print("-" * 110)

    for row in data:
        email = row.get("email", "")[:39]
        name = row.get("name", "")[:24]
        phone = row.get("phone", "")[:14]
        score = row.get("score", 0)
        score_str = str(score)[:7]

        # Confidence label
        if score >= 80:
            conf = "⭐ V.HIGH"
        elif score >= 60:
            conf = "🟢 HIGH"
        elif score >= 40:
            conf = "🟡 MEDIUM"
        elif score >= 20:
            conf = "🟠 LOW"
        else:
            conf = "⚪ V.LOW"

        print(f"  {email:<40} | {name:<25} | {phone:<15} | {score_str:<8} | {conf:<10}")

    print("-" * 110)
    print(f"\n  Total Emails Found: {len(data)}")
    high_conf = sum(1 for r in data if r.get('score', 0) >= 60)
    print(f"  High Confidence (60+): {high_conf}")
    print(f"  Likely Doctors/Researchers (80+): {sum(1 for r in data if r.get('score', 0) >= 80)}")
    print()


def show_menu():
    """Display main menu"""
    print("\n" + "=" * 80)
    print(" " * 20 + "DOCTOR EMAIL SCRAPER")
    print("=" * 80)
    print("\nSelect Input Source:")
    print("  1) Website - Static Scraping (Requests + BeautifulSoup) - Fast")
    print("  2) Website - Dynamic Scraping (Selenium) - JavaScript Support")
    print("  3) PDF File - Extract from PDF Document")
    print("  4) Exit")
    print("\n" + "=" * 80)


def show_browser_menu():
    """Display browser selection menu"""
    print("\nSelect Browser:")
    print("  1) Chrome (Recommended)")
    print("  2) Firefox")


def main():
    """Main program loop"""
    print("\n" * 2)
    print("╔" + "═" * 78 + "╗")
    print("║" + " Doctor Email Scraper — All Emails + Smart Confidence ".center(78) + "║")
    print("╚" + "═" * 78 + "╝")

    while True:
        show_menu()
        choice = input("\nEnter your choice (1-4): ").strip()

        if choice == "1":
            # Static scraping
            url = input("\nEnter Website URL: ").strip()
            if not url:
                print("URL cannot be empty")
                continue

            depth = input("Enter crawl depth (1-10, default 5 = thorough): ").strip()
            try:
                depth = int(depth) if depth else 5
                depth = max(1, min(10, depth))
            except ValueError:
                depth = 5

            max_pages_input = input("Max pages to crawl (default 500, 0 = unlimited): ").strip()
            try:
                max_pages = int(max_pages_input) if max_pages_input else 500
                if max_pages == 0:
                    max_pages = 99999
                max_pages = max(1, max_pages)
            except ValueError:
                max_pages = 500

            results = scrape_website_static(url, depth, max_pages)

            if results:
                display_results(results)
                save_choice = input("Save to CSV? (y/n): ").strip().lower()
                if save_choice == 'y':
                    save_to_csv(results)
            else:
                print("\nNo emails found on this site.")

        elif choice == "2":
            # Dynamic scraping
            url = input("\nEnter Website URL: ").strip()
            if not url:
                print("URL cannot be empty")
                continue

            depth = input("Enter crawl depth (1-10, default 5 = thorough): ").strip()
            try:
                depth = int(depth) if depth else 5
                depth = max(1, min(10, depth))
            except ValueError:
                depth = 5

            max_pages_input = input("Max pages to crawl (default 500, 0 = unlimited): ").strip()
            try:
                max_pages = int(max_pages_input) if max_pages_input else 500
                if max_pages == 0:
                    max_pages = 99999
                max_pages = max(1, max_pages)
            except ValueError:
                max_pages = 500

            show_browser_menu()
            browser_choice = input("\nSelect browser (1-2, default 1): ").strip()
            browser = "firefox" if browser_choice == "2" else "chrome"

            results = scrape_website_dynamic(url, depth, browser, max_pages)

            if results:
                display_results(results)
                save_choice = input("Save to CSV? (y/n): ").strip().lower()
                if save_choice == 'y':
                    save_to_csv(results)
            else:
                print("\nNo emails found on this site.")

        elif choice == "3":
            # PDF processing
            pdf_path = input("\nEnter PDF file path: ").strip()
            if not pdf_path:
                print("Path cannot be empty")
                continue

            results = scrape_pdf(pdf_path)

            if results:
                display_results(results)
                save_choice = input("Save to CSV? (y/n): ").strip().lower()
                if save_choice == 'y':
                    save_to_csv(results)
            else:
                print("\nNo emails found in PDF.")

        elif choice == "4":
            print("\nThank you for using Doctor Email Scraper!")
            break

        else:
            print("Invalid choice. Please try again.")

        input("\nPress Enter to continue...")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nProgram interrupted by user.")
        sys.exit(0)