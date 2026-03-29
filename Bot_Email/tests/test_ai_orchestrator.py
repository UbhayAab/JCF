import unittest
import sys
import os
from unittest.mock import patch, MagicMock

# Add parent path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ai_orchestrator

class TestAIOrchestrator(unittest.TestCase):
    @patch('ai_orchestrator.requests.post')
    @patch('ai_orchestrator.gemini_reply')
    @patch('ai_orchestrator.local_ai.generate_reply_locally')
    def test_triple_fallback_chain(self, mock_local, mock_gemini, mock_deepseek):
        """Verify DeepSeek -> Gemini -> Local AI fallback chain."""
        
        # Scenario: DeepSeek returns 401 (Unauthorized)
        mock_deepseek.return_value.status_code = 401
        mock_deepseek.return_value.raise_for_status.side_effect = Exception("401")
        
        # Scenario: Gemini returns an [ERROR] string (Quota hit)
        mock_gemini.return_value = "[ERROR: Quota exceeded]"
        
        # Scenario: Local AI returns a successful draft
        mock_local.return_value = "Draft from Local AI"
        
        reply = ai_orchestrator.smart_reply("Thread Text")
        
        # It should end up at Local AI
        self.assertEqual(reply, "Draft from Local AI")
        mock_deepseek.assert_called_once()
        mock_gemini.assert_called_once()
        mock_local.assert_called_once()

if __name__ == "__main__":
    unittest.main()
