from pathlib import Path
import unittest


class VoxtralRunScriptTests(unittest.TestCase):
    def test_accuracy_balanced_delay_is_the_default(self):
        script = Path(__file__).with_name("run.sh").read_text()
        self.assertIn("VOXTRAL_DELAY_MS=480", script)
        self.assertIn('${VOXTRAL_DELAY_MS:-480}', script)
        self.assertNotIn('${VOXTRAL_DELAY_MS:-240}', script)


if __name__ == "__main__":
    unittest.main()
