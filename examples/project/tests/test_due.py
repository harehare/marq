import unittest
from datetime import date

from taskly.due import parse_due

TODAY = date(2026, 11, 14)  # a Saturday


class ParseDue(unittest.TestCase):
    def test_words(self):
        self.assertEqual(parse_due("today", TODAY), date(2026, 11, 14))
        self.assertEqual(parse_due("tomorrow", TODAY), date(2026, 11, 15))

    def test_in_n_days(self):
        self.assertEqual(parse_due("in 1 day", TODAY), date(2026, 11, 15))
        self.assertEqual(parse_due("in 3 days", TODAY), date(2026, 11, 17))

    def test_weekday_is_the_next_one(self):
        self.assertEqual(parse_due("fri", TODAY), date(2026, 11, 20))
        self.assertEqual(parse_due("sat", TODAY), date(2026, 11, 21))

    def test_iso(self):
        self.assertEqual(parse_due("2026-12-01", TODAY), date(2026, 12, 1))

    def test_nonsense(self):
        with self.assertRaises(ValueError):
            parse_due("whenever", TODAY)


if __name__ == "__main__":
    unittest.main()
