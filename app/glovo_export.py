"""Load the user's complete, already-scraped Glovo export without modifying it."""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from .matching import normalize


def export_root() -> Path:
    configured = os.getenv("GLOVO_EXPORT_PATH")
    return Path(configured).expanduser().resolve() if configured else (Path.home() / "Downloads" / "glovo-clone4" / "export-data").resolve()


def load_glovo_export():
    root = export_root()
    index_path = root / "restaurants-index.json"
    if not index_path.is_file():
        return None
    index = json.loads(index_path.read_text(encoding="utf-8"))
    rows, errors = [], []
    scraped_at = index.get("scrapedAt") or index.get("exportedAt") or datetime.now(timezone.utc).isoformat()
    for entry in index.get("restaurants", []):
        rel = Path(entry.get("json", ""))
        file_path = (root / rel).resolve()
        if not file_path.is_relative_to(root) or not file_path.is_file():
            errors.append({"platform": "glovo-export", "message": f"Fiche JSON manquante/invalide pour {entry.get('name', 'restaurant inconnu')}"})
            continue
        try:
            source = json.loads(file_path.read_text(encoding="utf-8"))
            products = _products(source, entry, root, scraped_at)
            slug = source.get("slug") or entry.get("slug") or file_path.parent.name
            missing = bool(source.get("dataMissing"))
            if missing:
                errors.append({"platform": "glovo-export", "message": f"L’export signale des données partielles pour {source.get('name') or entry.get('name')}"})
            rows.append({"id": source.get("glovoStoreId") or slug, "slug": slug,
                         "name": source.get("name") or entry.get("name"),
                         "url": source.get("glovoUrl") or entry.get("url"),
                         "image": _asset_url(slug, source.get("logoUrl") or source.get("image")),
                         "category": ", ".join(source.get("cuisines") or []) or "Food",
                         "address": source.get("address"), "rating": source.get("rating"),
                         "reviews": source.get("reviews"), "promotion": source.get("promotion"),
                         "available": source.get("open"), "data_missing": source.get("dataMissing"),
                         "products": products, "product_count_reported": sum(len(c.get("products", [])) for c in source.get("categories", [])),
                         "menu_collect_status": "partial" if missing else "collected",
                         "collected_at": source.get("scrapedAt") or scraped_at, "platform": "glovo",
                         "source": "export local glovo-clone4", "raw": source})
        except (OSError, json.JSONDecodeError, TypeError) as exc:
            errors.append({"platform": "glovo-export", "message": f"Erreur de lecture pour {entry.get('name', rel.name)} : {type(exc).__name__}: {exc}"})
    metadata = {"source": "local export", "index": index_path.name, "scraped_at": scraped_at,
                "restaurants_reported": index.get("count"), "restaurants_loaded": len(rows),
                "incomplete": len(rows) != index.get("count") or bool(errors), "errors": errors}
    return rows, metadata


def _products(source, entry, root, scraped_at):
    slug = source.get("slug") or entry.get("slug") or ""
    products, by_key = [], {}
    for category in source.get("categories", []):
        category_name = category.get("name")
        for item in category.get("products", []):
            name = item.get("name")
            if not name:
                continue
            price = _number(item.get("price"))
            regular = _number(item.get("oldPrice"))
            relative_image = item.get("image")
            key = (normalize(name), price, normalize(item.get("description")))
            product = {"id": item.get("id"), "name": name, "description": item.get("description"),
                       "category": category_name, "price": price,
                       "sale_price": price if regular is not None and price is not None and price < regular else None,
                       "regular_price": regular, "currency": "MAD" if price is not None else None,
                       "available": item.get("available"), "image": _asset_url(slug, relative_image),
                       "size": _size_from_name(name), "options": item.get("optionGroups") or [],
                       "url": source.get("glovoUrl") or entry.get("url"),
                       "collected_at": item.get("scrapedAt") or scraped_at,
                       "promotion_percent": item.get("discount")}
            if key in by_key:
                prior = products[by_key[key]]
                if normalize(prior.get("category")) in ("promotions", "top sellers") and category_name:
                    prior["category"] = category_name
                if product["regular_price"] is not None:
                    prior["regular_price"] = product["regular_price"]
                    prior["sale_price"] = product["sale_price"]
                prior["options"] = prior.get("options") or product["options"]
                continue
            by_key[key] = len(products)
            products.append(product)
    return products


def _asset_url(slug, relative):
    if not relative:
        return None
    safe_slug = quote(str(slug), safe="-_.")
    safe_path = "/".join(quote(part, safe="-_.") for part in str(relative).replace("\\", "/").split("/"))
    return f"/api/glovo-export-assets/{safe_slug}/{safe_path}"


def asset_path(slug, asset):
    if not slug or Path(slug).name != slug or slug in (".", ".."):
        return None
    root = export_root()
    folder = (root / "restaurants" / slug).resolve()
    target = (folder / asset).resolve()
    if not folder.is_relative_to(root) or not target.is_relative_to(folder) or not target.is_file():
        return None
    return target


def _number(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _size_from_name(name):
    match = re.search(r"\b(?:XS|S|M|L|XL|XXL|small|medium|large|mini|maxi|\d+\s?(?:cl|ml|l|g|kg))\b", name or "", re.I)
    return match.group(0) if match else None
