import asyncio
import os
import unittest
from unittest.mock import patch

from app.mooup_api import MooupCatalogError, _normalize_shop, fetch_mooup_catalog


class MooupApiTests(unittest.TestCase):
    def test_maps_catalog_prices_variants_and_shop_location(self):
        shop = _normalize_shop({"id": 4, "name": "Test Shop", "status": "approved",
                                "category": {"name": "Food"},
                                "location": {"address": "Oujda", "latitude": "34.68"},
                                "availability": {"open": True},
                                "products": [{"id": 8, "name": "Test Meal", "price": "50.00",
                                              "original_price": "60.00", "discounted_price": "50.00",
                                              "currency": "MAD", "available": True,
                                              "category": {"name": "Meals"}, "variants": [{"id": 3, "sku": "M"}],
                                              "images": ["https://example.test/meal.png"]}]})
        product = shop["products"][0]
        self.assertEqual(shop["address"], "Oujda")
        self.assertEqual(shop["category"], "Food")
        self.assertEqual(product["price"], 50)
        self.assertEqual(product["regular_price"], 60)
        self.assertEqual(product["currency"], "MAD")
        self.assertEqual(product["variants"][0]["sku"], "M")
        self.assertEqual(product["image"], "https://example.test/meal.png")

    def test_missing_key_fails_without_network_or_exposing_key(self):
        with patch.dict(os.environ, {"MOOUP_CATALOG_API_KEY": ""}, clear=False):
            with self.assertRaises(MooupCatalogError) as error:
                asyncio.run(fetch_mooup_catalog())
        self.assertIn("n’est pas configurée", str(error.exception))


if __name__ == "__main__":
    unittest.main()
