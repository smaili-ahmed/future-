"""Vérifie les prix en direct sur Glovo et Mooup puis met à jour data/seed.json.

Glovo est lu avec Playwright sur chaque fiche restaurant connue de l'export.
Mooup est lu via l'API catalogue partenaire (clé dans .env).
"""

import asyncio
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from app.collector import parse_menu_html  # noqa: E402
from app.mooup_api import MooupCatalogError, fetch_mooup_catalog  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

SEED_PATH = ROOT / "data" / "seed.json"
EXPORT_ROOT = Path(
    os.getenv("GLOVO_EXPORT_PATH", str(Path.home() / "Downloads" / "glovo-clone4" / "export-data"))
)
TIMEOUT = float(os.getenv("LIVE_TIMEOUT", "60"))
DELAY = float(os.getenv("LIVE_DELAY", "1.5"))
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def norm(value):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def price_value(product):
    value = product.get("price")
    return float(value) if isinstance(value, (int, float)) else None


def summarize(old_rows, new_rows, platform, run_id):
    stats = {
        "platform": platform,
        "restaurants": len(new_rows),
        "products": 0,
        "checked": 0,
        "changed": 0,
        "increased": 0,
        "decreased": 0,
        "new": 0,
        "removed": 0,
        "unverified": 0,
        "examples": [],
    }
    for new_rest in new_rows:
        old_rest = next(
            (
                row
                for row in old_rows
                if (row.get("slug") and row.get("slug") == new_rest.get("slug"))
                or (row.get("url") and row.get("url") == new_rest.get("url"))
                or norm(row.get("name")) == norm(new_rest.get("name"))
            ),
            None,
        )
        old_pool = {}
        for product in (old_rest or {}).get("products") or []:
            old_pool.setdefault(norm(product.get("name")), []).append(product)
        seen = set()
        for product in new_rest.get("products") or []:
            stats["products"] += 1
            key = norm(product.get("name"))
            seen.add(key)
            old_product = old_pool.get(key, [None])[0] if old_pool.get(key) else None
            if old_pool.get(key):
                old_pool[key].pop(0)
            if old_product is None:
                stats["new"] += 1
            current = price_value(product)
            if current is None or product.get("price_checked_run") != run_id:
                stats["unverified"] += 1
                continue
            stats["checked"] += 1
            previous = price_value(old_product) if old_product else None
            if previous is not None and abs(previous - current) >= 0.01:
                stats["changed"] += 1
                stats["increased" if current > previous else "decreased"] += 1
                if len(stats["examples"]) < 15:
                    stats["examples"].append(
                        {
                            "restaurant": new_rest.get("name"),
                            "product": product.get("name"),
                            "old": previous,
                            "new": current,
                        }
                    )
        for key, remaining in old_pool.items():
            if key not in seen:
                stats["removed"] += len(remaining)
    return stats


def apply_image_fallbacks(rows, placeholder="/images/placeholder.svg"):
    for row in rows:
        restaurant_image = row.get("image") or placeholder
        row["image"] = restaurant_image
        for product in row.get("products") or []:
            product["image"] = product.get("image") or restaurant_image


def merge_glovo_store(old_store, live_products, collected_at, run_id):
    old_pool = {}
    for product in old_store.get("products") or []:
        old_pool.setdefault(norm(product.get("name")), []).append(product)
    restaurant_image = old_store.get("image")
    merged = []
    for live in live_products:
        key = norm(live.get("name"))
        old = old_pool.get(key, [None])[0] if old_pool.get(key) else None
        if old_pool.get(key):
            old_pool[key].pop(0)
        current = price_value(live)
        previous = price_value(old) if old else None
        image = (old or {}).get("image") or live.get("image") or restaurant_image
        merged.append(
            {
                **(old or {}),
                "name": live.get("name"),
                "description": live.get("description") or (old or {}).get("description"),
                "category": live.get("category") or (old or {}).get("category"),
                "price": current if current is not None else previous,
                "sale_price": live.get("sale_price"),
                "regular_price": live.get("regular_price") or (old or {}).get("regular_price"),
                "currency": live.get("currency") or (old or {}).get("currency"),
                "available": live.get("available"),
                "size": live.get("size") or (old or {}).get("size"),
                "options": (old or {}).get("options") or live.get("options"),
                "image": image,
                "url": live.get("url") or (old or {}).get("url") or old_store.get("url"),
                "collected_at": collected_at,
                "price_source": "glovo live",
                "price_checked_at": collected_at,
                "price_checked_run": run_id,
                "price_previous": previous,
            }
        )
    return merged


async def scrape_store(page, store, collected_at):
    await page.goto(store["url"], wait_until="domcontentloaded", timeout=int(TIMEOUT * 1000))
    await page.locator("body").wait_for(timeout=int(TIMEOUT * 1000))
    await page.wait_for_timeout(700)
    stable = 0
    prior = -1
    for _ in range(8):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(450)
        current = await page.locator('[class*="ItemRow_itemRowBody"]').count()
        stable = stable + 1 if current == prior else 0
        prior = current
        if stable >= 2 and current > 0:
            break
    return parse_menu_html(await page.content(), store["url"], collected_at)


async def main():
    if not SEED_PATH.exists():
        raise SystemExit(f"Seed introuvable: {SEED_PATH}")
    old = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    old_glovo = old.get("restaurants", {}).get("glovo", [])
    old_mooup = old.get("restaurants", {}).get("mooup", [])
    started = now_iso()
    errors = []

    print(f"Mooup: lecture du catalogue en direct…", flush=True)
    try:
        mooup, mooup_meta = await fetch_mooup_catalog()
        print(f"Mooup: {len(mooup)} restaurants, {sum(len(s.get('products') or []) for s in mooup)} produits", flush=True)
    except (MooupCatalogError, Exception) as exc:  # noqa: BLE001
        mooup = old_mooup
        mooup_meta = {"source": "seed précédent", "synced_at": None, "shop_count": len(mooup), "stale_snapshot": True}
        errors.append({"platform": "mooup", "message": f"Lecture live impossible, ancien catalogue conservé : {exc}"})
        print(f"Mooup: échec ({exc}), ancien catalogue conservé", flush=True)

    stores = [row for row in old_glovo if row.get("url")]
    skipped = [row for row in old_glovo if not row.get("url")]
    live_glovo = []
    failed = 0
    for row in skipped:
        live_glovo.append({**row, "menu_collect_status": "missing_url", "price_source": "previous"})
        errors.append({"platform": "glovo", "message": f"URL manquante pour {row.get('name')}."})
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(headless=True)
        context = await browser.new_context(locale="fr-MA", user_agent=UA, viewport={"width": 1366, "height": 900})
        page = await context.new_page()
        for index, store in enumerate(stores, start=1):
            collected_at = now_iso()
            try:
                products = await scrape_store(page, store, collected_at)
                if products:
                    merged = merge_glovo_store(store, products, collected_at, started)
                    live_glovo.append(
                        {
                            **store,
                            "products": merged,
                            "product_count_reported": len(merged),
                            "menu_collect_status": "collected",
                            "collected_at": collected_at,
                            "source": "glovo live",
                        }
                    )
                    print(
                        f"Glovo {index}/{len(stores)} {store.get('name')}: {len(merged)} produits",
                        flush=True,
                    )
                else:
                    failed += 1
                    live_glovo.append(
                        {**store, "menu_collect_status": "live_empty", "price_source": "previous"}
                    )
                    errors.append(
                        {"platform": "glovo", "message": f"Aucun produit live pour {store.get('name')}."}
                    )
                    print(f"Glovo {index}/{len(stores)} {store.get('name')}: aucun produit (ancien conservé)", flush=True)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                live_glovo.append(
                    {**store, "menu_collect_status": "live_failed", "price_source": "previous"}
                )
                errors.append(
                    {"platform": "glovo", "message": f"Échec live pour {store.get('name')} : {type(exc).__name__}: {exc}"}
                )
                print(f"Glovo {index}/{len(stores)} {store.get('name')}: échec ({type(exc).__name__})", flush=True)
            if index < len(stores):
                await asyncio.sleep(DELAY)
        await context.close()
        await browser.close()

    finished = now_iso()
    if not mooup_meta.get("stale_snapshot"):
        for shop in mooup:
            shop["price_source"] = "mooup live"
            for product in shop.get("products") or []:
                product["price_source"] = "mooup live"
                product["price_checked_at"] = finished
                product["price_checked_run"] = started
    apply_image_fallbacks(live_glovo)
    apply_image_fallbacks(mooup)
    glovo_stats = summarize(old_glovo, live_glovo, "glovo", started)
    mooup_stats = summarize(old_mooup, mooup, "mooup", started)

    glovo_products = sum(len(row.get("products") or []) for row in live_glovo)
    mooup_products = sum(len(row.get("products") or []) for row in mooup)
    snapshot = {
        "run": {
            "started_at": started,
            "finished_at": finished,
            "status": "partial" if errors or failed else "completed",
        },
        "restaurants": {
            "glovo": live_glovo,
            "mooup": mooup,
            "_meta": {
                "glovo": {
                    "source": "glovo live",
                    "scraped_at": finished,
                    "restaurants_reported": len(stores),
                    "restaurants_loaded": len(live_glovo),
                    "incomplete": bool(failed or errors),
                    "errors": [item for item in errors if item.get("platform") == "glovo"],
                },
                "mooup": mooup_meta,
            },
        },
        "errors": errors,
        "generated_at": finished,
    }
    SEED_PATH.write_text(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    print("\n=== RÉSUMÉ ===", flush=True)
    print(f"Glovo: {len(live_glovo)} restaurants, {glovo_products} produits", flush=True)
    print(f"Mooup: {len(mooup)} restaurants, {mooup_products} produits", flush=True)
    for stats in (glovo_stats, mooup_stats):
        print(
            f"{stats['platform']}: vérifiés={stats['checked']} modifiés={stats['changed']} "
            f"(+{stats['increased']}/-{stats['decreased']}) nouveaux={stats['new']} "
            f"retirés={stats['removed']} sans prix={stats['unverified']}",
            flush=True,
        )
        for example in stats["examples"]:
            print(
                f"  - {example['restaurant']} | {example['product']}: "
                f"{example['old']} → {example['new']} MAD",
                flush=True,
            )
    print(f"Seed: {SEED_PATH} ({SEED_PATH.stat().st_size / 1024 / 1024:.1f} Mo)", flush=True)
    print(f"Erreurs: {len(errors)}", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
