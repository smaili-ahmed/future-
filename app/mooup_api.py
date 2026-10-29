"""Read-only client for Mooup's partner catalog endpoint."""
import asyncio
import os
from datetime import datetime, timezone
from urllib.parse import urljoin

import httpx


class MooupCatalogError(Exception):
    pass


async def fetch_mooup_catalog():
    key = os.getenv("MOOUP_CATALOG_API_KEY", "").strip()
    if not key:
        raise MooupCatalogError("MOOUP_CATALOG_API_KEY n’est pas configurée dans l’environnement local.")
    base = os.getenv("MOOUP_API_BASE", "https://api.mooup.ma").rstrip("/")
    timeout = float(os.getenv("REQUEST_TIMEOUT", "20"))
    page_size = min(100, max(1, int(os.getenv("MOOUP_API_PAGE_SIZE", "15"))))
    shops, errors, page_number, last_page = [], [], 1, None
    route = "/api/integrations/catalog/all"
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        while page_number <= (last_page or 1):
            url = urljoin(base + "/", route.lstrip("/"))
            response = await client.get(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                                        params={"per_page": page_size, "page": page_number, "status": "approved", "lang": "fr"})
            if response.status_code >= 500 and page_number == 1 and page_size > 15:
                # The partner endpoint documents up to 100/page, but its current deployment
                # returns 500 on an unbounded 100-shop response. Fall back to the documented
                # example chunk size rather than discarding the catalog sync.
                page_size = 15
                response = await client.get(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                                            params={"per_page": page_size, "page": 1, "status": "approved", "lang": "fr"})
            if response.status_code == 404 and route == "/api/integrations/catalog/all" and page_number == 1:
                route = "/api/v1/integrations/catalog/all"
                response = await client.get(urljoin(base + "/", route.lstrip("/")),
                                            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                                            params={"per_page": page_size, "page": 1, "status": "approved", "lang": "fr"})
            if response.status_code == 429:
                retry = response.headers.get("Retry-After", "5")
                try:
                    wait = min(60, max(1, int(retry)))
                except ValueError:
                    wait = 5
                await asyncio.sleep(wait)
                response = await client.get(urljoin(base + "/", route.lstrip("/")),
                                            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                                            params={"per_page": page_size, "page": page_number, "status": "approved", "lang": "fr"})
            if response.status_code in (401, 403):
                # Never include request headers or key material in an error message.
                try:
                    detail = response.json().get("message") or response.json().get("error")
                except ValueError:
                    detail = None
                raise MooupCatalogError(f"API Mooup HTTP {response.status_code}: {detail or 'clé invalide, révoquée ou sans autorisation catalog:read'}")
            if response.status_code >= 400:
                raise MooupCatalogError(f"API Mooup HTTP {response.status_code} (page {page_number})")
            payload = response.json()
            if payload.get("success") is False:
                raise MooupCatalogError(f"API Mooup : {payload.get('error') or 'requête refusée'}")
            shops.extend(_normalize_shop(shop) for shop in payload.get("data", []))
            meta = payload.get("meta") or {}
            last_page = int(meta.get("last_page") or page_number)
            if page_number >= last_page:
                break
            page_number += 1
            await asyncio.sleep(float(os.getenv("MOOUP_API_DELAY_SECONDS", "1")))
    return shops, {"pages": page_number, "shop_count": len(shops), "per_page": page_size,
                   "source": base + route, "status_filter": "approved",
                   "synced_at": datetime.now(timezone.utc).isoformat()}


def _normalize_shop(shop):
    location = shop.get("location") or {}
    category = shop.get("category") or {}
    products = []
    for product in shop.get("products") or []:
        product_category = product.get("category") or {}
        current = product.get("discounted_price")
        if current is None:
            current = product.get("price")
        images = product.get("images") or []
        products.append({"id": product.get("id"), "name": product.get("name"),
                         "description": product.get("description"),
                         "category": product_category.get("name") or product_category.get("slug"),
                         "price": _float(current), "sale_price": _float(product.get("discounted_price")),
                         "regular_price": _float(product.get("original_price")),
                         "currency": product.get("currency"), "available": product.get("available"),
                         "availability_status": product.get("availability_status"),
                         "stock_status": product.get("stock_status"), "image": images[0] if images else None,
                         "images": images, "size": None, "options": product.get("variants") or [],
                         "variants": product.get("variants") or [], "url": product.get("url"),
                         "collected_at": product.get("updated_at") or product.get("created_at"),
                         "external_id": product.get("id"), "discount": product.get("discount")})
    return {"id": shop.get("id"), "external_id": shop.get("id"), "name": shop.get("name"),
            "slug": shop.get("slug"), "url": shop.get("url"), "image": shop.get("logo"),
            "background_image": shop.get("background_img"), "platform": "mooup",
            "category": category.get("name") or category.get("slug"),
            "description": shop.get("description"), "address": location.get("address"),
            "latitude": _float(location.get("latitude")), "longitude": _float(location.get("longitude")),
            "availability": shop.get("availability"), "available": (shop.get("availability") or {}).get("open"),
            "status": shop.get("status"), "products": products, "product_count": len(products),
            "collected_at": shop.get("updated_at"), "source": "MOOUP catalog:read", "raw": shop}


def _float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None
