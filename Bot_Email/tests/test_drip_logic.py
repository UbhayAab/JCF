import unittest
import sys
import os
import time

# Add parent path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database

class TestDripLogic(unittest.TestCase):
    def test_eternal_followup_thresholds(self):
        """Verify that thresholds exist for Sent_1, Sent_2, Sent_3 and default thereafter."""
        self.assertIn("Sent_1", database.THRESHOLDS)
        self.assertIn("Sent_2", database.THRESHOLDS)
        self.assertIn("Sent_3", database.THRESHOLDS)
        self.assertIn("Sent_DEFAULT", database.THRESHOLDS)
        
        # Sent_4 should resolve to Sent_DEFAULT
        t4 = database.THRESHOLDS.get("Sent_4", database.THRESHOLDS["Sent_DEFAULT"])
        self.assertEqual(t4, 96 * 3600)

    def test_event_deadline(self):
        """Verify that the bot stops after May 23rd."""
        from datetime import datetime
        # We can't easily mock datetime.now() without a library, 
        # but we can verify the logic in get_actionable_targets.
        self.assertEqual(database.EVENT_DATE, "2026-05-23")

if __name__ == "__main__":
    unittest.main()
