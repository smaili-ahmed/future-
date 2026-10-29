import unittest

from fastapi import HTTPException

from app.main import build_catalog_comparison, catalog_comparison, resolve_catalog_pair


def product(name, price, category="Plats", description="", currency="MAD", **extra):
    base = {"name": name, "price": price, "category": category, "description": description,
            "currency": currency, "image": None, "url": "https://example.test/fiche",
            "available": True, "options": [], "variants": []}
    base.update(extra)
    return base


def make_data(glovo_products, mooup_products, mooup_name="Chez Test M", overrides=None,
              run_status="completed", imported=True):
    return {
        "run": {"status": run_status},
        "restaurants": {
            "glovo": [{"name": "Chez Test", "products": glovo_products, "category": "Fast-food",
                       "collected_at": "2026-10-28T10:00:00+00:00", "source": "export local glovo-clone4",
                       "url": "https://glovo.test/chez-test"}],
            "mooup": [{"name": mooup_name, "products": mooup_products, "category": "Grills",
                       "collected_at": "2026-10-28T23:00:00+00:00", "source": "MOOUP catalog:read",
                       "url": "https://mooup.test/chez-test-m"}],
            "_meta": {},
        },
        "match_overrides": overrides if overrides is not None else [
            {"glovo_name": "Chez Test", "mooup_name": mooup_name, "status": "confirmed"}],
        "mooup_imported_at": "2026-10-29T09:00:00+00:00" if imported else None,
    }


def paired_row(result):
    return next(row for row in result["rows"] if row["kind"] == "paired")


class CatalogCoverageTests(unittest.TestCase):
    def test_every_product_appears_exactly_once(self):
        data = make_data(
            [product("Burger", 50), product("Tacos poulet", 40), product("Salade", 30)],
            [product("Burger", 45), product("Pizza", 60), product("Jus", 15), product("Tacos", 38)])
        result = build_catalog_comparison(data, "Chez Test")
        glovo_names = [row["glovo_product"]["name"] for row in result["rows"] if row["glovo_product"]]
        mooup_names = [row["mooup_product"]["name"] for row in result["rows"] if row["mooup_product"]]
        self.assertEqual(sorted(glovo_names), ["Burger", "Salade", "Tacos poulet"])
        self.assertEqual(sorted(mooup_names), ["Burger", "Jus", "Pizza", "Tacos"])
        self.assertEqual(len(glovo_names), len(set(glovo_names)))
        self.assertEqual(len(mooup_names), len(set(mooup_names)))
        self.assertEqual(result["summary"]["glovo_products"], 3)
        self.assertEqual(result["summary"]["mooup_products"], 4)
        self.assertEqual(result["summary"]["paired"], 2)
        self.assertEqual(result["summary"]["missing_mooup"], 1)
        self.assertEqual(result["summary"]["missing_glovo"], 2)
        self.assertEqual(len(result["rows"]), 5)
        self.assertEqual(result["rows"][0]["kind"], "paired")

    def test_reverse_rows_never_carry_a_price_delta(self):
        data = make_data([product("Burger", 50)],
                         [product("Burger", 45), product("Pizza margherita", 70)])
        result = build_catalog_comparison(data, "Chez Test")
        reverse = next(row for row in result["rows"]
                       if row["mooup_product"] and row["mooup_product"]["name"] == "Pizza margherita")
        self.assertEqual(reverse["kind"], "mooup_only")
        self.assertIsNone(reverse["delta"])
        self.assertIsNone(reverse["percent"])
        self.assertFalse(reverse["uncertain"])

    def test_single_sided_rows_have_no_price_comparison(self):
        data = make_data([product("Burger", 50), product("Salade", 30)],
                         [product("Burger", 45)])
        result = build_catalog_comparison(data, "Chez Test")
        solo = next(row for row in result["rows"]
                    if row["glovo_product"] and row["glovo_product"]["name"] == "Salade")
        self.assertEqual(solo["kind"], "glovo_only")
        self.assertIsNone(solo["delta"])
        self.assertFalse(solo["uncertain"])

    def test_without_mooup_match_every_product_is_missing(self):
        data = make_data([product("Burger", 50), product("Salade", 30)], [],
                         mooup_name="Chez Test M", overrides=[])
        data["restaurants"]["mooup"][0]["name"] = "Nom Entirement Different"
        result = build_catalog_comparison(data, "Chez Test")
        self.assertEqual(result["match"]["status"], "missing")
        self.assertIsNone(result["mooup"])
        self.assertEqual(result["summary"]["paired"], 0)
        self.assertEqual(result["summary"]["missing_mooup"], 2)
        self.assertEqual(result["summary"]["mooup_products"], 0)
        self.assertTrue(all(row["kind"] == "glovo_only" for row in result["rows"]))


class PriceComparisonTests(unittest.TestCase):
    def test_delta_is_glovo_minus_mooup_with_positive_percent(self):
        data = make_data([product("Burger", 50)], [product("Burger", 45)])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertEqual(row["delta"], 5.0)
        self.assertEqual(row["percent"], 11.11)
        self.assertEqual(row["cheaper"], "Mooup")

    def test_negative_delta_means_mooup_is_more_expensive(self):
        data = make_data([product("Burger", 40)], [product("Burger", 50)])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertEqual(row["delta"], -10.0)
        self.assertEqual(row["percent"], -20.0)
        self.assertEqual(row["cheaper"], "Glovo")

    def test_identical_prices_are_counted_separately(self):
        data = make_data([product("Burger", 30)], [product("Burger", 30)])
        result = build_catalog_comparison(data, "Chez Test")
        self.assertEqual(paired_row(result)["delta"], 0)
        self.assertEqual(result["summary"]["price_identical"], 1)
        self.assertEqual(result["summary"]["price_gaps"], 0)

    def test_anomalous_prices_are_flagged_but_excluded_from_gaps(self):
        data = make_data([product("Tajine", 45000)], [product("Tajine", 45)])
        result = build_catalog_comparison(data, "Chez Test")
        row = paired_row(result)
        self.assertTrue(row["price_anomaly"])
        self.assertIsNotNone(row["delta"])
        self.assertEqual(result["summary"]["anomalies"], 1)
        self.assertEqual(result["summary"]["price_gaps"], 0)
        self.assertEqual(result["summary"]["comparable"], 1)

    def test_missing_price_gives_no_percent(self):
        data = make_data([product("Burger", None)], [product("Burger", 45)])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertIsNone(row["delta"])
        self.assertIsNone(row["percent"])


class UncertaintyTests(unittest.TestCase):
    def test_size_mismatch_is_flagged_and_not_compared(self):
        data = make_data([product("Burger", 50, size="XL")], [product("Burger", 45, size="S")])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertTrue(row["size_mismatch"])
        self.assertTrue(row["uncertain"])
        self.assertIsNone(row["delta"])

    def test_substantive_description_difference_marks_content(self):
        data = make_data(
            [product("Burger", 50, description="Pain brioche, steak hache, cheddar fondant")],
            [product("Burger", 45, description="Riz basmati, poulet grille, sauce soja")])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertTrue(row["content_different"])
        self.assertTrue(row["uncertain"])

    def test_description_that_just_repeats_the_name_is_not_a_difference(self):
        data = make_data([product("Burger", 50)], [product("Burger", 45, description="Burger")])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertFalse(row["content_different"])
        self.assertFalse(row["uncertain"])

    def test_low_confidence_pair_is_marked_uncertain(self):
        data = make_data([product("Burger", 50, category="Burgers")],
                         [product("Burger", 45, category="Snacks")])
        row = paired_row(build_catalog_comparison(data, "Chez Test"))
        self.assertLess(row["confidence"], 0.70)
        self.assertTrue(row["uncertain"])
        self.assertEqual(row["delta"], 5.0)

    def test_ambiguous_candidate_reason_marks_uncertain(self):
        data = make_data([product("Burger", 50), product("Burger royal", 55)],
                         [product("Burger", 45), product("Burger", 46)])
        result = build_catalog_comparison(data, "Chez Test")
        uncertain = [row for row in result["rows"] if row["kind"] == "paired" and row["uncertain"]]
        self.assertTrue(uncertain)


class CatalogMetadataTests(unittest.TestCase):
    def test_categories_and_summary_use_each_own_source(self):
        data = make_data([product("Burger", 50, category="Burgers")],
                         [product("Burger", 45, category="Snacks"),
                          product("Tajine", 45000, category="Plats")])
        result = build_catalog_comparison(data, "Chez Test")
        self.assertEqual(result["glovo_categories"], ["Burgers"])
        self.assertEqual(result["mooup_categories"], ["Snacks", "Plats"])
        self.assertEqual(result["rows"][0]["category"], "Burgers")
        tajine = next(row for row in result["rows"] if row["kind"] == "mooup_only")
        self.assertEqual(tajine["category"], "Plats")
        self.assertEqual(result["summary"]["anomalies"], 1)

    def test_rows_carry_currency_and_restaurant_info(self):
        data = make_data([product("Burger", 50)], [product("Burger", 45)])
        result = build_catalog_comparison(data, "Chez Test")
        self.assertEqual(paired_row(result)["currency"], "MAD")
        self.assertEqual(result["glovo"]["products_count"], 1)
        self.assertEqual(result["glovo"]["source"], "export local glovo-clone4")
        self.assertEqual(result["mooup"]["products_count"], 1)
        self.assertTrue(result["meta"]["glovo_available"])
        self.assertTrue(result["meta"]["mooup_catalog_available"])
        self.assertEqual(result["meta"]["mooup_last_sync"], "2026-10-29T09:00:00+00:00")

    def test_failed_run_marks_glovo_catalog_unavailable(self):
        data = make_data([product("Burger", 50)], [product("Burger", 45)], run_status="failed")
        result = build_catalog_comparison(data, "Chez Test")
        self.assertFalse(result["meta"]["glovo_available"])

    def test_unknown_restaurant_raises_404(self):
        data = make_data([product("Burger", 50)], [product("Burger", 45)])
        with self.assertRaises(HTTPException) as ctx:
            resolve_catalog_pair(data, "Restaurant inconnu")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_unknown_mooup_restaurant_raises_404(self):
        data = make_data([product("Burger", 50)], [product("Burger", 45)])
        with self.assertRaises(HTTPException) as ctx:
            resolve_catalog_pair(data, "Chez Test", "Fiche Mooup inexistante")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_empty_restaurant_name_raises_400(self):
        with self.assertRaises(HTTPException) as ctx:
            catalog_comparison("")
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
