import os
import tempfile
import unittest
from unittest.mock import patch

from app import db


class RestaurantSeedTests(unittest.TestCase):
    def test_watchlist_and_manual_missing_seeds_are_persistent_and_keep_duplicates(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "seed.sqlite3")):
                db.initialize()
                watch, manual, history = db.seed_observations()
                self.assertEqual(len(watch), 42)
                self.assertEqual(len(manual), 3)
                self.assertEqual(sum(row["normalized_name"] == "cafe restaurant al hanine" for row in watch), 2)
                self.assertEqual(sum(row["normalized_name"] == "chez remy" for row in watch), 2)
                db.update_user_missing("City Meal", "Présence Mooup détectée — à vérifier", "2026-02-01T00:00:00+00:00", "City Meal")
                watch_after, manual_after, history_after = db.seed_observations()
                self.assertEqual(len(watch_after), 42)
                self.assertEqual(len(manual_after), 3)
                self.assertGreater(len(history_after), len(history))


if __name__ == "__main__":
    unittest.main()
