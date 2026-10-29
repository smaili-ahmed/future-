import asyncio
import csv
import io
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .collector import collect_platforms
from .db import initialize, latest_data, save_catalog, save_match_override, save_price_history, save_run, seed_observations, update_user_missing
from .matching import match_products, normalize, restaurant_matches
from .mooup_api import MooupCatalogError, fetch_mooup_catalog
from .seed_data import MANUALLY_VALIDATED_MISSING
from rapidfuzz.fuzz import ratio

BASE = Path(__file__).resolve().parent
app = FastAPI(title="Comparateur Mooup / Glovo", version="1.0.0")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
_lock = asyncio.Lock()
_active_run = {"status": "idle", "stage": "idle", "restaurants_processed": 0, "products_processed": 0, "errors": []}

# Seuils de décision : une identité n'est affirmée qu'au-dessus de PRESENCE_THRESHOLD,
# une absence n'est affirmée que si aucun candidat Mooup n'atteint ABSENCE_THRESHOLD.
PRESENCE_THRESHOLD = 0.96
ABSENCE_THRESHOLD = 0.60
RELIABLE_MATCH_CONFIDENCE = 0.70
WORKING_DAY_LABELS = {"monday": "Lun", "tuesday": "Mar", "wednesday": "Mer", "thursday": "Jeu",
                      "friday": "Ven", "saturday": "Sam", "sunday": "Dim"}


def implausible_price(value):
    """Un prix hors plage plausible est signalé comme valeur source atypique, jamais corrigé."""
    if value is None:
        return False
    try:
        return not 1.0 <= float(value) <= 1000.0
    except (TypeError, ValueError):
        return True


@app.on_event("startup")
def startup():
    initialize()


@app.get("/")
def home():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/api/glovo-export-assets/{slug}/{asset:path}")
def glovo_export_asset(slug: str, asset: str):
    from .glovo_export import asset_path
    path = asset_path(slug, asset)
    if not path:
        raise HTTPException(404, "Image absente de l’export Glovo local")
    return FileResponse(path)


@app.get("/api/report")
def report():
    data = latest_data()
    data["current_run"] = _active_run.copy()
    run_meta = (data.get("restaurants") or {}).get("_meta", {})
    data["mooup_catalog_available"] = bool(data.get("mooup_imported_at") or run_meta.get("mooup"))
    data["mooup_source"] = "catalog import" if data.get("mooup_imported_at") else "Mooup catalog:read API" if run_meta.get("mooup") else None
    data["mooup_last_sync"] = data.get("mooup_imported_at") or (run_meta.get("mooup") or {}).get("synced_at")
    data["mooup_catalog_stale"] = bool((run_meta.get("mooup") or {}).get("stale_snapshot"))
    data["mooup_api_configured"] = bool(os.getenv("MOOUP_CATALOG_API_KEY", "").strip())
    if data["mooup_catalog_available"]:
        raw_matches = restaurant_matches(data["restaurants"].get("glovo", []), data["restaurants"].get("mooup", []))
        data["matches"] = [{"glovo_name": item["name"], "mooup_name": (item.get("match") or {}).get("name"),
                            "confidence": item["confidence"], "status": item["status"], "reasons": item["reasons"]}
                           for item in raw_matches]
        for override in data.get("match_overrides", []):
            selected = next((item for item in data["matches"] if item["glovo_name"] == override["glovo_name"]), None)
            if selected:
                selected.update({"mooup_name": override.get("mooup_name"), "status": override["status"],
                                 "confidence": 1.0 if override["status"] == "confirmed" else 0.0,
                                 "reasons": ["Correspondance validée manuellement"]})
    data["missing_from_glovo"] = [item for item in data["restaurants"].get("mooup", [])
                                  if not any(m.get("mooup_name") == item.get("name") and m.get("status") in ("confirmed", "review")
                                             for m in data["matches"])]
    data["product_comparisons"] = build_product_comparisons(data)
    data["missing_products_mooup"] = [row for row in data["product_comparisons"] if row["status"] == "missing_mooup"]
    data["missing_products_glovo"] = [row for row in data["product_comparisons"] if row["status"] == "missing_glovo"]
    data["quality"] = quality_report(data)
    data["price_comparisons"] = build_price_comparisons(data)
    attach_restaurant_research(data)
    data["tracked_restaurants"] = build_tracked_restaurants(data)
    data["common_restaurants"], data["common_restaurants_excluded"] = build_common_restaurants(data)
    return data


def best_listing_match(name, listings):
    target = normalize(name)
    ranked = []
    for listing in listings:
        candidate = normalize(listing.get("name"))
        # Watchlist lookup is conservative: token-subset similarity would incorrectly
        # collapse names such as "Opheon" and "Le petit-déjeuner Opheon".
        score = ratio(target, candidate) / 100 if target and candidate else 0
        ranked.append((score, listing))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    best = ranked[0] if ranked else (0, None)
    near = [item for score, item in ranked if score >= max(0.82, best[0] - 0.04)]
    return {"listing": best[1] if best[0] >= 0.68 else None, "score": round(best[0], 3),
            "ambiguous": len(near) > 1, "alternatives": [item.get("name") for item in near[:5]],
            "candidate": (best[1] or {}).get("name"), "candidate_score": round(best[0], 3)}


def attach_restaurant_research(data):
    watchlist, manual, manual_history = seed_observations()
    glovo = data.get("restaurants", {}).get("glovo", [])
    mooup = data.get("restaurants", {}).get("mooup", [])
    glovo_available = bool(data.get("run") and glovo and data.get("run", {}).get("status") != "failed")
    mooup_available = bool(data.get("mooup_catalog_available"))
    last_checked = (data.get("run") or {}).get("finished_at")
    normalized_counts = {}
    for entry in watchlist:
        normalized_counts[entry["normalized_name"]] = normalized_counts.get(entry["normalized_name"], 0) + 1
    analyses = []
    for entry in watchlist:
        g, m = best_listing_match(entry["input_name"], glovo), best_listing_match(entry["input_name"], mooup)
        g_status = "inaccessible" if not glovo_available else "found" if g["score"] >= 0.96 and not g["ambiguous"] else "uncertain" if g["score"] >= 0.68 else "not_found"
        m_status = "found" if m["score"] >= 0.96 and not m["ambiguous"] else "uncertain" if m["score"] >= 0.68 else "not_found"
        common_match = next((row for row in data.get("matches", []) if row.get("glovo_name") == (g["listing"] or {}).get("name")), None)
        if g_status == "uncertain" or (mooup_available and m_status == "uncertain") or g["ambiguous"] or m["ambiguous"]:
            status = "uncertain"
        elif not mooup_available:
            status = "glovo_only_unverified" if g_status == "found" else "not_found_unverified" if g_status == "not_found" else "inaccessible"
        elif not glovo_available:
            status = "inaccessible"
        elif g_status == "found" and m_status == "found" and common_match and common_match.get("status") == "confirmed":
            status = "both"
        elif g_status == "found" and m_status == "found":
            status = "uncertain"
        elif g_status == "found":
            status = "glovo_only"
        elif m_status == "found":
            status = "mooup_only"
        else:
            status = "not_found"
        analyses.append({"position": entry["position"], "name": entry["input_name"],
                         "normalized_name": entry["normalized_name"], "duplicate_count": normalized_counts[entry["normalized_name"]],
                         "duplicate_warning": normalized_counts[entry["normalized_name"]] > 1,
                         "status": status, "glovo_status": g_status,
                         "mooup_status": m_status if mooup_available else "inaccessible",
                         "glovo": g["listing"], "mooup": m["listing"], "glovo_confidence": g["score"],
                         "mooup_confidence": m["score"], "manual_match_status": common_match.get("status") if common_match else None,
                         "last_checked": last_checked})
    data["restaurant_watchlist"] = analyses
    data["watchlist_count"] = len(analyses)
    data["watchlist_exact_duplicates"] = sum(count - 1 for count in normalized_counts.values() if count > 1)

    for row in manual:
        g = best_listing_match(row["name"], glovo)
        m = best_listing_match(row["name"], mooup)
        manual_match = next((item for item in data.get("matches", []) if item.get("glovo_name") == (g["listing"] or {}).get("name") and item.get("mooup_name") == (m["listing"] or {}).get("name")), None)
        if not mooup_available:
            status = "À ajouter sur Mooup — validé manuellement"
        elif m["score"] >= 0.96 and manual_match and manual_match.get("status") == "confirmed":
            status = "Présent sur Mooup — correspondance confirmée"
        elif m["score"] >= 0.88:
            status = "Présence détectée sur Mooup — à vérifier"
        else:
            status = "Non retrouvé dans l’export Mooup — à ajouter"
        checked = last_checked or row.get("last_checked_at") or row["verified_at"]
        update_user_missing(row["name"], status, checked, (m["listing"] or {}).get("name"),
                            (g["listing"] or {}).get("url"), (g["listing"] or {}).get("image"),
                            (g["listing"] or {}).get("category") or "Food")
    _, current_manual, manual_history = seed_observations()
    data["manual_missing_restaurants"] = [
        {**row, "glovo": best_listing_match(row["name"], glovo)["listing"],
         "products_count": len(best_listing_match(row["name"], glovo)["listing"].get("products", [])) if best_listing_match(row["name"], glovo)["listing"] else None}
        for row in current_manual]
    data["manual_missing_initial_count"] = len(current_manual)
    data["manual_missing_history"] = manual_history
    data["automatic_missing_restaurants"] = [
        {**row, "products_count": len(row.get("products", []))}
        for row in data.get("matches", []) if row.get("status") == "missing"] if mooup_available else []


def listing_status(match, available):
    if not available:
        return "inaccessible"
    if match["listing"] is None:
        return "not_found"
    if match["score"] >= PRESENCE_THRESHOLD and not match["ambiguous"]:
        return "found"
    return "uncertain"


def classify_tracked(g, m, glovo_available, mooup_available, mooup_count=0):
    """Statut d'un établissement suivi, déduit uniquement des données réellement collectées.

    Retourne (statut, motif). Aucune absence n'est déclarée sans vérification du catalogue Mooup chargé.
    """
    if not glovo_available:
        return "insufficient", "Collecte Glovo indisponible : présence et absence non vérifiables."
    g_confirmed = g["listing"] is not None and g["score"] >= PRESENCE_THRESHOLD and not g["ambiguous"]
    m_confirmed = bool(mooup_available and m["listing"] is not None and m["score"] >= PRESENCE_THRESHOLD
                       and not m["ambiguous"])
    if g_confirmed and m_confirmed:
        return "both", f"Identifié sur Glovo et sur Mooup (« {m['listing']['name']} »)."
    if not g_confirmed:
        if m_confirmed:
            return "mooup_only", f"Identifié sur Mooup (« {m['listing']['name']} »), absent des données Glovo collectées."
        if g["listing"] is None:
            if not mooup_available and m["listing"] is None:
                return "insufficient", "Aucune fiche collectée sur les deux plateformes."
            return "to_verify", (f"Non retrouvé dans les données Glovo collectées "
                                 f"(meilleur candidat « {g['candidate']} » à {g['score']:.0%}).")
        return "to_verify", f"Fiche Glovo incertaine (« {g['listing']['name']} » à {g['score']:.0%}) : présence à confirmer."
    if not mooup_available:
        return "to_verify", "Catalogue Mooup indisponible : l’absence sur Mooup ne peut pas être vérifiée."
    if m["listing"] is not None:
        return "to_verify", f"Candidat Mooup proche « {m['listing']['name']} » ({m['score']:.0%}) : présence à confirmer."
    if m["score"] >= ABSENCE_THRESHOLD:
        return "to_verify", (f"Meilleur candidat Mooup « {m['candidate']} » ({m['score']:.0%}) : "
                             f"écart trop faible pour conclure.")
    return "glovo_only", (f"Aucun candidat Mooup au-dessus de {ABSENCE_THRESHOLD:.0%} sur les "
                          f"{mooup_count} restaurants du catalogue Mooup chargé.")


def format_working_days(days):
    parts = []
    for day in days or []:
        if not isinstance(day, dict) or day.get("disabled"):
            continue
        start, end = day.get("from"), day.get("to")
        if not start or not end:
            continue
        label = WORKING_DAY_LABELS.get(day.get("day"), day.get("day") or "")
        parts.append(f"{label} {str(start).replace('-', ':')}–{str(end).replace('-', ':')}")
    return " · ".join(parts) if parts else None


def restaurant_info(listing, platform):
    if not listing:
        return None
    raw = listing.get("raw")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    info = {"platform": platform, "name": listing.get("name"), "url": listing.get("url"),
            "image": listing.get("image"), "category": listing.get("category"),
            "address": listing.get("address"), "description": listing.get("description"),
            "products_count": len(listing.get("products") or []),
            "collected_at": listing.get("collected_at"), "hours": None, "open": None,
            "source": listing.get("source")}
    if platform == "glovo":
        info["rating"] = listing.get("rating") or raw.get("rating")
        info["reviews"] = listing.get("reviews") or raw.get("reviews")
        info["cuisines"] = raw.get("cuisines")
        info["open"] = raw.get("open")
        info["promotion"] = listing.get("promotion") or raw.get("promotion")
    else:
        availability = raw.get("availability") if isinstance(raw.get("availability"), dict) else {}
        info["hours"] = format_working_days(availability.get("working_days"))
        info["open"] = availability.get("open", listing.get("available"))
        info["status"] = listing.get("status")
    return info


def build_tracked_restaurants(data):
    """Les 45 établissements suivis (3 validations manuelles + 42 noms) vérifiés sur les deux catalogues."""
    watchlist, manual_rows, _ = seed_observations()
    glovo = data.get("restaurants", {}).get("glovo", [])
    mooup = data.get("restaurants", {}).get("mooup", [])
    glovo_available = bool(data.get("run") and glovo and data.get("run", {}).get("status") != "failed")
    mooup_available = bool(data.get("mooup_catalog_available"))
    last_checked = (data.get("run") or {}).get("finished_at")
    manual_by_name = {row["name"]: row for row in manual_rows}
    entries = [(name, True) for name in MANUALLY_VALIDATED_MISSING] + [(row["input_name"], False) for row in watchlist]
    counts = {}
    for name, _ in entries:
        counts[normalize(name)] = counts.get(normalize(name), 0) + 1
    rows = []
    for position, (name, manual) in enumerate(entries, start=1):
        g = best_listing_match(name, glovo)
        m = best_listing_match(name, mooup)
        status, reason = classify_tracked(g, m, glovo_available, mooup_available, len(mooup))
        manual_row = manual_by_name.get(name) if manual else None
        listing = g["listing"]
        checked = last_checked or (manual_row or {}).get("last_checked_at") or (manual_row or {}).get("verified_at")
        rows.append({"position": position, "name": name, "normalized_name": normalize(name),
                     "manual": manual, "duplicate_count": counts[normalize(name)],
                     "duplicate_warning": counts[normalize(name)] > 1,
                     "status": status, "reason": reason, "manual_status": (manual_row or {}).get("status"),
                     "glovo_status": listing_status(g, glovo_available),
                     "mooup_status": listing_status(m, mooup_available),
                     "glovo": listing, "mooup": m["listing"],
                     "mooup_candidate": m["candidate"], "mooup_candidate_score": m["candidate_score"],
                     "glovo_candidate": g["candidate"], "glovo_candidate_score": g["candidate_score"],
                     "glovo_confidence": g["score"], "mooup_confidence": m["score"],
                     "glovo_ambiguous": g["ambiguous"], "mooup_ambiguous": m["ambiguous"],
                     "category": (listing or {}).get("category") or (manual_row or {}).get("category"),
                     "products_count": len(listing.get("products") or []) if listing else None,
                     "image": (listing or {}).get("image") or (manual_row or {}).get("image"),
                     "glovo_url": (listing or {}).get("url") or (manual_row or {}).get("glovo_url"),
                     "last_verified_at": checked,
                     "glovo_info": restaurant_info(listing, "glovo"),
                     "mooup_info": restaurant_info(m["listing"], "mooup")})
    return rows


def is_reliable_match(match):
    """Une présence Mooup n'est retenue que si l'identité est confirmée ou la correspondance fiable."""
    if not match.get("mooup_name"):
        return False
    if match.get("status") == "confirmed":
        return True
    return match.get("status") == "review" and float(match.get("confidence") or 0) >= RELIABLE_MATCH_CONFIDENCE


def build_common_restaurants(data):
    """Restaurants présents sur les deux plateformes avec une correspondance suffisamment fiable."""
    glovo = {row.get("name"): row for row in data.get("restaurants", {}).get("glovo", [])}
    mooup = {row.get("name"): row for row in data.get("restaurants", {}).get("mooup", [])}
    comparisons = data.get("product_comparisons") or []
    tracked_names = {row["name"] for row in data.get("tracked_restaurants") or []}
    rows, excluded = [], 0
    for match in data.get("matches") or []:
        if not match.get("mooup_name"):
            continue
        if not is_reliable_match(match):
            excluded += 1
            continue
        left, right = glovo.get(match["glovo_name"]), mooup.get(match["mooup_name"])
        if not left or not right:
            continue
        restaurant_rows = [row for row in comparisons if row.get("restaurant") == match["glovo_name"]]
        paired = sum(1 for row in restaurant_rows if row.get("glovo_product") and row.get("mooup_product"))
        comparable = sum(1 for row in restaurant_rows if row.get("delta") is not None)
        anomalies = sum(1 for row in restaurant_rows if row.get("price_anomaly"))
        gaps = sum(1 for row in restaurant_rows if row.get("delta") not in (None, 0) and not row.get("price_anomaly"))
        rows.append({"name": match["glovo_name"], "mooup_name": match["mooup_name"],
                     "category": left.get("category") or right.get("category"),
                     "image": left.get("image") or right.get("image"),
                     "url": left.get("url"), "mooup_url": right.get("url"),
                     "glovo_products": len(left.get("products") or []),
                     "mooup_products": len(right.get("products") or []),
                     "paired_products": paired, "comparable_products": comparable,
                     "price_gaps": gaps, "price_anomalies": anomalies, "confidence": match.get("confidence"),
                     "match_status": match.get("status"), "reasons": match.get("reasons") or [],
                     "tracked": match["glovo_name"] in tracked_names,
                     "glovo_info": restaurant_info(left, "glovo"), "mooup_info": restaurant_info(right, "mooup")})
    rows.sort(key=lambda row: (-row["price_gaps"], -row["comparable_products"], row["name"].casefold()))
    return rows, excluded


def build_product_comparisons(data):
    glovo = data.get("restaurants", {}).get("glovo", [])
    mooup = data.get("restaurants", {}).get("mooup", [])
    rows = []
    for restaurant in data.get("matches", []):
        if restaurant.get("status") not in ("confirmed", "review") or not restaurant.get("mooup_name"):
            continue
        left = next((item for item in glovo if item.get("name") == restaurant["glovo_name"]), None)
        right = next((item for item in mooup if item.get("name") == restaurant["mooup_name"]), None)
        if not left or not right:
            continue
        pairs = match_products(left.get("products", []), right.get("products", []))
        for pair in pairs:
            left_product, right_product = pair["glovo"], pair.get("mooup")
            if pair["status"] == "missing":
                status = "missing_mooup" if restaurant.get("status") == "confirmed" else "review"
                rows.append(product_row(restaurant, left_product, None, status, pair, missing_side="mooup"))
                continue
            if right_product:
                rows.append(product_row(restaurant, left_product, right_product,
                                        "matched" if pair["status"] == "matched" and restaurant.get("status") == "confirmed" else "review", pair))
            elif pair["status"] == "review":
                rows.append(product_row(restaurant, left_product, None, "review", pair, missing_side="mooup"))
        reverse = match_products(right.get("products", []), left.get("products", []))
        for pair in reverse:
            if pair["status"] == "missing":
                status = "missing_glovo" if restaurant.get("status") == "confirmed" else "review"
                rows.append(product_row(restaurant, pair["glovo"], None, status, pair, reverse=True, missing_side="glovo"))
            elif pair["status"] == "review" and not pair.get("mooup"):
                rows.append(product_row(restaurant, pair["glovo"], None, "review", pair, reverse=True, missing_side="glovo"))
    return rows


def product_row(restaurant, glovo_product, mooup_product, status, pair, reverse=False, missing_side=None):
    if reverse:
        mooup_product, glovo_product = glovo_product, pair.get("mooup")
    price = pair.get("price") if status in ("matched", "review") else None
    return {"restaurant": restaurant.get("glovo_name"), "product": (glovo_product or mooup_product or {}).get("name"),
            "glovo_product": glovo_product, "mooup_product": mooup_product,
            "glovo_price": (glovo_product or {}).get("price"), "mooup_price": (mooup_product or {}).get("price"),
            "delta": price.get("delta") if price else None, "percent": price.get("percent") if price else None,
            "cheaper": price.get("cheaper") if price else None, "confidence": pair.get("confidence", 0),
            "reasons": pair.get("reasons", []), "status": status,
            "missing_side": missing_side, "restaurant_status": restaurant.get("status"),
            "price_anomaly": implausible_price((glovo_product or {}).get("price"))
                             or implausible_price((mooup_product or {}).get("price")),
            "currency": (glovo_product or {}).get("currency") or (mooup_product or {}).get("currency"),
            "glovo_url": (glovo_product or {}).get("url"), "mooup_url": (mooup_product or {}).get("url"),
            "last_checked": max((glovo_product or {}).get("collected_at", ""), (mooup_product or {}).get("collected_at", "")) or None}


UNCERTAIN_REASON = re.compile(r"plusieurs produits candidats|déjà rapproché", re.I)
PRODUCT_PAIR_CONFIDENCE = 0.70
CONTENT_SIMILARITY_CEILING = 0.50
MIN_DESCRIPTION_LENGTH = 15


def _substantive_description(item):
    """Description exploitable : suffisamment longue et qui n'est pas un simple écho du nom."""
    text = normalize((item or {}).get("description"))
    if len(text) < MIN_DESCRIPTION_LENGTH or text == normalize((item or {}).get("name")):
        return ""
    return text


def product_content_differs(glovo_product, mooup_product):
    """Composition différente : seules les descriptions réelles des DEUX côtés sont comparées."""
    left = _substantive_description(glovo_product)
    right = _substantive_description(mooup_product)
    if not left or not right:
        return False
    return ratio(left, right) / 100 < CONTENT_SIMILARITY_CEILING


def catalog_row(glovo_product, mooup_product, pair, order_g=None, order_m=None, reverse=False):
    """Une ligne d'alignement : chaque produit des deux catalogues apparaît exactement une fois."""
    both = bool(glovo_product and mooup_product)
    # Le reverse de match_products calcule le prix dans l'autre sens : jamais utilisé tel quel.
    price = pair.get("price") if (pair and not reverse) else None
    delta = price.get("delta") if price else None
    percent = price.get("percent") if price else None
    cheaper = price.get("cheaper") if price else None
    size_mismatch = bool(pair and pair.get("size_mismatch"))
    content_diff = product_content_differs(glovo_product, mooup_product)
    reasons = list((pair or {}).get("reasons") or [])
    if reverse:
        candidate = (pair or {}).get("mooup")
        if candidate:
            reasons.append(f"Correspondance Glovo « {candidate.get('name')} » déjà rapprochée d’un autre produit")
        else:
            reasons.append("Aucun produit Glovo équivalent dans le catalogue collecté")
    confidence = float((pair or {}).get("confidence") or 0)
    ambiguous = any(UNCERTAIN_REASON.search(reason) for reason in reasons)
    uncertain = both and (size_mismatch or ambiguous or content_diff
                          or confidence < PRODUCT_PAIR_CONFIDENCE)
    owner = glovo_product or mooup_product or {}
    return {"kind": "paired" if both else "glovo_only" if glovo_product else "mooup_only",
            "category": (owner.get("category") or "").strip() or "Non classé",
            "glovo_product": glovo_product, "mooup_product": mooup_product,
            "delta": delta, "percent": percent, "cheaper": cheaper,
            "price_anomaly": implausible_price((glovo_product or {}).get("price"))
                             or implausible_price((mooup_product or {}).get("price")),
            "size_mismatch": size_mismatch, "content_different": content_diff,
            "uncertain": uncertain, "confidence": confidence, "reasons": reasons,
            "currency": (glovo_product or {}).get("currency") or (mooup_product or {}).get("currency"),
            "order_g": order_g, "order_m": order_m}


def resolve_catalog_pair(data, glovo_name, mooup_name=None):
    """Fiche Glovo, fiche Mooup associée (validations manuelles incluses) et métadonnées de correspondance."""
    listings = data.get("restaurants") or {}
    left = next((item for item in listings.get("glovo", []) if item.get("name") == glovo_name), None)
    if left is None:
        raise HTTPException(404, "Restaurant Glovo introuvable dans la dernière collecte.")
    mooup_listings = listings.get("mooup", [])
    match = {"glovo_name": glovo_name, "mooup_name": None, "confidence": 0.0,
             "status": "missing", "reasons": ["Aucune correspondance Mooup résolue."]}
    if mooup_listings:
        computed = next((item for item in restaurant_matches(listings.get("glovo", []), mooup_listings)
                         if item.get("name") == glovo_name), None)
        if computed:
            match = {"glovo_name": glovo_name, "mooup_name": (computed.get("match") or {}).get("name"),
                     "confidence": computed.get("confidence", 0.0), "status": computed.get("status"),
                     "reasons": computed.get("reasons") or []}
        for override in data.get("match_overrides", []):
            if override.get("glovo_name") == glovo_name:
                match = {"glovo_name": glovo_name, "mooup_name": override.get("mooup_name"),
                         "confidence": 1.0 if override.get("status") == "confirmed" else 0.0,
                         "status": override.get("status"),
                         "reasons": ["Correspondance validée manuellement"]}
    target = mooup_name or match.get("mooup_name")
    right = None
    if target:
        right = next((item for item in mooup_listings if item.get("name") == target), None)
        if right is None:
            raise HTTPException(404, "Restaurant Mooup introuvable dans le catalogue chargé.")
        if match.get("mooup_name") != target:
            match = {**match, "mooup_name": target,
                     "reasons": (match.get("reasons") or []) + ["Fiche Mooup choisie explicitement pour la comparaison"]}
    return left, right, match


def build_catalog_comparison(data, glovo_name, mooup_name=None):
    """Catalogues Glovo et Mooup d'un restaurant alignés produit par produit, avec écarts et confiance."""
    left, right, match = resolve_catalog_pair(data, glovo_name, mooup_name)
    source_meta = (data.get("restaurants") or {}).get("_meta", {})
    glovo_available = bool(data.get("run") and (data.get("restaurants") or {}).get("glovo")
                           and data["run"].get("status") != "failed")
    mooup_available = bool(data.get("mooup_imported_at") or source_meta.get("mooup"))
    glovo_products = list(left.get("products") or [])
    mooup_products = list(right.get("products") or []) if right else []
    rows = []
    if mooup_products:
        forward = match_products(glovo_products, mooup_products)
        mooup_positions = {id(product): index for index, product in enumerate(mooup_products)}
        claimed = set()
        for index, pair in enumerate(forward):
            partner = pair.get("mooup")
            if partner is not None:
                claimed.add(mooup_positions[id(partner)])
            rows.append(catalog_row(pair.get("glovo"), partner, pair, order_g=index))
        for index, pair in enumerate(match_products(mooup_products, glovo_products)):
            if index in claimed:
                continue
            rows.append(catalog_row(None, mooup_products[index], pair, order_m=index, reverse=True))
    else:
        reason = ("Catalogue Mooup non collecté : absence non vérifiable."
                  if not mooup_available else (match.get("reasons") or ["Restaurant Mooup non rapproché."])[0])
        for index, product in enumerate(glovo_products):
            rows.append(catalog_row(product, None,
                                    {"reasons": [reason], "confidence": 0.0, "status": "missing",
                                     "size_mismatch": False}, order_g=index))
    for index, row in enumerate(rows):
        row["key"] = index
    paired = [row for row in rows if row["kind"] == "paired"]
    summary = {"glovo_products": len(glovo_products), "mooup_products": len(mooup_products),
               "paired": len(paired),
               "missing_mooup": sum(row["kind"] == "glovo_only" for row in rows),
               "missing_glovo": sum(row["kind"] == "mooup_only" for row in rows),
               "price_gaps": sum(row["delta"] not in (None, 0) and not row["price_anomaly"] for row in paired),
               "price_identical": sum(row["delta"] == 0 for row in paired),
               "comparable": sum(row["delta"] is not None for row in paired),
               "uncertain": sum(row["uncertain"] for row in paired),
               "anomalies": sum(row["price_anomaly"] for row in rows)}

    def categories_of(products):
        result = []
        for product in products:
            name = (product.get("category") or "").strip() or "Non classé"
            if name not in result:
                result.append(name)
        return result

    return {"match": match,
            "glovo": restaurant_info(left, "glovo"),
            "mooup": restaurant_info(right, "mooup") if right else None,
            "rows": rows,
            "glovo_categories": categories_of(glovo_products),
            "mooup_categories": categories_of(mooup_products),
            "summary": summary,
            "meta": {"glovo_available": glovo_available, "mooup_catalog_available": mooup_available,
                     "mooup_source": ("catalog import" if data.get("mooup_imported_at")
                                      else "Mooup catalog:read API" if source_meta.get("mooup") else None),
                     "mooup_last_sync": data.get("mooup_imported_at") or (source_meta.get("mooup") or {}).get("synced_at"),
                     "glovo_scraped_at": (source_meta.get("glovo") or {}).get("scraped_at"),
                     "generated_at": datetime.now(timezone.utc).isoformat()}}


def quality_report(data):
    glovo = data.get("restaurants", {}).get("glovo", [])
    mooup = data.get("restaurants", {}).get("mooup", [])
    products = [p for listing in glovo + mooup for p in listing.get("products", [])]
    known_prices = sum(p.get("price") is not None for p in products)
    source_meta = (data.get("restaurants") or {}).get("_meta", {})
    glovo_meta = source_meta.get("glovo") or {}
    expected = glovo_meta.get("restaurants_reported")
    coverage = round(len(glovo) / expected * 100, 1) if isinstance(expected, int) and expected > 0 else None
    coverage_note = (f"{len(glovo)}/{expected} fiches lues depuis l’export local; ce taux porte sur l’export, pas sur toute l’offre Glovo."
                     if coverage is not None else "Le total global des plateformes n’est pas publié; la couverture en pourcentage n’est pas calculable.")
    return {"restaurants_glovo": len(glovo), "restaurants_mooup": len(mooup),
            "products_glovo": sum(len(r.get("products", [])) for r in glovo),
            "products_mooup": sum(len(r.get("products", [])) for r in mooup),
            "menus_collected": sum(r.get("menu_collect_status") == "collected" for r in glovo + mooup),
            "products_total": len(products), "prices_missing": len(products) - known_prices,
            "descriptions_missing": sum(not p.get("description") for p in products),
            "availability_unknown": sum(p.get("available") is None for p in products),
            "prices_found": known_prices,
            "pages_inaccessible": sum("Fiche inaccessible" in error.get("message", "") or "Collecte inaccessible" in error.get("message", "") for error in data.get("errors", [])),
            "limitations": len(data.get("errors", [])),
            "pages_visited": 0 if glovo_meta.get("source") else len(glovo) + 2,
            "glovo_export_reported": expected, "coverage_percent": coverage,
            "coverage_note": coverage_note, "catalog_sources": source_meta,
            "last_sync": (data.get("run") or {}).get("finished_at"), "mooup_imported_at": data.get("mooup_imported_at")}


def build_price_comparisons(data):
    rows = []
    for row in data.get("product_comparisons") or []:
        if row.get("missing_side") or row.get("delta") is None:
            continue
        if row.get("status") not in ("matched", "review"):
            continue
        glovo_product = row.get("glovo_product") or {}
        rows.append({"restaurant": row["restaurant"], "product": row["product"],
                     "category": glovo_product.get("category"),
                     "mooup_price": row["mooup_price"], "glovo_price": row["glovo_price"],
                     "delta": row["delta"], "percent": row["percent"], "cheaper": row["cheaper"],
                     "price_anomaly": bool(row.get("price_anomaly")),
                     "verification": "Confirmé" if row["status"] == "matched" else "À vérifier",
                     "confidence": row["confidence"], "mooup_url": row["mooup_url"],
                     "glovo_url": row["glovo_url"], "currency": glovo_product.get("currency") or "MAD",
                     "last_checked": row["last_checked"]})
    return rows


@app.get("/api/price-comparisons")
def price_comparisons():
    return report()["price_comparisons"]


@app.get("/api/catalog-comparison")
def catalog_comparison(restaurant: str, mooup: str | None = None):
    """Catalogues Glovo et Mooup d'un restaurant, alignés produit par produit pour la vue côte à côte."""
    if not (restaurant or "").strip():
        raise HTTPException(400, "Nom de restaurant manquant.")
    return build_catalog_comparison(latest_data(), restaurant.strip(), (mooup or "").strip() or None)


@app.post("/api/matches/validate")
async def validate_match(request: Request):
    payload = await request.json()
    glovo_name, mooup_name, decision = payload.get("glovo_name"), payload.get("mooup_name"), payload.get("decision")
    data = latest_data()
    glovo_names = {item.get("name") for item in data["restaurants"].get("glovo", [])}
    mooup_names = {item.get("name") for item in data["restaurants"].get("mooup", [])}
    if not glovo_name or glovo_name not in glovo_names:
        raise HTTPException(404, "Restaurant Glovo inconnu dans la dernière collecte")
    if decision == "confirm" and (not mooup_name or mooup_name not in mooup_names):
        raise HTTPException(400, "Choisissez un restaurant Mooup importé")
    if decision == "confirm" and any(item.get("mooup_name") == mooup_name and item.get("glovo_name") != glovo_name
                                      and item.get("status") == "confirmed" for item in data.get("match_overrides", [])):
        raise HTTPException(409, "Ce restaurant Mooup est déjà associé manuellement à un autre établissement Glovo")
    if decision not in ("confirm", "missing"):
        raise HTTPException(400, "Décision attendue : confirm ou missing")
    save_match_override(glovo_name, mooup_name if decision == "confirm" else None,
                        "confirmed" if decision == "confirm" else "missing", datetime.now(timezone.utc).isoformat())
    latest = report()
    save_price_history((latest.get("run") or {}).get("id"), latest["price_comparisons"], datetime.now(timezone.utc).isoformat())
    return {"status": "saved", "glovo_name": glovo_name, "mooup_name": mooup_name, "decision": decision}


@app.post("/api/runs", status_code=202)
async def start_run():
    global _active_run
    if _lock.locked() or _active_run.get("status") == "running":
        raise HTTPException(409, "Une analyse est déjà en cours")
    _active_run = {"status": "running", "stage": "Démarrage de la collecte", "started_at": datetime.now(timezone.utc).isoformat(),
                   "restaurants_processed": 0, "products_processed": 0, "errors": []}
    asyncio.create_task(execute_run())
    return _active_run.copy()


@app.get("/api/mooup/status")
def mooup_api_status():
    data = latest_data()
    available = bool(data.get("mooup_imported_at") or (data.get("restaurants") or {}).get("_meta", {}).get("mooup"))
    return {"configured": bool(os.getenv("MOOUP_CATALOG_API_KEY", "").strip()),
            "base_url": os.getenv("MOOUP_API_BASE", "https://api.mooup.ma"),
            "last_catalog_available": available,
            "key": "not returned"}


@app.get("/api/glovo-export/status")
def glovo_export_status():
    from .glovo_export import load_glovo_export
    result = load_glovo_export()
    if not result:
        return {"available": False, "restaurants": 0, "products": 0}
    listings, metadata = result
    return {"available": True, "source": "local export", "restaurants": len(listings),
            "products": sum(len(shop.get("products", [])) for shop in listings),
            "restaurants_reported": metadata.get("restaurants_reported"), "scraped_at": metadata.get("scraped_at"),
            "errors": metadata.get("errors", [])}


@app.post("/api/sync/mooup")
async def sync_mooup_api():
    if _lock.locked() or _active_run.get("status") == "running":
        raise HTTPException(409, "Une collecte est déjà en cours")
    if not os.getenv("MOOUP_CATALOG_API_KEY", "").strip():
        raise HTTPException(400, "Configure MOOUP_CATALOG_API_KEY dans le fichier .env local avant de synchroniser.")
    async with _lock:
        try:
            mooup, metadata = await fetch_mooup_catalog()
        except MooupCatalogError as exc:
            raise HTTPException(401, str(exc)) from exc
        prior = report()
        glovo = (prior.get("restaurants") or {}).get("glovo", [])
        errors = [error for error in prior.get("errors", []) if error.get("platform") != "mooup"]
        now = datetime.now(timezone.utc).isoformat()
        collected = {"glovo": glovo, "mooup": mooup,
                     "_meta": {**((prior.get("restaurants") or {}).get("_meta") or {}), "mooup": metadata}}
        matches = restaurant_matches(glovo, mooup)
        run_id = save_run(now, now, "partial" if errors else "completed", collected, matches, errors)
        result = report()
        save_price_history(run_id, result["price_comparisons"], now)
        return {"id": run_id, "status": "partial" if errors else "completed",
                "restaurants": len(mooup), "products": sum(len(shop.get("products", [])) for shop in mooup),
                "pages": metadata.get("pages"), "matches": sum(match.get("status") in ("confirmed", "review") for match in result["matches"]),
                "price_comparisons": len(result["price_comparisons"]), "synced_at": now}


async def execute_run():
    global _active_run
    async with _lock:
        started = _active_run["started_at"]
        try:
            _active_run["stage"] = "Collecte Glovo : restaurants et menus publics"
            collected, errors = await collect_platforms(on_progress=update_progress)
            _active_run["stage"] = "Rapprochement des restaurants et produits"
            prior = report()
            mooup_imported = bool(prior.get("mooup_catalog_available"))
            if mooup_imported and not collected["mooup"]:
                collected["mooup"] = prior["restaurants"].get("mooup", [])
                collected["_meta"]["mooup"] = {**((prior.get("restaurants") or {}).get("_meta", {}).get("mooup")
                                                   or {"source": prior.get("mooup_source")}), "stale_snapshot": True}
            matches = restaurant_matches(collected["glovo"], collected["mooup"])
            if not mooup_imported and any(error.get("platform") == "mooup" for error in errors):
                for match in matches:
                    match["status"], match["confidence"] = "unverified", 0.0
                    match["reasons"] = ["Catalogue Mooup indisponible : l’absence ne peut pas être vérifiée."]
            finished = datetime.now(timezone.utc).isoformat()
            status = "partial" if errors else "completed"
            run_id = save_run(started, finished, status, collected, matches, errors)
            save_price_history(run_id, report()["price_comparisons"], finished)
            _active_run.update({"id": run_id, "status": status, "stage": "Terminé", "finished_at": finished,
                                "restaurants_processed": len(collected["glovo"]) + len(collected["mooup"]),
                                "products_processed": sum(len(r.get("products", [])) for platform in ("glovo", "mooup") for r in collected[platform]),
                                "errors": errors})
        except Exception as exc:
            _active_run.update({"status": "failed", "stage": "Échec de la collecte", "finished_at": datetime.now(timezone.utc).isoformat(),
                                "errors": [{"platform": "system", "message": f"{type(exc).__name__}: {exc}"}]})


def update_progress(stage, restaurants, products, errors):
    _active_run.update({"stage": stage, "restaurants_processed": restaurants, "products_processed": products, "errors": errors.copy()})
    counts = re.search(r"\((\d+)/(\d+)\)", stage)
    if counts:
        _active_run["total_restaurants"] = int(counts.group(2))


@app.get("/api/runs/current")
def current_run():
    return _active_run.copy()


@app.post("/api/import/mooup")
async def import_mooup(request: Request, format: str = "json"):
    raw = (await request.body()).decode("utf-8-sig")
    if len(raw.encode("utf-8")) > 20 * 1024 * 1024:
        raise HTTPException(413, "Fichier trop volumineux (maximum 20 Mo).")
    try:
        if format.lower() == "csv":
            rows = list(csv.DictReader(io.StringIO(raw)))
            listings_by_name = {}
            for row in rows:
                name = (row.get("restaurant") or row.get("restaurant_name") or "").strip()
                if not name:
                    continue
                listing = listings_by_name.setdefault(name, {"name": name, "platform": "mooup", "url": row.get("restaurant_url"),
                                                             "image": row.get("restaurant_image"), "category": row.get("restaurant_category"),
                                                             "address": row.get("address"), "phone": row.get("phone"),
                                                             "delivery_zone": row.get("delivery_zone"), "products": []})
                product_name = (row.get("product") or row.get("product_name") or row.get("name") or "").strip()
                if product_name:
                    price_text = (row.get("price") or "").strip().replace(" ", "").replace(",", ".")
                    try:
                        price = float(price_text) if price_text else None
                    except ValueError:
                        price = None
                    regular_text = (row.get("regular_price") or "").strip().replace(" ", "").replace(",", ".")
                    try:
                        regular_price = float(regular_text) if regular_text else None
                    except ValueError:
                        regular_price = None
                    availability = row.get("available")
                    if availability is not None:
                        availability = availability.strip().casefold() in ("1", "true", "yes", "available", "disponible")
                    listing["products"].append({"name": product_name, "price": price, "sale_price": price if regular_price and price < regular_price else None,
                                                 "regular_price": regular_price, "currency": row.get("currency") or None,
                                                 "category": row.get("category"), "description": row.get("description"),
                                                 "image": row.get("image"), "available": availability,
                                                 "size": row.get("size"), "options": row.get("options") or None,
                                                 "url": row.get("product_url") or listing.get("url")})
            listings = list(listings_by_name.values())
        else:
            payload = json.loads(raw)
            listings = payload if isinstance(payload, list) else payload.get("restaurants", [])
        if not isinstance(listings, list) or any(not isinstance(item, dict) or not item.get("name") for item in listings):
            raise ValueError("Chaque restaurant doit être un objet avec un champ name.")
        imported_at = datetime.now(timezone.utc).isoformat()
        for item in listings:
            item["platform"] = "mooup"
            item.setdefault("products", [])
            item.setdefault("collected_at", imported_at)
            for product in item["products"]:
                product.setdefault("currency", None)
                product.setdefault("collected_at", imported_at)
        save_catalog("mooup", imported_at, listings)
        current = report()
        save_price_history((current.get("run") or {}).get("id"), current["price_comparisons"], imported_at)
        return {"status": "imported", "restaurants": len(listings),
                "products": sum(len(r.get("products", [])) for r in listings),
                "price_comparisons": len(current["price_comparisons"]), "imported_at": imported_at}
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"Import Mooup invalide : {exc}") from exc


@app.get("/api/health")
def health():
    return {"status": "ok"}
