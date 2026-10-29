import asyncio
import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from .glovo_export import load_glovo_export
from .mooup_api import MooupCatalogError, fetch_mooup_catalog

GLovo_URL = "https://glovoapp.com/en/ma/oujda/categories/food_1"
MOOUP_URL = "https://app.mooup.ma/"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; CatalogResearch/1.0; +public-page analysis)"}


async def fetch(client, url):
    response = await client.get(url, headers=HEADERS, follow_redirects=True)
    response.raise_for_status()
    return response.text, str(response.url)


def _jsonld(soup):
    data = []
    for node in soup.select('script[type="application/ld+json"]'):
        try:
            parsed = json.loads(node.string or node.get_text())
            data.extend(parsed if isinstance(parsed, list) else parsed.get("itemListElement", [parsed]))
        except (ValueError, TypeError):
            continue
    return data


def parse_menu_html(html, store_url, collected_at):
    soup = BeautifulSoup(html, "html.parser")
    products, by_key = [], {}
    # Full menu rows in Glovo's server-rendered store page; product-tile cards are
    # featured duplicates and are only used as fallback where no menu rows exist.
    menu_rows = soup.select("[class*='ItemRow_itemRowBody']")
    for row in menu_rows:
        title_node = row.select_one("[class*='ItemRow_titleContainer']")
        if not title_node:
            continue
        name = " ".join(title_node.get_text(" ", strip=True).split())
        if not name:
            continue
        price_container = row.select_one("[class*='ItemRow_priceContainer']")
        price_nodes = price_container.select("[class*='Price'],[class*='price'],span") if price_container else []
        price_text = " ".join(node.get_text(" ", strip=True) for node in price_nodes) or (price_container.get_text(" ", strip=True) if price_container else "")
        amounts, currency = _parse_amounts(price_text)
        sale_node = row.select_one("[class*='discountedPrice'],[class*='salePrice']")
        regular_node = row.select_one("[class*='originalPrice']")
        current_price = amounts[0] if amounts else None
        regular_price = _parse_amounts(regular_node.get_text(" ", strip=True))[0][0] if regular_node and _parse_amounts(regular_node.get_text(" ", strip=True))[0] else (amounts[1] if len(amounts) > 1 else None)
        description_node = row.select_one("[class*='ItemRow_description']")
        category_list = row.find_parent("div", class_=lambda value: value and "List_list" in value)
        category_node = category_list.select_one(":scope > h3") if category_list else None
        category = category_node.get_text(" ", strip=True) if category_node else None
        outer = row.find_parent("div", class_=lambda value: value and "ListItem_pintxo-list-item__3pwo_" in value)
        image = outer.select_one("img") if outer else None
        product = {"name": name, "description": description_node.get_text(" ", strip=True) if description_node else None,
                   "image": image.get("src") if image else None, "category": category,
                   "price": current_price, "sale_price": current_price if sale_node or (regular_price and current_price and current_price < regular_price) else None,
                   "regular_price": regular_price, "currency": currency, "size": _menu_size(name),
                   "options": None, "available": None, "url": store_url, "collected_at": collected_at}
        key = (normalize_key(name), current_price)
        if key in by_key:
            previous = products[by_key[key]]
            if (not previous.get("category") or normalize_key(previous["category"]) in ("top sellers", "promotions")) and category:
                previous["category"] = category
            if not previous.get("description") and product["description"]:
                previous["description"] = product["description"]
            if product["regular_price"] is not None:
                previous["regular_price"] = product["regular_price"]
                previous["sale_price"] = product["sale_price"]
        else:
            by_key[key] = len(products)
            products.append(product)
    if not products:
        for tile in soup.select('[data-testid="product-tile"]'):
            title = tile.select_one("h3")
            if not title:
                continue
            price_text = " ".join(node.get_text(" ", strip=True) for node in tile.select("[class*='price']"))
            amounts, currency = _parse_amounts(price_text)
            name = title.get_text(" ", strip=True)
            products.append({"name": name, "description": None, "image": (tile.select_one("img[alt]") or {}).get("src"),
                             "category": None, "price": amounts[0] if amounts else None, "sale_price": None,
                             "regular_price": amounts[1] if len(amounts) > 1 else None, "currency": currency,
                             "size": _menu_size(name), "options": None, "available": None,
                             "url": store_url, "collected_at": collected_at})
    return products


def _parse_amounts(text):
    amounts = []
    for match in re.finditer(r"(\d[\d\s\u00a0.,]*)\s*(MAD|DH|د\.م\.)", text, re.I):
        try:
            value = float(match.group(1).replace(" ", "").replace("\u00a0", "").replace(",", "."))
            if value not in amounts:
                amounts.append(value)
        except ValueError:
            continue
    currency = "MAD" if re.search(r"\b(MAD|DH)\b|د\.م\.", text, re.I) else None
    return amounts, currency


def normalize_key(value):
    return re.sub(r"[^a-z0-9]+", " ", (value or "").casefold()).strip()


def _menu_size(name):
    match = re.search(r"\b(?:XS|S|M|L|XL|XXL|small|medium|large|mini|maxi|\d+\s?(?:cl|ml|l|g|kg))\b", name or "", re.I)
    return match.group(0) if match else None


async def collect_platforms(on_progress=None):
    timeout = float(os.getenv("REQUEST_TIMEOUT", "20"))
    errors, collected = [], {"glovo": [], "mooup": [], "_meta": {}}
    collected_at = datetime.now(timezone.utc).isoformat()
    driver = browser = page = None
    try:
        glovo_export = load_glovo_export()
    except (OSError, ValueError, KeyError) as exc:
        glovo_export = None
        errors.append({"platform": "glovo-export", "message": f"Export Glovo illisible : {type(exc).__name__}: {exc}"})
    async with httpx.AsyncClient(timeout=timeout) as client:
        for key, url in (("glovo", GLovo_URL), ("mooup", MOOUP_URL)):
            if key == "glovo" and glovo_export:
                collected[key], metadata = glovo_export
                errors.extend(metadata.pop("errors", []))
                collected["_meta"]["glovo"] = metadata
                if on_progress:
                    on_progress("Glovo : import de l’export local", len(collected[key]),
                                sum(len(item.get("products", [])) for item in collected[key]), errors)
                continue
            if key == "mooup" and os.getenv("MOOUP_CATALOG_API_KEY", "").strip():
                try:
                    collected[key], metadata = await fetch_mooup_catalog()
                    collected["_meta"]["mooup"] = metadata
                except MooupCatalogError as exc:
                    errors.append({"platform": "mooup", "message": str(exc)})
                except Exception as exc:
                    errors.append({"platform": "mooup", "message": f"Erreur API Mooup : {type(exc).__name__}: {exc}"})
                continue
            try:
                html, final_url = await fetch(client, url)
                soup = BeautifulSoup(html, "html.parser")
                if key == "glovo":
                    seen = set()
                    for link in soup.select('a[data-testid="store-card"][href], a[href*="/stores/"]'):
                        image = link.select_one("img[alt]")
                        name = image.get("alt", "") if image else " ".join(link.get_text(" ", strip=True).split())
                        href = urljoin(final_url, link.get("href", ""))
                        if name and len(name) > 2 and "/stores/" in href:
                            norm = re.sub(r"\W+", "", name.casefold())
                            if norm not in seen:
                                logo = image.get("src") if image else None
                                collected[key].append({"name": name, "url": href, "platform": key, "image": logo,
                                                       "products": [], "category": "Food", "collected_at": collected_at,
                                                       "menu_collect_status": "not_collected"})
                                seen.add(norm)
                    # Use a normal headless browser to read the public, server-rendered menu
                    # sections that are not present in the featured product tiles.
                    delay = float(os.getenv("REQUEST_DELAY_SECONDS", "1"))
                    total_stores = len(collected[key])
                    if os.getenv("USE_PLAYWRIGHT", "true").casefold() in ("1", "true", "yes"):
                        try:
                            driver = await async_playwright().start()
                            browser = await driver.chromium.launch(headless=True)
                            page = await browser.new_page(locale="fr-MA")
                        except Exception as exc:
                            errors.append({"platform": "glovo", "message": f"Navigateur Playwright indisponible, repli HTTP partiel : {type(exc).__name__}: {exc}"})
                            if browser:
                                await browser.close()
                            if driver:
                                await driver.stop()
                            driver = browser = page = None
                    if on_progress:
                        on_progress("Glovo : fiches restaurants", 0, 0, errors)
                    for index, store in enumerate(collected[key]):
                        try:
                            if page:
                                await page.goto(store["url"], wait_until="domcontentloaded", timeout=int(timeout * 1000))
                                await page.locator("body").wait_for(timeout=int(timeout * 1000))
                                await page.wait_for_timeout(500)
                                stable_rounds = 0
                                prior_count = -1
                                for _ in range(6):
                                    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                                    await page.wait_for_timeout(250)
                                    current_count = await page.locator("[class*=ItemRow_itemRowBody]").count()
                                    stable_rounds = stable_rounds + 1 if current_count == prior_count else 0
                                    prior_count = current_count
                                    if stable_rounds >= 2:
                                        break
                                store_html = await page.content()
                            else:
                                store_html, _ = await fetch(client, store["url"])
                            products = parse_menu_html(store_html, store["url"], collected_at)
                            store["products"] = products
                            store["menu_collect_status"] = "collected" if products else "empty_or_unavailable"
                            if not products:
                                errors.append({"platform": "glovo", "message": f"Aucun produit visible/extrait sur la fiche de {store['name']}. Le menu est non vérifiable."})
                        except Exception as exc:
                            store["menu_collect_status"] = "failed"
                            errors.append({"platform": "glovo", "message": f"Fiche inaccessible pour {store['name']} : {type(exc).__name__}: {exc}"})
                        if index < len(collected[key]) - 1:
                            await asyncio.sleep(delay)
                        if on_progress:
                            on_progress(f"Glovo : fiches restaurants ({index + 1}/{total_stores})", index + 1,
                                        sum(len(row.get("products", [])) for row in collected[key]), errors)
                    # Fallback to real visible store names when markup omits linked store URLs.
                    if not collected[key]:
                        for item in _jsonld(soup):
                            obj = item.get("item", item) if isinstance(item, dict) else {}
                            if isinstance(obj, dict) and obj.get("name"):
                                collected[key].append({"name": obj["name"], "url": obj.get("url"), "platform": key,
                                                       "products": [], "category": "Food", "collected_at": None})
                    if browser:
                        await browser.close()
                        await driver.stop()
                        browser = driver = page = None
                else:
                    collected[key] = []
                    # Public landing page doesn't expose the merchant catalog; keep this explicit.
                    errors.append({"platform": "mooup", "message": "Page publique accessible, mais aucun catalogue restaurant exploitable sans navigation/adresse ou accès authentifié."})
            except Exception as exc:
                errors.append({"platform": key, "message": f"Collecte inaccessible : {type(exc).__name__}: {exc}"})
            await asyncio.sleep(float(os.getenv("REQUEST_DELAY_SECONDS", "2")))
    if browser:
        await browser.close()
    if driver:
        await driver.stop()
    return collected, errors
