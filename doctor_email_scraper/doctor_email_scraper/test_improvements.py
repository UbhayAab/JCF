#!/usr/bin/env python3
"""
Quick test script for the improved name extraction and scoring
"""

from scraper.filterUtils import extract_names, calculate_score, filter_doctor_emails

def test_name_extraction():
    """Test the improved name extraction"""
    print("Testing name extraction...")

    test_text = """
    Dr. Sarah Johnson is a cardiologist at City Hospital.
    Contact her at sarah.johnson@cityhospital.edu

    Professor Michael Chen specializes in neurology.
    Email: mchen@medical.edu

    For appointments, call Dr. Emily Rodriguez at (555) 123-4567
    or email emily.rodriguez@clinic.org

    John Smith - Family Physician
    john.smith@familycare.com
    """

    names = extract_names(test_text)
    print(f"Extracted names: {names}")

    return names

def test_scoring():
    """Test the improved scoring system"""
    print("\nTesting scoring system...")

    test_cases = [
        ("dr.sarah.johnson@cityhospital.edu", "Dr. Sarah Johnson cardiologist hospital", "Sarah Johnson"),
        ("mchen@medical.edu", "Professor Michael Chen neurology", "Michael Chen"),
        ("emily.rodriguez@clinic.org", "Dr. Emily Rodriguez physician", "Emily Rodriguez"),
        ("john.smith@familycare.com", "John Smith Family Physician", "John Smith"),
        ("info@hospital.com", "General hospital information", ""),
        ("contact@clinic.org", "Contact us for appointments", ""),
    ]

    for email, context, name in test_cases:
        score = calculate_score(email, context, name)
        print(f"Email: {email} | Name: {name} | Score: {score}")

def test_filtering():
    """Test the email filtering"""
    print("\nTesting email filtering...")

    emails = [
        "dr.sarah.johnson@cityhospital.edu",
        "mchen@medical.edu",
        "emily.rodriguez@clinic.org",
        "john.smith@familycare.com",
        "info@hospital.com",
        "contact@clinic.org",
        "sales@medicalsupply.com"
    ]

    context = "Dr. Sarah Johnson cardiologist hospital Professor Michael Chen neurology"
    names = ["Sarah Johnson", "Michael Chen", "Emily Rodriguez", "John Smith"]

    filtered = filter_doctor_emails(emails, context, names, min_score=50)
    print(f"Filtered emails (score >= 50): {filtered}")

if __name__ == "__main__":
    test_name_extraction()
    test_scoring()
    test_filtering()
    print("\nTest completed!")