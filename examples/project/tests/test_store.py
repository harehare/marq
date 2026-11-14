import tempfile
import unittest
from pathlib import Path

from taskly.store import Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.store = Store(Path(tempfile.mkdtemp()) / "tasks.json")

    def test_add_and_done(self):
        a = self.store.add("write")
        b = self.store.add("review", "2026-11-20")
        self.assertEqual((a.id, b.id), (1, 2))
        self.store.done(1)
        self.assertEqual([t.done for t in self.store.load()], [True, False])

    def test_done_unknown(self):
        with self.assertRaises(KeyError):
            self.store.done(9)


if __name__ == "__main__":
    unittest.main()
