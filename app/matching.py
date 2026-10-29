import re
import unicodedata
from functools import lru_cache

from rapidfuzz.fuzz import ratio, token_set_ratio


@lru_cache(maxsize=65536)
def normalize(value: str | None) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def restaurant_matches(glovo: list[dict], mooup: list[dict]) -> list[dict]:
    pairs = []
    for gi, candidate in enumerate(glovo):
        for mi, other in enumerate(mooup):
            left, right = normalize(candidate.get("name")), normalize(other.get("name"))
            name_score = max(ratio(left, right), token_set_ratio(left, right)) / 100
            reasons = [f"Similarité de nom : {name_score:.0%}"]
            score = name_score * 0.72
            exact_external = bool(candidate.get("id") and other.get("id") and candidate["id"] == other["id"])
            if exact_external:
                score += 0.28
                reasons.append("Identifiant externe identique")
            if candidate.get("phone") and other.get("phone"):
                same_phone = re.sub(r"\D", "", candidate["phone"]) == re.sub(r"\D", "", other["phone"])
                if same_phone:
                    score += 0.2
                    reasons.append("Téléphone identique")
            exact_address = bool(candidate.get("address") and other.get("address") and
                                 normalize(candidate["address"]) == normalize(other["address"]))
            if exact_address:
                score += 0.18
                reasons.append("Adresse identique")
            score = min(score, 1.0)
            # A similar name alone is a lead, never a confirmed identity.
            status = "confirmed" if score >= 0.88 and (exact_external or exact_address or
                                                        (candidate.get("phone") and other.get("phone") and
                                                         re.sub(r"\D", "", candidate["phone"]) == re.sub(r"\D", "", other["phone"]))) else "review" if score >= 0.48 else "missing"
            pairs.append((score, gi, mi, status, reasons))
    chosen, used_glovo, used_mooup = {}, set(), set()
    for score, gi, mi, status, reasons in sorted(pairs, reverse=True):
        if status != "missing" and gi not in used_glovo and mi not in used_mooup:
            chosen[gi] = (score, mi, status, reasons)
            used_glovo.add(gi)
            used_mooup.add(mi)
    results = []
    for gi, candidate in enumerate(glovo):
        if gi in chosen:
            score, mi, status, reasons = chosen[gi]
            # Close alternative candidates lower confidence and require human review.
            alternatives = sorted((p[0] for p in pairs if p[1] == gi and p[2] != mi), reverse=True)
            if alternatives and score - alternatives[0] < 0.08:
                status = "review"
                reasons.append("Plusieurs correspondances proches")
            results.append({**candidate, "match": mooup[mi], "confidence": round(score, 3), "status": status, "reasons": reasons})
        else:
            top = max((p for p in pairs if p[1] == gi), default=None, key=lambda p: p[0])
            results.append({**candidate, "match": None, "confidence": round(top[0], 3) if top else 0.0,
                            "status": "missing", "reasons": top[4] if top and top[0] >= 0.35 else ["Aucune correspondance suffisamment proche"]})
    return results


def price_comparison(mooup_price, glovo_price):
    if mooup_price is None or glovo_price is None:
        return {"delta": None, "percent": None, "cheaper": None}
    delta = round(float(glovo_price) - float(mooup_price), 2)
    return {"delta": delta, "percent": round(delta / float(mooup_price) * 100, 2) if float(mooup_price) else None,
            "cheaper": "Mooup" if delta > 0 else "Glovo" if delta < 0 else "Identique"}


_SIZE_RE = re.compile(r"\b(?:xs|s|m|l|xl|xxl|small|medium|large|mini|maxi|\d+\s?(?:cl|ml|l|g|kg))\b")


def _product_features(item):
    name = item.get("name")
    size = item.get("size") or _size_hint(name)
    return {"name": normalize(name),
            "category_raw": item.get("category"),
            "category": normalize(item.get("category")),
            "description": normalize(item.get("description")),
            "size": normalize(size) if size else "",
            "price_missing": item.get("price") is None}


def match_products(glovo: list[dict], mooup: list[dict]) -> list[dict]:
    """Suggest product pairs; size mismatches are explicitly flagged for review."""
    left_rows = [(item, _product_features(item)) for item in glovo]
    right_rows = [(other, _product_features(other)) for other in mooup]
    drafts = []
    for index, (item, left) in enumerate(left_rows):
        ranked = []
        for other, right in right_rows:
            name_score = max(ratio(left["name"], right["name"]),
                             token_set_ratio(left["name"], right["name"])) / 100
            score = name_score * 0.76
            reasons = [f"Nom similaire : {name_score:.0%}"]
            if left["category_raw"] and right["category_raw"]:
                if left["category"] == right["category"]:
                    score += 0.08
                    reasons.append("Catégorie identique")
                else:
                    score -= 0.08
                    reasons.append("Catégorie différente")
            if left["description"] and right["description"]:
                desc_score = ratio(left["description"], right["description"]) / 100
                score += desc_score * 0.16
                reasons.append(f"Description similaire : {desc_score:.0%}")
            size_a, size_b = left["size"], right["size"]
            size_mismatch = bool(size_a and size_b and size_a != size_b)
            if size_mismatch:
                reasons.append("Taille ou format différent")
            if left["price_missing"] or right["price_missing"]:
                reasons.append("Prix manquant sur une plateforme")
            ranked.append((max(0, min(1, score)), other, size_mismatch, reasons))
        drafts.append((index, item, sorted(ranked, key=lambda row: row[0], reverse=True)))
    results = [None] * len(glovo)
    used = set()
    for index, item, ranked in sorted(drafts, key=lambda row: row[2][0][0] if row[2] else 0, reverse=True):
        candidate = next((row for row in ranked if id(row[1]) not in used), None)
        best = ranked[0] if ranked else (0, None, False, ["Aucun produit candidat"])
        duplicate = candidate is None and bool(ranked) and best[0] >= 0.55
        score, other, mismatch, reasons = candidate or best
        if duplicate:
            score, other, mismatch = best[0], None, False
            reasons = best[3] + ["Le produit candidat est déjà rapproché d’une autre variante"]
        elif other and len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.08:
            reasons = reasons + ["Plusieurs produits candidats ont un score proche"]
            status = "review"
        else:
            status = None
        status = status or ("review" if mismatch or duplicate or 0.55 <= score < 0.88 else "matched" if score >= 0.88 else "missing")
        if other and score >= 0.55:
            used.add(id(other))
        same_currency = bool(item.get("currency") and other and other.get("currency") and item.get("currency") == other.get("currency"))
        results[index] = {"glovo": item, "mooup": other if score >= 0.65 else None,
                          "confidence": round(score, 3), "status": status, "size_mismatch": mismatch,
                          "reasons": reasons,
                          "price": price_comparison(other.get("price"), item.get("price")) if score >= 0.65 and other and not mismatch and same_currency else None}
    return results


def _size_hint(name):
    match = _SIZE_RE.search(normalize(name))
    return match.group(0) if match else None
