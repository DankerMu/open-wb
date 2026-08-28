from __future__ import annotations

import unittest

from candidate_proxy import slugify


class SlugifyTests(unittest.TestCase):
    def test_lowercases_ascii_letters_and_preserves_digits(self):
        self.assertEqual("release-2026", slugify("Release 2026"))

    def test_collapses_each_separator_run(self):
        self.assertEqual("a-b", slugify("A__ /  B"))

    def test_trims_leading_and_trailing_separators(self):
        self.assertEqual("alpha", slugify(" -- Alpha !! "))

    def test_non_ascii_characters_are_separators(self):
        self.assertEqual("caf-42", slugify("Café 42"))

    def test_returns_empty_when_no_ascii_alphanumeric_remains(self):
        self.assertEqual("", slugify("你好 -- !!!"))


if __name__ == "__main__":
    unittest.main()
