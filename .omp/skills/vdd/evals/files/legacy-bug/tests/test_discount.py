from __future__ import annotations

import unittest

from candidate_proxy import discount


class DiscountTests(unittest.TestCase):
    def test_below_threshold_is_unchanged(self):
        self.assertEqual(99, discount(99))

    def test_contract_boundary_corrects_legacy_bug(self):
        self.assertEqual(90, discount(100))

    def test_above_threshold_matches_accepted_behavior(self):
        self.assertEqual(135, discount(150))


if __name__ == "__main__":
    unittest.main()
