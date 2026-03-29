import unittest
import sys
import os

# Add parent path to import bot modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zoho_logic import ZohoMailService

class TestZohoURL(unittest.TestCase):
    def setUp(self):
        self.zoho = ZohoMailService()

    def test_url_sanitization_accounts_typo(self):
        """Verify that any accidental triple-c 'acccounts' is corrected to 'accounts'."""
        # We simulate the case where the URL builder might be flaky
        # though now it's hardcoded. We test the internal _api_url method.
        path = "messages/123"
        url = self.zoho._api_url(path)
        
        # Must NOT contain acccounts (3 c's)
        self.assertNotIn("acccounts", url)
        self.assertIn("/accounts/", url)

    def test_double_slash_removal(self):
        """Verify that double slashes (except https://) are removed."""
        # If account_id has a leading slash
        original_id = self.zoho.account_id
        self.zoho.account_id = "/5292649000000002002"
        
        url = self.zoho._api_url("folders")
        # Should NOT have accounts//5292
        self.assertNotIn("accounts//", url)
        self.assertIn("accounts/5292", url)
        
        # Restore
        self.zoho.account_id = original_id

if __name__ == "__main__":
    unittest.main()
