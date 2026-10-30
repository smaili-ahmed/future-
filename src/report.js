import { ratio as fuzzRatio } from "fuzzball";

import { latestData, seedObservations, updateUserMissing } from "./db.js";
import { matchProducts, normalize, restaurantMatches } from "./matching.js";
import { MANUALLY_VALIDATED_MISSING } from "./seed_data.js";

export const PRESENCE_THRESHOLD = 0.96;
export const ABSENCE_THRESHOLD = 0.6;
export const RELIABLE_MATCH_CONFIDENCE = 0.7;
const WORKING_DAY_LABELS = {
  monday: "Lun",
  tuesday: "Mar",
  wednesday: "Mer",
  thursday: "Jeu",
  friday: "Ven",
  saturday: "Sam",
  sunday: "Dim",
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UNCERTAIN_REASON = /plusieurs produits candidats|déjà rapproché/i;
const PRODUCT_PAIR_CONFIDENCE = 0.7;
const CONTENT_SIMILARITY_CEILING = 0.5;
const MIN_DESCRIPTION_LENGTH = 15;

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function ratio(a, b) {
  if (!a || !b) return 0;
  return fuzzRatio(a, b);
}

export function implausiblePrice(value) {
  if (value === null || value === undefined) return false;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return true;
  return !(parsed >= 1.0 && parsed <= 1000.0);
}

function bestListingMatch(name, listings) {
  const target = normalize(name);
  const ranked = (listings || []).map((listing) => {
    const candidate = normalize(listing.name);
    const score = target && candidate ? ratio(target, candidate) / 100 : 0;
    return { score, listing };
  });
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked.length ? ranked[0] : { score: 0, listing: null };
  const near = ranked.filter((item) => item.score >= Math.max(0.82, best.score - 0.04));
  return {
    listing: best.score >= 0.68 ? best.listing : null,
    score: round(best.score, 3),
    ambiguous: near.length > 1,
    alternatives: near.slice(0, 5).map((item) => (item.listing || {}).name),
    candidate: (best.listing || {}).name,
    candidate_score: round(best.score, 3),
  };
}

function listingStatus(match, available) {
  if (!available) return "inaccessible";
  if (match.listing === null) return "not_found";
  if (match.score >= PRESENCE_THRESHOLD && !match.ambiguous) return "found";
  return "uncertain";
}

function classifyTracked(g, m, glovoAvailable, mooupAvailable, mooupCount = 0) {
  if (!glovoAvailable) {
    return ["insufficient", "Collecte Glovo indisponible : présence et absence non vérifiables."];
  }
  const gConfirmed = g.listing !== null && g.score >= PRESENCE_THRESHOLD && !g.ambiguous;
  const mConfirmed = Boolean(
    mooupAvailable && m.listing !== null && m.score >= PRESENCE_THRESHOLD && !m.ambiguous
  );
  if (gConfirmed && mConfirmed) {
    return ["both", `Identifié sur Glovo et sur Mooup (« ${m.listing.name} »).`];
  }
  if (!gConfirmed) {
    if (mConfirmed) {
      return ["mooup_only", `Identifié sur Mooup (« ${m.listing.name} »), absent des données Glovo collectées.`];
    }
    if (g.listing === null) {
      if (!mooupAvailable && m.listing === null) {
        return ["insufficient", "Aucune fiche collectée sur les deux plateformes."];
      }
      return [
        "to_verify",
        `Non retrouvé dans les données Glovo collectées (meilleur candidat « ${g.candidate} » à ${Math.round(
          g.score * 100
        )}%).`,
      ];
    }
    return [
      "to_verify",
      `Fiche Glovo incertaine (« ${g.listing.name} » à ${Math.round(g.score * 100)}%) : présence à confirmer.`,
    ];
  }
  if (!mooupAvailable) {
    return ["to_verify", "Catalogue Mooup indisponible : l’absence sur Mooup ne peut pas être vérifiée."];
  }
  if (m.listing !== null) {
    return [
      "to_verify",
      `Candidat Mooup proche « ${m.listing.name} » (${Math.round(m.score * 100)}%) : présence à confirmer.`,
    ];
  }
  if (m.score >= ABSENCE_THRESHOLD) {
    return [
      "to_verify",
      `Meilleur candidat Mooup « ${m.candidate} » (${Math.round(
        m.score * 100
      )}%) : écart trop faible pour conclure.`,
    ];
  }
  return [
    "glovo_only",
    `Aucun candidat Mooup au-dessus de ${Math.round(ABSENCE_THRESHOLD * 100)}% sur les ${mooupCount} restaurants du catalogue Mooup chargé.`,
  ];
}

function formatWorkingDays(days) {
  const parts = [];
  for (const day of days || []) {
    if (!day || typeof day !== "object" || day.disabled) continue;
    const start = day.from;
    const end = day.to;
    if (!start || !end) continue;
    const label = WORKING_DAY_LABELS[day.day] || day.day || "";
    parts.push(`${label} ${String(start).replace(/-/g, ":")}–${String(end).replace(/-/g, ":")}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

function restaurantInfo(listing, platform) {
  if (!listing) return null;
  let raw = listing.raw;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  raw = raw && typeof raw === "object" ? raw : {};
  const info = {
    platform,
    name: listing.name,
    url: listing.url,
    image: listing.image,
    category: listing.category,
    address: listing.address,
    description: listing.description,
    products_count: (listing.products || []).length,
    collected_at: listing.collected_at,
    hours: null,
    open: null,
    source: listing.source,
  };
  if (platform === "glovo") {
    info.rating = listing.rating || raw.rating;
    info.reviews = listing.reviews || raw.reviews;
    info.cuisines = raw.cuisines;
    info.open = raw.open;
    info.promotion = listing.promotion || raw.promotion;
  } else {
    const availability = raw.availability && typeof raw.availability === "object" ? raw.availability : {};
    info.hours = formatWorkingDays(availability.working_days);
    info.open = availability.open !== undefined ? availability.open : listing.available;
    info.status = listing.status;
  }
  return info;
}

function attachRestaurantResearch(data) {
  const { watchlist, manual, history: manualHistory } = seedObservations();
  const glovo = ((data.restaurants || {}).glovo) || [];
  const mooup = ((data.restaurants || {}).mooup) || [];
  const glovoAvailable = Boolean(data.run && glovo.length && (data.run.status || "") !== "failed");
  const mooupAvailable = Boolean(data.mooup_catalog_available);
  const lastChecked = (data.run || {}).finished_at;
  const normalizedCounts = {};
  for (const entry of watchlist) {
    normalizedCounts[entry.normalized_name] = (normalizedCounts[entry.normalized_name] || 0) + 1;
  }

  const analyses = [];
  for (const entry of watchlist) {
    const g = bestListingMatch(entry.input_name, glovo);
    const m = bestListingMatch(entry.input_name, mooup);
    const gStatus = !glovoAvailable
      ? "inaccessible"
      : g.score >= 0.96 && !g.ambiguous
        ? "found"
        : g.score >= 0.68
          ? "uncertain"
          : "not_found";
    const mStatus = m.score >= 0.96 && !m.ambiguous ? "found" : m.score >= 0.68 ? "uncertain" : "not_found";
    const commonMatch = (data.matches || []).find(
      (row) => row.glovo_name === (g.listing || {}).name
    );
    let status;
    if (gStatus === "uncertain" || (mooupAvailable && mStatus === "uncertain") || g.ambiguous || m.ambiguous) {
      status = "uncertain";
    } else if (!mooupAvailable) {
      status =
        gStatus === "found" ? "glovo_only_unverified" : gStatus === "not_found" ? "not_found_unverified" : "inaccessible";
    } else if (!glovoAvailable) {
      status = "inaccessible";
    } else if (
      gStatus === "found" &&
      mStatus === "found" &&
      commonMatch &&
      commonMatch.status === "confirmed"
    ) {
      status = "both";
    } else if (gStatus === "found" && mStatus === "found") {
      status = "uncertain";
    } else if (gStatus === "found") {
      status = "glovo_only";
    } else if (mStatus === "found") {
      status = "mooup_only";
    } else {
      status = "not_found";
    }
    analyses.push({
      position: entry.position,
      name: entry.input_name,
      normalized_name: entry.normalized_name,
      duplicate_count: normalizedCounts[entry.normalized_name],
      duplicate_warning: normalizedCounts[entry.normalized_name] > 1,
      status,
      glovo_status: gStatus,
      mooup_status: mooupAvailable ? mStatus : "inaccessible",
      glovo: g.listing,
      mooup: m.listing,
      glovo_confidence: g.score,
      mooup_confidence: m.score,
      manual_match_status: commonMatch ? commonMatch.status : null,
      last_checked: lastChecked,
    });
  }
  data.restaurant_watchlist = analyses;
  data.watchlist_count = analyses.length;
  data.watchlist_exact_duplicates = Object.values(normalizedCounts).reduce(
    (total, count) => total + (count > 1 ? count - 1 : 0),
    0
  );

  for (const row of manual) {
    const g = bestListingMatch(row.name, glovo);
    const m = bestListingMatch(row.name, mooup);
    const manualMatch = (data.matches || []).find(
      (item) =>
        item.glovo_name === (g.listing || {}).name && item.mooup_name === (m.listing || {}).name
    );
    let status;
    if (!mooupAvailable) {
      status = "À ajouter sur Mooup — validé manuellement";
    } else if (m.score >= 0.96 && manualMatch && manualMatch.status === "confirmed") {
      status = "Présent sur Mooup — correspondance confirmée";
    } else if (m.score >= 0.88) {
      status = "Présence détectée sur Mooup — à vérifier";
    } else {
      status = "Non retrouvé dans l’export Mooup — à ajouter";
    }
    const checked = lastChecked || row.last_checked_at || row.verified_at;
    updateUserMissing(
      row.name,
      status,
      checked,
      (m.listing || {}).name ?? null,
      (g.listing || {}).url ?? null,
      (g.listing || {}).image ?? null,
      (g.listing || {}).category || "Food"
    );
  }

  const { manual: currentManual, history } = seedObservations();
  data.manual_missing_restaurants = currentManual.map((row) => {
    const match = bestListingMatch(row.name, glovo);
    return {
      ...row,
      glovo: match.listing,
      products_count: match.listing ? (match.listing.products || []).length : null,
    };
  });
  data.manual_missing_initial_count = currentManual.length;
  data.manual_missing_history = history;
  data.automatic_missing_restaurants = mooupAvailable
    ? (data.matches || [])
        .filter((row) => row.status === "missing")
        .map((row) => ({ ...row, products_count: (row.products || []).length }))
    : [];

  return manualHistory;
}

function buildTrackedRestaurants(data) {
  const { watchlist, manual: manualRows } = seedObservations();
  const glovo = ((data.restaurants || {}).glovo) || [];
  const mooup = ((data.restaurants || {}).mooup) || [];
  const glovoAvailable = Boolean(data.run && glovo.length && (data.run.status || "") !== "failed");
  const mooupAvailable = Boolean(data.mooup_catalog_available);
  const lastChecked = (data.run || {}).finished_at;
  const manualByName = new Map(manualRows.map((row) => [row.name, row]));
  const entries = [
    ...MANUALLY_VALIDATED_MISSING.map((name) => ({ name, manual: true })),
    ...watchlist.map((row) => ({ name: row.input_name, manual: false })),
  ];
  const counts = {};
  for (const { name } of entries) {
    counts[normalize(name)] = (counts[normalize(name)] || 0) + 1;
  }

  return entries.map(({ name, manual }, index) => {
    const g = bestListingMatch(name, glovo);
    const m = bestListingMatch(name, mooup);
    const [status, reason] = classifyTracked(g, m, glovoAvailable, mooupAvailable, mooup.length);
    const manualRow = manual ? manualByName.get(name) : null;
    const listing = g.listing;
    const checked =
      lastChecked || (manualRow || {}).last_checked_at || (manualRow || {}).verified_at || null;
    return {
      position: index + 1,
      name,
      normalized_name: normalize(name),
      manual,
      duplicate_count: counts[normalize(name)],
      duplicate_warning: counts[normalize(name)] > 1,
      status,
      reason,
      manual_status: (manualRow || {}).status,
      glovo_status: listingStatus(g, glovoAvailable),
      mooup_status: listingStatus(m, mooupAvailable),
      glovo: listing,
      mooup: m.listing,
      mooup_candidate: m.candidate,
      mooup_candidate_score: m.candidate_score,
      glovo_candidate: g.candidate,
      glovo_candidate_score: g.candidate_score,
      glovo_confidence: g.score,
      mooup_confidence: m.score,
      glovo_ambiguous: g.ambiguous,
      mooup_ambiguous: m.ambiguous,
      category: (listing || {}).category || (manualRow || {}).category,
      products_count: listing ? (listing.products || []).length : null,
      image: (listing || {}).image || (manualRow || {}).image,
      glovo_url: (listing || {}).url || (manualRow || {}).glovo_url,
      last_verified_at: checked,
      glovo_info: restaurantInfo(listing, "glovo"),
      mooup_info: restaurantInfo(m.listing, "mooup"),
    };
  });
}

function isReliableMatch(match) {
  if (!match.mooup_name) return false;
  if (match.status === "confirmed") return true;
  return match.status === "review" && Number(match.confidence || 0) >= RELIABLE_MATCH_CONFIDENCE;
}

function buildCommonRestaurants(data) {
  const glovo = new Map((((data.restaurants || {}).glovo) || []).map((row) => [row.name, row]));
  const mooup = new Map((((data.restaurants || {}).mooup) || []).map((row) => [row.name, row]));
  const comparisons = data.product_comparisons || [];
  const trackedNames = new Set((data.tracked_restaurants || []).map((row) => row.name));
  const rows = [];
  let excluded = 0;

  for (const match of data.matches || []) {
    if (!match.mooup_name) continue;
    if (!isReliableMatch(match)) {
      excluded += 1;
      continue;
    }
    const left = glovo.get(match.glovo_name);
    const right = mooup.get(match.mooup_name);
    if (!left || !right) continue;
    const restaurantRows = comparisons.filter((row) => row.restaurant === match.glovo_name);
    const paired = restaurantRows.filter((row) => row.glovo_product && row.mooup_product).length;
    const comparable = restaurantRows.filter((row) => row.delta !== null && row.delta !== undefined).length;
    const anomalies = restaurantRows.filter((row) => row.price_anomaly).length;
    const gaps = restaurantRows.filter(
      (row) => row.delta !== null && row.delta !== undefined && row.delta !== 0 && !row.price_anomaly
    ).length;
    rows.push({
      name: match.glovo_name,
      mooup_name: match.mooup_name,
      category: left.category || right.category,
      image: left.image || right.image,
      url: left.url,
      mooup_url: right.url,
      glovo_products: (left.products || []).length,
      mooup_products: (right.products || []).length,
      paired_products: paired,
      comparable_products: comparable,
      price_gaps: gaps,
      price_anomalies: anomalies,
      confidence: match.confidence,
      match_status: match.status,
      reasons: match.reasons || [],
      tracked: trackedNames.has(match.glovo_name),
      glovo_info: restaurantInfo(left, "glovo"),
      mooup_info: restaurantInfo(right, "mooup"),
    });
  }
  rows.sort(
    (a, b) =>
      b.price_gaps - a.price_gaps ||
      b.comparable_products - a.comparable_products ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
  return [rows, excluded];
}

function productRow(restaurant, glovoProduct, mooupProduct, status, pair, options = {}) {
  const { reverse = false, missingSide = null } = options;
  if (reverse) {
    mooupProduct = glovoProduct;
    glovoProduct = pair.mooup;
  }
  const price = status === "matched" || status === "review" ? pair.price : null;
  const glovoChecked = (glovoProduct || {}).collected_at || "";
  const mooupChecked = (mooupProduct || {}).collected_at || "";
  const lastChecked = (glovoChecked > mooupChecked ? glovoChecked : mooupChecked) || null;
  return {
    restaurant: restaurant.glovo_name,
    product: ((glovoProduct || mooupProduct || {}).name),
    glovo_product: glovoProduct,
    mooup_product: mooupProduct,
    glovo_price: (glovoProduct || {}).price,
    mooup_price: (mooupProduct || {}).price,
    delta: price ? price.delta : null,
    percent: price ? price.percent : null,
    cheaper: price ? price.cheaper : null,
    confidence: pair.confidence !== undefined ? pair.confidence : 0,
    reasons: pair.reasons || [],
    status,
    missing_side: missingSide,
    restaurant_status: restaurant.status,
    price_anomaly:
      implausiblePrice((glovoProduct || {}).price) || implausiblePrice((mooupProduct || {}).price),
    currency: (glovoProduct || {}).currency || (mooupProduct || {}).currency,
    glovo_url: (glovoProduct || {}).url,
    mooup_url: (mooupProduct || {}).url,
    last_checked: lastChecked,
  };
}

function buildProductComparisons(data) {
  const glovo = ((data.restaurants || {}).glovo) || [];
  const mooup = ((data.restaurants || {}).mooup) || [];
  const rows = [];
  for (const restaurant of data.matches || []) {
    if (
      !["confirmed", "review"].includes(restaurant.status) ||
      !restaurant.mooup_name
    ) {
      continue;
    }
    const left = glovo.find((item) => item.name === restaurant.glovo_name);
    const right = mooup.find((item) => item.name === restaurant.mooup_name);
    if (!left || !right) continue;

    const pairs = matchProducts(left.products || [], right.products || []);
    for (const pair of pairs) {
      const leftProduct = pair.glovo;
      const rightProduct = pair.mooup;
      if (pair.status === "missing") {
        const status = restaurant.status === "confirmed" ? "missing_mooup" : "review";
        rows.push(productRow(restaurant, leftProduct, null, status, pair, { missingSide: "mooup" }));
        continue;
      }
      if (rightProduct) {
        rows.push(
          productRow(
            restaurant,
            leftProduct,
            rightProduct,
            pair.status === "matched" && restaurant.status === "confirmed" ? "matched" : "review",
            pair
          )
        );
      } else if (pair.status === "review") {
        rows.push(productRow(restaurant, leftProduct, null, "review", pair, { missingSide: "mooup" }));
      }
    }

    const reverse = matchProducts(right.products || [], left.products || []);
    for (const pair of reverse) {
      if (pair.status === "missing") {
        const status = restaurant.status === "confirmed" ? "missing_glovo" : "review";
        rows.push(
          productRow(restaurant, pair.glovo, null, status, pair, {
            reverse: true,
            missingSide: "glovo",
          })
        );
      } else if (pair.status === "review" && !pair.mooup) {
        rows.push(
          productRow(restaurant, pair.glovo, null, "review", pair, {
            reverse: true,
            missingSide: "glovo",
          })
        );
      }
    }
  }
  return rows;
}

function substantiveDescription(item) {
  const text = normalize((item || {}).description);
  if (text.length < MIN_DESCRIPTION_LENGTH || text === normalize((item || {}).name)) return "";
  return text;
}

function productContentDiffers(glovoProduct, mooupProduct) {
  const left = substantiveDescription(glovoProduct);
  const right = substantiveDescription(mooupProduct);
  if (!left || !right) return false;
  return ratio(left, right) / 100 < CONTENT_SIMILARITY_CEILING;
}

function catalogRow(glovoProduct, mooupProduct, pair, options = {}) {
  const { orderG = null, orderM = null, reverse = false } = options;
  const both = Boolean(glovoProduct && mooupProduct);
  const price = pair && !reverse ? pair.price : null;
  const delta = price ? price.delta : null;
  const percent = price ? price.percent : null;
  const cheaper = price ? price.cheaper : null;
  const sizeMismatch = Boolean(pair && pair.size_mismatch);
  const contentDiff = productContentDiffers(glovoProduct, mooupProduct);
  const reasons = [...((pair || {}).reasons || [])];
  if (reverse) {
    const candidate = (pair || {}).mooup;
    if (candidate) {
      reasons.push(`Correspondance Glovo « ${candidate.name} » déjà rapprochée d’un autre produit`);
    } else {
      reasons.push("Aucun produit Glovo équivalent dans le catalogue collecté");
    }
  }
  const confidence = Number((pair || {}).confidence || 0);
  const ambiguous = reasons.some((reason) => UNCERTAIN_REASON.test(reason));
  const uncertain = both && (sizeMismatch || ambiguous || contentDiff || confidence < PRODUCT_PAIR_CONFIDENCE);
  const owner = glovoProduct || mooupProduct || {};
  return {
    kind: both ? "paired" : glovoProduct ? "glovo_only" : "mooup_only",
    category: String(owner.category || "").trim() || "Non classé",
    glovo_product: glovoProduct,
    mooup_product: mooupProduct,
    delta,
    percent,
    cheaper,
    price_anomaly:
      implausiblePrice((glovoProduct || {}).price) || implausiblePrice((mooupProduct || {}).price),
    size_mismatch: sizeMismatch,
    content_different: contentDiff,
    uncertain,
    confidence,
    reasons,
    currency: (glovoProduct || {}).currency || (mooupProduct || {}).currency,
    order_g: orderG,
    order_m: orderM,
  };
}

function resolveCatalogPair(data, glovoName, mooupName = null) {
  const listings = data.restaurants || {};
  const left = (listings.glovo || []).find((item) => item.name === glovoName);
  if (left === undefined) {
    throw new HttpError(404, "Restaurant Glovo introuvable dans la dernière collecte.");
  }
  const mooupListings = listings.mooup || [];
  let match = {
    glovo_name: glovoName,
    mooup_name: null,
    confidence: 0.0,
    status: "missing",
    reasons: ["Aucune correspondance Mooup résolue."],
  };
  if (mooupListings.length) {
    const computed = restaurantMatches(listings.glovo || [], mooupListings).find(
      (item) => item.name === glovoName
    );
    if (computed) {
      match = {
        glovo_name: glovoName,
        mooup_name: (computed.match || {}).name ?? null,
        confidence: computed.confidence || 0.0,
        status: computed.status,
        reasons: computed.reasons || [],
      };
    }
    for (const override of data.match_overrides || []) {
      if (override.glovo_name === glovoName) {
        match = {
          glovo_name: glovoName,
          mooup_name: override.mooup_name,
          confidence: override.status === "confirmed" ? 1.0 : 0.0,
          status: override.status,
          reasons: ["Correspondance validée manuellement"],
        };
      }
    }
  }

  const target = mooupName || match.mooup_name;
  let right = null;
  if (target) {
    right = mooupListings.find((item) => item.name === target);
    if (right === undefined) {
      throw new HttpError(404, "Restaurant Mooup introuvable dans le catalogue chargé.");
    }
    if (match.mooup_name !== target) {
      match = {
        ...match,
        mooup_name: target,
        reasons: [...(match.reasons || []), "Fiche Mooup choisie explicitement pour la comparaison"],
      };
    }
  }
  return [left, right, match];
}

export function buildCatalogComparison(data, glovoName, mooupName = null) {
  const [left, right, match] = resolveCatalogPair(data, glovoName, mooupName);
  const sourceMeta = ((data.restaurants || {})._meta) || {};
  const glovoAvailable = Boolean(
    data.run && ((data.restaurants || {}).glovo || []).length && data.run.status !== "failed"
  );
  const mooupAvailable = Boolean(data.mooup_imported_at || sourceMeta.mooup);
  const glovoProducts = [...(left.products || [])];
  const mooupProducts = right ? [...(right.products || [])] : [];
  const rows = [];

  if (mooupProducts.length) {
    const forward = matchProducts(glovoProducts, mooupProducts);
    const mooupPositions = new Map(mooupProducts.map((product, index) => [product, index]));
    const claimed = new Set();
    forward.forEach((pair, index) => {
      const partner = pair.mooup;
      if (partner !== null && partner !== undefined) claimed.add(mooupPositions.get(partner));
      rows.push(catalogRow(pair.glovo, partner, pair, { orderG: index }));
    });
    matchProducts(mooupProducts, glovoProducts).forEach((pair, index) => {
      if (claimed.has(index)) return;
      rows.push(catalogRow(null, mooupProducts[index], pair, { orderM: index, reverse: true }));
    });
  } else {
    const reason = !mooupAvailable
      ? "Catalogue Mooup non collecté : absence non vérifiable."
      : (match.reasons || ["Restaurant Mooup non rapproché."])[0];
    glovoProducts.forEach((product, index) => {
      rows.push(
        catalogRow(
          product,
          null,
          { reasons: [reason], confidence: 0.0, status: "missing", size_mismatch: false },
          { orderG: index }
        )
      );
    });
  }

  rows.forEach((row, index) => {
    row.key = index;
  });
  const paired = rows.filter((row) => row.kind === "paired");
  const summary = {
    glovo_products: glovoProducts.length,
    mooup_products: mooupProducts.length,
    paired: paired.length,
    missing_mooup: rows.filter((row) => row.kind === "glovo_only").length,
    missing_glovo: rows.filter((row) => row.kind === "mooup_only").length,
    price_gaps: paired.filter(
      (row) => row.delta !== null && row.delta !== undefined && row.delta !== 0 && !row.price_anomaly
    ).length,
    price_identical: paired.filter((row) => row.delta === 0).length,
    comparable: paired.filter((row) => row.delta !== null && row.delta !== undefined).length,
    uncertain: paired.filter((row) => row.uncertain).length,
    anomalies: rows.filter((row) => row.price_anomaly).length,
  };

  const categoriesOf = (products) => {
    const result = [];
    for (const product of products) {
      const name = String(product.category || "").trim() || "Non classé";
      if (!result.includes(name)) result.push(name);
    }
    return result;
  };

  return {
    match,
    glovo: restaurantInfo(left, "glovo"),
    mooup: right ? restaurantInfo(right, "mooup") : null,
    rows,
    glovo_categories: categoriesOf(glovoProducts),
    mooup_categories: categoriesOf(mooupProducts),
    summary,
    meta: {
      glovo_available: glovoAvailable,
      mooup_catalog_available: mooupAvailable,
      mooup_source: data.mooup_imported_at
        ? "catalog import"
        : sourceMeta.mooup
          ? "Mooup catalog:read API"
          : null,
      mooup_last_sync: data.mooup_imported_at || (sourceMeta.mooup || {}).synced_at,
      glovo_scraped_at: (sourceMeta.glovo || {}).scraped_at,
      generated_at: new Date().toISOString(),
    },
  };
}

function qualityReport(data) {
  const glovo = ((data.restaurants || {}).glovo) || [];
  const mooup = ((data.restaurants || {}).mooup) || [];
  const products = [...glovo, ...mooup].flatMap((listing) => listing.products || []);
  const knownPrices = products.filter((product) => product.price !== null && product.price !== undefined).length;
  const sourceMeta = ((data.restaurants || {})._meta) || {};
  const glovoMeta = sourceMeta.glovo || {};
  const expected = glovoMeta.restaurants_reported;
  const coverage =
    Number.isInteger(expected) && expected > 0 ? round((glovo.length / expected) * 100, 1) : null;
  const live = glovoMeta.source === "glovo live";
  const coverageNote =
    coverage !== null
      ? live
        ? `${glovo.length}/${expected} fiches lues en direct sur Glovo; ce taux porte sur les fiches suivies, pas sur toute l’offre Glovo.`
        : `${glovo.length}/${expected} fiches lues depuis l’export local; ce taux porte sur l’export, pas sur toute l’offre Glovo.`
      : "Le total global des plateformes n’est pas publié; la couverture en pourcentage n’est pas calculable.";
  return {
    restaurants_glovo: glovo.length,
    restaurants_mooup: mooup.length,
    products_glovo: glovo.reduce((total, row) => total + (row.products || []).length, 0),
    products_mooup: mooup.reduce((total, row) => total + (row.products || []).length, 0),
    menus_collected: [...glovo, ...mooup].filter((row) => row.menu_collect_status === "collected").length,
    products_total: products.length,
    prices_missing: products.length - knownPrices,
    descriptions_missing: products.filter((product) => !product.description).length,
    availability_unknown: products.filter(
      (product) => product.available === null || product.available === undefined
    ).length,
    prices_found: knownPrices,
    pages_inaccessible: (data.errors || []).filter(
      (error) =>
        String(error.message || "").includes("Fiche inaccessible") ||
        String(error.message || "").includes("Collecte inaccessible")
    ).length,
    limitations: (data.errors || []).length,
    pages_visited: glovoMeta.source ? 0 : glovo.length + 2,
    glovo_export_reported: expected,
    coverage_percent: coverage,
    coverage_note: coverageNote,
    catalog_sources: sourceMeta,
    last_sync: (data.run || {}).finished_at,
    mooup_imported_at: data.mooup_imported_at,
  };
}

function buildPriceComparisons(data) {
  const rows = [];
  for (const row of data.product_comparisons || []) {
    if (row.missing_side || row.delta === null || row.delta === undefined) continue;
    if (!["matched", "review"].includes(row.status)) continue;
    const glovoProduct = row.glovo_product || {};
    rows.push({
      restaurant: row.restaurant,
      product: row.product,
      category: glovoProduct.category,
      mooup_price: row.mooup_price,
      glovo_price: row.glovo_price,
      delta: row.delta,
      percent: row.percent,
      cheaper: row.cheaper,
      price_anomaly: Boolean(row.price_anomaly),
      verification: row.status === "matched" ? "Confirmé" : "À vérifier",
      confidence: row.confidence,
      mooup_url: row.mooup_url,
      glovo_url: row.glovo_url,
      currency: glovoProduct.currency || "MAD",
      last_checked: row.last_checked,
    });
  }
  return rows;
}

export function buildReport() {
  const data = latestData();
  const runMeta = ((data.restaurants || {})._meta) || {};
  data.mooup_catalog_available = Boolean(data.mooup_imported_at || runMeta.mooup);
  data.mooup_source = data.mooup_imported_at
    ? "catalog import"
    : runMeta.mooup
      ? "Mooup catalog:read API"
      : null;
  data.mooup_last_sync = data.mooup_imported_at || (runMeta.mooup || {}).synced_at;
  data.mooup_catalog_stale = Boolean((runMeta.mooup || {}).stale_snapshot);
  data.mooup_api_configured = Boolean((process.env.MOOUP_CATALOG_API_KEY || "").trim());

  data.matches = data.matches || [];
  if (data.mooup_catalog_available) {
    const rawMatches = restaurantMatches(
      (data.restaurants || {}).glovo || [],
      (data.restaurants || {}).mooup || []
    );
    data.matches = rawMatches.map((item) => ({
      glovo_name: item.name,
      mooup_name: (item.match || {}).name,
      confidence: item.confidence,
      status: item.status,
      reasons: item.reasons,
    }));
    for (const override of data.match_overrides || []) {
      const selected = data.matches.find((item) => item.glovo_name === override.glovo_name);
      if (selected) {
        Object.assign(selected, {
          mooup_name: override.mooup_name,
          status: override.status,
          confidence: override.status === "confirmed" ? 1.0 : 0.0,
          reasons: ["Correspondance validée manuellement"],
        });
      }
    }
  }

  data.missing_from_glovo = (((data.restaurants || {}).mooup) || []).filter(
    (item) =>
      !data.matches.some(
        (m) => m.mooup_name === item.name && (m.status === "confirmed" || m.status === "review")
      )
  );
  data.product_comparisons = buildProductComparisons(data);
  data.missing_products_mooup = data.product_comparisons.filter((row) => row.status === "missing_mooup");
  data.missing_products_glovo = data.product_comparisons.filter((row) => row.status === "missing_glovo");
  data.quality = qualityReport(data);
  data.price_comparisons = buildPriceComparisons(data);
  attachRestaurantResearch(data);
  data.tracked_restaurants = buildTrackedRestaurants(data);
  const [common, excluded] = buildCommonRestaurants(data);
  data.common_restaurants = common;
  data.common_restaurants_excluded = excluded;
  return data;
}
