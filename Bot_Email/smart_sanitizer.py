"""
High-Precision Name Sanitizer for Cold Outreach.
Uses a combination of RegEx and (Optional) Local LLM for algorithmic perfection.
"""

import re
import requests

def clean_name_locally(name_str, email_addr, use_local_llm=False):
    """
    Algorithmic Name Cleaning.
    Targets 'Assistant Professor', 'Dr', etc.
    """
    # 1. If name is generic or looks like a title, try to extract from email
    is_generic = False
    generic_titles = ["assistant professor", "professor", "doctor", "dr", "faculty", "staff", "associate professor"]
    if not name_str or name_str.lower().strip() in generic_titles or "@" in name_str:
        is_generic = True
        # Extract from email prefix
        prefix = email_addr.split("@")[0]
        # drbiswajyoti -> Biswajyoti
        prefix = re.sub(r'^(dr|prof|doctor|associate|assistant)', '', prefix, flags=re.IGNORECASE)
        # Clean special chars
        name_str = prefix.replace(".", " ").replace("_", " ").replace("-", " ").strip()
    
    # 2. Re-add prefix if it was previously 'Dr' related
    was_doctor = "dr" in email_addr.lower() or "dr" in name_str.lower()
    
    # 3. Capitalize
    clean_name = " ".join([w.capitalize() for w in name_str.split()])
    
    # 4. Optional: Run through Local LLM (Ollama) if available for 'Reasoning'
    if use_local_llm:
        try:
            prompt = f"Extract the individual's first name from this string professionaly: '{clean_name}'. If it sounds like a title, return 'Colleague'. Output ONLY the one word name."
            resp = requests.post("http://localhost:11434/api/generate", json={
                "model": "mistral",
                "prompt": prompt,
                "stream": False
            }, timeout=2)
            llm_result = resp.json().get("response", "").strip()
            if len(llm_result.split()) == 1 and llm_result.lower() != "colleague":
                clean_name = llm_result
        except:
            pass # Fallback to algorithmic
            
    if was_doctor:
        return f"Dr. {clean_name}"
    return clean_name
