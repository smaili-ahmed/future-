import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import db
from app.main import app
from app.matching import restaurant_matches


class CatalogImportTests(unittest.TestCase):
    def test_import_json_catalog_and_report_it(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "test.sqlite3")):
                with TestClient(app) as client:
                    response = client.post("/api/import/mooup", json={"restaurants": [
                        {"name": "Test Mooup", "products": [{"name": "Test Dish", "price": 25}]}
                    ]})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["products"], 1)
                    report = client.get("/api/report").json()
                    self.assertEqual(report["restaurants"]["mooup"][0]["name"], "Test Mooup")
                    self.assertEqual(report["quality"]["products_mooup"], 1)
                    self.assertEqual(report["manual_missing_initial_count"], 3)
                    self.assertEqual(report["watchlist_count"], 42)
                    self.assertEqual(report["watchlist_exact_duplicates"], 2)

    def test_invalid_import_returns_400_without_replacing_catalog(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "test.sqlite3")):
                with TestClient(app) as client:
                    response = client.post("/api/import/mooup?format=json", content="not json")
                    self.assertEqual(response.status_code, 400)

    def test_imported_catalog_produces_computed_price_report_and_history(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(db, "DB_PATH", os.path.join(temp, "test.sqlite3")):
                with TestClient(app) as client:
                    glovo = [{"name": "Cafe Test", "address": "Rue Test", "url": "https://glovo.test/cafe",
                              "products": [{"name": "Burger Test", "price": 45, "currency": "MAD",
                                            "description": "Boeuf cheddar", "category": "Burger"}]}]
                    mooup = [{"name": "Cafe Test", "address": "Rue Test", "url": "https://mooup.test/cafe",
                              "products": [{"name": "Burger Test", "price": 40, "currency": "MAD",
                                            "description": "Boeuf cheddar", "category": "Burger"}]}]
                    matches = restaurant_matches(glovo, mooup)
                    self.assertEqual(matches[0]["status"], "confirmed")
                    run_id = db.save_run("2026-01-01T00:00:00+00:00", "2026-01-01T00:01:00+00:00",
                                         "completed", {"glovo": glovo, "mooup": []},
                                         restaurant_matches(glovo, []), [])
                    response = client.post("/api/import/mooup", json={"restaurants": mooup})
                    self.assertEqual(response.status_code, 200)
                    report = client.get("/api/report").json()
                    self.assertEqual(report["price_comparisons"][0]["delta"], 5)
                    self.assertEqual(report["price_comparisons"][0]["percent"], 12.5)
                    self.assertEqual(report["price_history"][0]["run_id"], run_id)


if __name__ == "__main__":
    unittest.main()
