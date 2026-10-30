import { ratio as fuzzRatio, token_set_ratio as fuzzTokenSet } from "fuzzball";

const cache = new Map();

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function normalize(value) {
  const key = value === null || value === undefined ? "" : String(value);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const normalized = key
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (cache.size > 65536) cache.clear();
  cache.set(key, normalized);
  return normalized;
}

function ratio(a, b) {
  if (!a || !b) return 0;
  return fuzzRatio(a, b);
}

function tokenSetRatio(a, b) {
  if (!a || !b) return 0;
  return fuzzTokenSet(a, b);
}

export function restaurantMatches(glovo, mooup) {
  const pairs = [];
  glovo.forEach((candidate, gi) => {
    mooup.forEach((other, mi) => {
      const left = normalize(candidate.name);
      const right = normalize(other.name);
      const nameScore = Math.max(ratio(left, right), tokenSetRatio(left, right)) / 100;
      const reasons = [`Similarité de nom : ${Math.round(nameScore * 100)}%`];
      let score = nameScore * 0.72;
      const exactExternal = Boolean(candidate.id && other.id && candidate.id === other.id);
      if (exactExternal) {
        score += 0.28;
        reasons.push("Identifiant externe identique");
      }
      const candidatePhone = candidate.phone ? String(candidate.phone).replace(/\D/g, "") : "";
      const otherPhone = other.phone ? String(other.phone).replace(/\D/g, "") : "";
      if (candidatePhone && otherPhone && candidatePhone === otherPhone) {
        score += 0.2;
        reasons.push("Téléphone identique");
      }
      const exactAddress = Boolean(
        candidate.address && other.address && normalize(candidate.address) === normalize(other.address)
      );
      if (exactAddress) {
        score += 0.18;
        reasons.push("Adresse identique");
      }
      score = Math.min(score, 1.0);
      const confirmedByIdentity =
        exactExternal || exactAddress || (candidatePhone && otherPhone && candidatePhone === otherPhone);
      const status = score >= 0.88 && confirmedByIdentity ? "confirmed" : score >= 0.48 ? "review" : "missing";
      pairs.push({ score, gi, mi, status, reasons });
    });
  });

  const ordered = pairs
    .slice()
    .sort((a, b) => b.score - a.score || b.gi - a.gi || b.mi - a.mi);
  const chosen = new Map();
  const usedGlovo = new Set();
  const usedMooup = new Set();
  for (const pair of ordered) {
    if (pair.status !== "missing" && !usedGlovo.has(pair.gi) && !usedMooup.has(pair.mi)) {
      chosen.set(pair.gi, pair);
      usedGlovo.add(pair.gi);
      usedMooup.add(pair.mi);
    }
  }

  return glovo.map((candidate, gi) => {
    const pair = chosen.get(gi);
    if (pair) {
      let { status } = pair;
      const reasons = pair.reasons.slice();
      const alternatives = pairs
        .filter((item) => item.gi === gi && item.mi !== pair.mi)
        .map((item) => item.score)
        .sort((a, b) => b - a);
      if (alternatives.length && pair.score - alternatives[0] < 0.08) {
        status = "review";
        reasons.push("Plusieurs correspondances proches");
      }
      return {
        ...candidate,
        match: mooup[pair.mi],
        confidence: round(pair.score, 3),
        status,
        reasons,
      };
    }
    const candidates = pairs.filter((item) => item.gi === gi);
    const top = candidates.length ? candidates.reduce((best, item) => (item.score > best.score ? item : best)) : null;
    return {
      ...candidate,
      match: null,
      confidence: round(top ? top.score : 0, 3),
      status: "missing",
      reasons:
        top && top.score >= 0.35 ? top.reasons : ["Aucune correspondance suffisamment proche"],
    };
  });
}

export function priceComparison(mooupPrice, glovoPrice) {
  if (mooupPrice === null || mooupPrice === undefined || glovoPrice === null || glovoPrice === undefined) {
    return { delta: null, percent: null, cheaper: null };
  }
  const delta = round(Number(glovoPrice) - Number(mooupPrice), 2);
  return {
    delta,
    percent: Number(mooupPrice) ? round((delta / Number(mooupPrice)) * 100, 2) : null,
    cheaper: delta > 0 ? "Mooup" : delta < 0 ? "Glovo" : "Identique",
  };
}

const SIZE_RE = /\b(?:xs|s|m|l|xl|xxl|small|medium|large|mini|maxi|\d+\s?(?:cl|ml|l|g|kg))\b/;

function productFeatures(item) {
  const name = item.name;
  const size = item.size || sizeHint(name);
  return {
    name: normalize(name),
    category_raw: item.category,
    category: normalize(item.category),
    description: normalize(item.description),
    size: size ? normalize(size) : "",
    price_missing: item.price === null || item.price === undefined,
  };
}

function sizeHint(name) {
  const match = normalize(name).match(SIZE_RE);
  return match ? match[0] : null;
}

export function matchProducts(glovo, mooup) {
  const leftRows = glovo.map((item) => ({ item, features: productFeatures(item) }));
  const rightRows = mooup.map((other) => ({ item: other, features: productFeatures(other) }));
  const drafts = [];

  leftRows.forEach(({ item, features: left }, index) => {
    const ranked = rightRows.map(({ item: other, features: right }) => {
      const nameScore = Math.max(ratio(left.name, right.name), tokenSetRatio(left.name, right.name)) / 100;
      let score = nameScore * 0.76;
      const reasons = [`Nom similaire : ${Math.round(nameScore * 100)}%`];
      if (left.category_raw && right.category_raw) {
        if (left.category === right.category) {
          score += 0.08;
          reasons.push("Catégorie identique");
        } else {
          score -= 0.08;
          reasons.push("Catégorie différente");
        }
      }
      if (left.description && right.description) {
        const descScore = ratio(left.description, right.description) / 100;
        score += descScore * 0.16;
        reasons.push(`Description similaire : ${Math.round(descScore * 100)}%`);
      }
      const sizeA = left.size;
      const sizeB = right.size;
      const sizeMismatch = Boolean(sizeA && sizeB && sizeA !== sizeB);
      if (sizeMismatch) reasons.push("Taille ou format différent");
      if (left.price_missing || right.price_missing) reasons.push("Prix manquant sur une plateforme");
      return {
        score: Math.max(0, Math.min(1, score)),
        other,
        sizeMismatch,
        reasons,
      };
    });
    ranked.sort((a, b) => b.score - a.score);
    drafts.push({ index, item, ranked });
  });

  const results = new Array(glovo.length).fill(null);
  const used = new Set();

  drafts
    .slice()
    .sort((a, b) => (b.ranked.length ? b.ranked[0].score : 0) - (a.ranked.length ? a.ranked[0].score : 0))
    .forEach(({ index, item, ranked }) => {
      const candidate = ranked.find((row) => !used.has(row.other));
      const best = ranked.length
        ? ranked[0]
        : { score: 0, other: null, sizeMismatch: false, reasons: ["Aucun produit candidat"] };
      const duplicate = !candidate && ranked.length > 0 && best.score >= 0.55;
      let chosen = candidate || best;
      let { score, other, sizeMismatch } = chosen;
      let reasons = chosen.reasons;
      let status = null;

      if (duplicate) {
        score = best.score;
        other = null;
        sizeMismatch = false;
        reasons = best.reasons.concat(["Le produit candidat est déjà rapproché d’une autre variante"]);
      } else if (other && ranked.length > 1 && ranked[0].score - ranked[1].score < 0.08) {
        reasons = reasons.concat(["Plusieurs produits candidats ont un score proche"]);
        status = "review";
      }

      status =
        status ||
        (sizeMismatch || duplicate || (score >= 0.55 && score < 0.88)
          ? "review"
          : score >= 0.88
            ? "matched"
            : "missing");

      if (other && score >= 0.55) used.add(other);

      const sameCurrency = Boolean(
        item.currency && other && other.currency && item.currency === other.currency
      );
      results[index] = {
        glovo: item,
        mooup: other && score >= 0.65 ? other : null,
        confidence: round(score, 3),
        status,
        size_mismatch: sizeMismatch,
        reasons,
        price:
          score >= 0.65 && other && !sizeMismatch && sameCurrency
            ? priceComparison(other.price, item.price)
            : null,
      };
    });

  return results;
}
