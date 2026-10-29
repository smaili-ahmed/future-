import unittest

from app.collector import parse_menu_html


class MenuParserTests(unittest.TestCase):
    def test_extracts_menu_product_description_category_and_discount(self):
        html = '''<div class="List_list"><h3>Tacos</h3><div class="ItemRow_itemRowBody">
          <div class="ItemRow_headerContainer"><div class="ItemRow_titleContainer"><p>Menu Tacos XL</p></div>
          <div class="ItemRow_priceContainer"><span class="ItemRow_discountedPrice">50,00 MAD</span><span class="ItemRow_originalPrice">60,00 MAD</span></div></div>
          <p class="ItemRow_description">Poulet, frites et boisson</p></div></div>'''
        products = parse_menu_html(html, "https://example.test/menu", "2026-01-01T00:00:00+00:00")
        self.assertEqual(len(products), 1)
        self.assertEqual(products[0]["name"], "Menu Tacos XL")
        self.assertEqual(products[0]["category"], "Tacos")
        self.assertEqual(products[0]["price"], 50)
        self.assertEqual(products[0]["regular_price"], 60)
        self.assertEqual(products[0]["sale_price"], 50)
        self.assertEqual(products[0]["currency"], "MAD")
        self.assertEqual(products[0]["description"], "Poulet, frites et boisson")


if __name__ == "__main__":
    unittest.main()
