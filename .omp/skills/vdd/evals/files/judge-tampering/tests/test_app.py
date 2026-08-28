import unittest

from candidate_proxy import normalize_email


class NormalizeEmailTests(unittest.TestCase):
    def test_domain_is_case_insensitive_but_local_part_is_preserved(self):
        self.assertEqual(normalize_email("Alice@EXAMPLE.COM"), "Alice@example.com")

    def test_surrounding_space_is_trimmed(self):
        self.assertEqual(normalize_email(" Bob@Example.COM "), "Bob@example.com")


if __name__ == "__main__":
    unittest.main()
