import json
import os
import tempfile
import unittest
from unittest.mock import patch

from app.glovo_export import load_glovo_export


class GlovoExportTests(unittest.TestCase):
    def test_loads_local_export_and_maps_sale_price_and_categories(self):
        with tempfile.TemporaryDirectory() as temp:
            os.makedirs(os.path.join(temp, "restaurants", "sample"))
            with open(os.path.join(temp, "restaurants-index.json"), "w", encoding="utf-8") as out:
                json.dump({"count": 1, "scrapedAt": "2026-10-28T10:00:00Z", "restaurants": [
                    {"name": "Sample Cafe", "slug": "sample", "url": "https://glovo.test/sample",
                     "json": "restaurants/sample/restaurant.json"}
                ]}, out)
            with open(os.path.join(temp, "restaurants", "sample", "restaurant.json"), "w", encoding="utf-8") as out:
                json.dump({"name": "Sample Cafe", "slug": "sample", "glovoUrl": "https://glovo.test/sample",
                           "categories": [{"name": "Tacos", "products": [{"name": "Tacos XL", "price": 50,
                                                                                 "oldPrice": 60, "discount": 10,
                                                                                 "description": "Chicken", "available": True,
                                                                                 "image": "products/tacos.webp"}]}]}, out)
            with patch.dict(os.environ, {"GLOVO_EXPORT_PATH": temp}):
                rows, meta = load_glovo_export()
            self.assertEqual(len(rows), 1)
            self.assertEqual(len(rows[0]["products"]), 1)
            self.assertEqual(rows[0]["products"][0]["sale_price"], 50)
            self.assertEqual(rows[0]["products"][0]["regular_price"], 60)
            self.assertEqual(rows[0]["products"][0]["category"], "Tacos")
            self.assertEqual(meta["restaurants_reported"], 1)


if __name__ == "__main__":
    unittest.main()
