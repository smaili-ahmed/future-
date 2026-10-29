import unittest

from app.matching import normalize, price_comparison, restaurant_matches, match_products


class MatchingTests(unittest.TestCase):
    def test_normalize_accents_punctuation_and_case(self):
        self.assertEqual(normalize("  Café— Oujda! "), "cafe oujda")

    def test_restaurant_missing_and_probable(self):
        results = restaurant_matches([{"name": "Café Oujda"}, {"name": "New Place"}],
                                     [{"name": "Cafe Oujda"}])
        self.assertEqual(results[0]["status"], "review")
        self.assertEqual(results[1]["status"], "missing")

    def test_restaurant_requires_an_independent_signal_to_confirm(self):
        results = restaurant_matches([{"name": "Cafe Oujda", "address": "Rue 1, Oujda"}],
                                     [{"name": "Café Oujda", "address": "Rue 1, Oujda"}])
        self.assertEqual(results[0]["status"], "confirmed")

    def test_price_delta_and_zero_base(self):
        self.assertEqual(price_comparison(20, 25), {"delta": 5.0, "percent": 25.0, "cheaper": "Mooup"})
        self.assertIsNone(price_comparison(0, 12)["percent"])
        self.assertIsNone(price_comparison(None, 12)["delta"])

    def test_size_mismatch_needs_review(self):
        result = match_products([{"name": "Tacos poulet", "size": "L", "price": 40}],
                                [{"name": "Tacos poulet", "size": "M", "price": 30}])[0]
        self.assertEqual(result["status"], "review")
        self.assertIsNone(result["price"])

    def test_product_description_and_category_raise_confidence(self):
        result = match_products([{"name": "Burger cheese", "description": "Boeuf, cheddar", "category": "Burger", "price": 50, "currency": "MAD"}],
                                [{"name": "Burger cheese", "description": "Boeuf, cheddar", "category": "Burger", "price": 48, "currency": "MAD"}])[0]
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["price"]["delta"], 2)

    def test_product_match_does_not_reuse_one_mooup_listing(self):
        pairs = match_products([{"name": "Cheese burger", "price": 40}, {"name": "Cheese burger", "price": 45}],
                               [{"name": "Cheese burger", "price": 42}])
        self.assertEqual(sum(pair["mooup"] is not None for pair in pairs), 1)
        self.assertEqual(sum(pair["mooup"] is None for pair in pairs), 1)

    def test_price_is_not_compared_across_unknown_or_different_currencies(self):
        result = match_products([{"name": "Meal", "description": "same", "price": 20, "currency": "MAD"}],
                                [{"name": "Meal", "description": "same", "price": 4, "currency": "EUR"}])[0]
        self.assertIsNone(result["price"])


if __name__ == "__main__":
    unittest.main()
