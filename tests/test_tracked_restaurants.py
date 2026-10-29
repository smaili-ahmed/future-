import os
import tempfile
import unittest
from unittest.mock import patch

from app import db
from app.main import (ABSENCE_THRESHOLD, build_common_restaurants, build_tracked_restaurants,
                      classify_tracked, format_working_days, implausible_price, is_reliable_match)
from app.seed_data import MANUALLY_VALIDATED_MISSING, WATCHLIST_NAMES


def found(name, score=1.0, ambiguous=False, candidate=None):
    listing = {"name": name, "products": [{"name": "Plat"}]} if name else None
    return {"listing": listing, "score": score, "ambiguous": ambiguous,
            "alternatives": [], "candidate": candidate or name, "candidate_score": score}


def absent(best_score=0.2, candidate="Autre restaurant"):
    return {"listing": None, "score": best_score, "ambiguous": False,
            "alternatives": [], "candidate": candidate, "candidate_score": best_score}


class ClassificationTests(unittest.TestCase):
    def test_absent_from_mooup_is_only_declared_with_verified_absence(self):
        status, reason = classify_tracked(found("ROMANO"), absent(0.3), True, True, mooup_count=34)
        self.assertEqual(status, "glovo_only")
        self.assertIn("34", reason)

    def test_close_mooup_candidate_stays_to_verify(self):
        status, reason = classify_tracked(found("Blankok Burger"), absent(0.72, "Beau Burger"), True, True, 34)
        self.assertEqual(status, "to_verify")
        self.assertIn("Beau Burger", reason)

    def test_candidate_just_below_presence_threshold_stays_to_verify(self):
        self.assertGreater(0.68, ABSENCE_THRESHOLD)
        status, _ = classify_tracked(found("Snack Mehdi"), absent(0.67, "Snack Bnin"), True, True, 34)
        self.assertEqual(status, "to_verify")

    def test_missing_mooup_catalog_never_proves_absence(self):
        status, reason = classify_tracked(found("ROMANO"), absent(), True, False, 0)
        self.assertEqual(status, "to_verify")
        self.assertIn("indisponible", reason)

    def test_present_on_both_platforms_goes_to_comparison(self):
        status, reason = classify_tracked(found("Aura"), found("Aura Mooup", 0.99), True, True, 34)
        self.assertEqual(status, "both")
        self.assertIn("Aura Mooup", reason)

    def test_failed_glovo_scraping_yields_insufficient_data(self):
        status, reason = classify_tracked(found("ROMANO"), absent(), False, True, 34)
        self.assertEqual(status, "insufficient")
        self.assertIn("Collecte Glovo indisponible", reason)

    def test_unknown_restaurant_is_not_declared_absent(self):
        status, _ = classify_tracked(absent(0.4), absent(0.4), True, True, 34)
        self.assertEqual(status, "to_verify")

    def test_found_only_on_mooup_is_reported_as_mooup_only(self):
        status, _ = classify_tracked(absent(0.4), found("Aura"), True, True, 34)
        self.assertEqual(status, "mooup_only")

    def test_no_data_on_either_side_without_mooup_catalog_is_insufficient(self):
        status, _ = classify_tracked(absent(0.4), absent(0.4), True, False, 0)
        self.assertEqual(status, "insufficient")


class TrackedListTests(unittest.TestCase):
    def build(self, glovo, mooup, mooup_available=True, glovo_ok=True):
        data = {"run": {"finished_at": "2026-01-02T10:00:00+00:00", "status": "completed" if glovo_ok else "failed"},
                "restaurants": {"glovo": glovo, "mooup": mooup},
                "mooup_catalog_available": mooup_available}
        return build_tracked_restaurants(data)

    def test_keeps_45_entries_manual_first_and_duplicates_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "tracked.sqlite3")):
                db.initialize()
                rows = self.build([{"name": "ROMANO"}], [])
                self.assertEqual(len(rows), 45)
                self.assertEqual([row["name"] for row in rows[:3]], list(MANUALLY_VALIDATED_MISSING))
                self.assertTrue(all(row["manual"] for row in rows[:3]))
                self.assertFalse(any(row["manual"] for row in rows[3:]))
                self.assertEqual(len(rows[3:]), len(WATCHLIST_NAMES))
                duplicates = {row["name"]: row["duplicate_count"] for row in rows if row["duplicate_warning"]}
                self.assertEqual(duplicates, {"Smash N Tacos": 2, "Café Restaurant Al Hanine": 2, "Chez Rémy": 2})

    def test_distinct_establishments_are_never_merged(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "tracked2.sqlite3")):
                db.initialize()
                rows = self.build([], [])
                names = [row["name"] for row in rows]
                self.assertIn("Pause À Paris", names)
                self.assertIn("Pause à Paris Pâtisserie", names)
                self.assertIn("Opheon", names)
                self.assertIn("Le petit-déjeuner Opheon", names)
                self.assertNotEqual(rows[names.index("Pause À Paris")]["normalized_name"],
                                    rows[names.index("Pause à Paris Pâtisserie")]["normalized_name"])

    def test_status_uses_collected_data_and_manual_entries_survive(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "tracked3.sqlite3")):
                db.initialize()
                db.update_user_missing("City Meal", "Présence Mooup détectée — à vérifier", "2026-02-01T00:00:00+00:00")
                glovo = [{"name": name, "products": [{"name": "Plat source"}]}
                         for name in ("City Meal", "Smash N Tacos", "Mr chef", "ROMANO")]
                mooup = [{"name": "ROMANO"}]
                rows = self.build(glovo, mooup)
                by_name = {row["name"]: row for row in rows}
                self.assertEqual(by_name["ROMANO"]["status"], "both")
                self.assertEqual(by_name["City Meal"]["status"], "glovo_only")
                self.assertEqual(by_name["City Meal"]["products_count"], 1)
                self.assertIsNotNone(by_name["City Meal"]["last_verified_at"])
                _, manual, history = db.seed_observations()
                self.assertEqual(len(manual), 3)
                self.assertGreater(len(history), 3)

    def test_unavailable_sources_never_produce_verified_absence(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "tracked4.sqlite3")):
                db.initialize()
                rows = self.build([{"name": "ROMANO"}], [], mooup_available=False)
                self.assertNotIn("glovo_only", {row["status"] for row in rows})
                failed = self.build([{"name": "ROMANO"}], [], glovo_ok=False)
                self.assertEqual({row["status"] for row in failed}, {"insufficient"})


class CommonRestaurantsTests(unittest.TestCase):
    def test_includes_reliable_matches_only_and_counts_price_gaps(self):
        data = {"restaurants": {"glovo": [{"name": "Nara", "category": "Sushi", "products": [{"name": "a"}]}],
                                "mooup": [{"name": "Nara Sushi", "category": "Sushi", "products": [{"name": "a"}]}]},
                "matches": [
                    {"glovo_name": "Nara", "mooup_name": "Nara Sushi", "status": "review", "confidence": 0.72, "reasons": ["nom"]},
                    {"glovo_name": "Blankok", "mooup_name": "Beau Burger", "status": "review", "confidence": 0.52, "reasons": []},
                    {"glovo_name": "Solo", "mooup_name": None, "status": "missing", "confidence": 0.1, "reasons": []},
                ],
                "product_comparisons": [
                    {"restaurant": "Nara", "glovo_product": {"name": "a"}, "mooup_product": {"name": "a"}, "delta": 5.0, "price_anomaly": False},
                    {"restaurant": "Nara", "glovo_product": {"name": "b"}, "mooup_product": {"name": "b"}, "delta": 0, "price_anomaly": False},
                    {"restaurant": "Nara", "glovo_product": {"name": "c"}, "mooup_product": {"name": "c"}, "delta": 10.0, "price_anomaly": True},
                ],
                "tracked_restaurants": []}
        rows, excluded = build_common_restaurants(data)
        self.assertEqual(excluded, 1)
        self.assertEqual([row["name"] for row in rows], ["Nara"])
        row = rows[0]
        self.assertEqual(row["glovo_products"], 1)
        self.assertEqual(row["comparable_products"], 3)
        self.assertEqual(row["price_gaps"], 1)
        self.assertEqual(row["price_anomalies"], 1)

    def test_confirmed_match_with_low_confidence_is_kept(self):
        self.assertTrue(is_reliable_match({"mooup_name": "X", "status": "confirmed", "confidence": 0.5}))
        self.assertTrue(is_reliable_match({"mooup_name": "X", "status": "review", "confidence": 0.72}))
        self.assertFalse(is_reliable_match({"mooup_name": "X", "status": "review", "confidence": 0.55}))
        self.assertFalse(is_reliable_match({"mooup_name": None, "status": "review", "confidence": 0.99}))
        self.assertFalse(is_reliable_match({"mooup_name": "X", "status": "missing", "confidence": 0.99}))


class DataQualityTests(unittest.TestCase):
    def test_implausible_price_is_flagged_not_corrected(self):
        self.assertTrue(implausible_price(45973.0))
        self.assertTrue(implausible_price(0))
        self.assertTrue(implausible_price("abc"))
        self.assertFalse(implausible_price(25.0))
        self.assertFalse(implausible_price(None))

    def test_working_days_are_formatted_for_display(self):
        days = [{"day": "monday", "from": "11-30", "to": "23-00", "disabled": False},
                {"day": "tuesday", "from": "11-30", "to": "23-00", "disabled": True},
                {"day": "friday", "from": "12-00", "to": "22-00", "disabled": False}]
        self.assertEqual(format_working_days(days), "Lun 11:30–23:00 · Ven 12:00–22:00")
        self.assertIsNone(format_working_days([]))
        self.assertIsNone(format_working_days(None))


if __name__ == "__main__":
    unittest.main()
