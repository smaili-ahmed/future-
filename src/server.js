import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseCsv } from "csv-parse/sync";
import express from "express";

import { collectPlatforms } from "./collector.js";
import {
  initialize,
  latestData,
  saveCatalog,
  saveMatchOverride,
  savePriceHistory,
  saveRun,
  seedIfEmpty,
} from "./db.js";
import { assetPath, loadGlovoExport } from "./glovo_export.js";
import { restaurantMatches } from "./matching.js";
import { fetchMooupCatalog, MooupCatalogError } from "./mooup_api.js";
import { buildCatalogComparison, buildReport, HttpError } from "./report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const app = express();
app.disable("x-powered-by");
app.use("/static", express.static(path.join(ROOT, "app", "static")));
app.use("/images", express.static(path.join(ROOT, "public", "images")));

let activeRun = {
  status: "idle",
  stage: "idle",
  restaurants_processed: 0,
  products_processed: 0,
  errors: [],
};
let running = false;

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function report() {
  const data = buildReport();
  data.current_run = { ...activeRun };
  return data;
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "app", "static", "index.html"));
});

app.get("/api/glovo-export-assets/:slug/*", (req, res) => {
  const target = assetPath(req.params.slug, req.params[0] || "");
  if (!target) {
    return res.status(404).json({ detail: "Image absente de l’export Glovo local" });
  }
  res.sendFile(target);
});

app.get("/api/report", (_req, res) => {
  res.json(report());
});

app.get("/api/price-comparisons", (_req, res) => {
  res.json(report().price_comparisons);
});

app.get("/api/catalog-comparison", (req, res) => {
  const restaurant = String(req.query.restaurant || "").trim();
  const mooup = String(req.query.mooup || "").trim() || null;
  if (!restaurant) throw new HttpError(400, "Nom de restaurant manquant.");
  res.json(buildCatalogComparison(latestData(), restaurant, mooup));
});

app.post("/api/matches/validate", express.json(), (req, res) => {
  const payload = req.body || {};
  const glovoName = payload.glovo_name;
  const mooupName = payload.mooup_name;
  const decision = payload.decision;
  const data = latestData();
  const glovoNames = new Set((data.restaurants.glovo || []).map((item) => item.name));
  const mooupNames = new Set((data.restaurants.mooup || []).map((item) => item.name));

  if (!glovoName || !glovoNames.has(glovoName)) {
    throw new HttpError(404, "Restaurant Glovo inconnu dans la dernière collecte");
  }
  if (decision === "confirm" && (!mooupName || !mooupNames.has(mooupName))) {
    throw new HttpError(400, "Choisissez un restaurant Mooup importé");
  }
  if (
    decision === "confirm" &&
    (data.match_overrides || []).some(
      (item) =>
        item.mooup_name === mooupName && item.glovo_name !== glovoName && item.status === "confirmed"
    )
  ) {
    throw new HttpError(409, "Ce restaurant Mooup est déjà associé manuellement à un autre établissement Glovo");
  }
  if (decision !== "confirm" && decision !== "missing") {
    throw new HttpError(400, "Décision attendue : confirm ou missing");
  }

  saveMatchOverride(
    glovoName,
    decision === "confirm" ? mooupName : null,
    decision === "confirm" ? "confirmed" : "missing",
    new Date().toISOString()
  );
  const latest = report();
  savePriceHistory((latest.run || {}).id, latest.price_comparisons, new Date().toISOString());
  res.json({ status: "saved", glovo_name: glovoName, mooup_name: mooupName, decision });
});

app.post("/api/runs", (_req, res) => {
  if (running || activeRun.status === "running") {
    throw new HttpError(409, "Une analyse est déjà en cours");
  }
  activeRun = {
    status: "running",
    stage: "Démarrage de la collecte",
    started_at: new Date().toISOString(),
    restaurants_processed: 0,
    products_processed: 0,
    errors: [],
  };
  running = true;
  executeRun();
  res.status(202).json({ ...activeRun });
});

app.get("/api/mooup/status", (_req, res) => {
  const data = latestData();
  const available = Boolean(
    data.mooup_imported_at || ((data.restaurants || {})._meta || {}).mooup
  );
  res.json({
    configured: Boolean((process.env.MOOUP_CATALOG_API_KEY || "").trim()),
    base_url: process.env.MOOUP_API_BASE || "https://api.mooup.ma",
    last_catalog_available: available,
    key: "not returned",
  });
});

app.get("/api/glovo-export/status", (_req, res) => {
  const result = loadGlovoExport();
  if (!result) {
    return res.json({ available: false, restaurants: 0, products: 0 });
  }
  const { rows, metadata } = result;
  res.json({
    available: true,
    source: "local export",
    restaurants: rows.length,
    products: rows.reduce((total, shop) => total + (shop.products || []).length, 0),
    restaurants_reported: metadata.restaurants_reported,
    scraped_at: metadata.scraped_at,
    errors: metadata.errors || [],
  });
});

app.post(
  "/api/sync/mooup",
  wrap(async (_req, res) => {
    if (running || activeRun.status === "running") {
      throw new HttpError(409, "Une collecte est déjà en cours");
    }
    if (!(process.env.MOOUP_CATALOG_API_KEY || "").trim()) {
      throw new HttpError(
        400,
        "Configure MOOUP_CATALOG_API_KEY dans le fichier .env local avant de synchroniser."
      );
    }
    running = true;
    try {
      let catalog;
      try {
        catalog = await fetchMooupCatalog();
      } catch (error) {
        if (error instanceof MooupCatalogError) throw new HttpError(401, error.message);
        throw error;
      }
      const prior = report();
      const glovo = (prior.restaurants || {}).glovo || [];
      const errors = (prior.errors || []).filter((error) => error.platform !== "mooup");
      const now = new Date().toISOString();
      const collected = {
        glovo,
        mooup: catalog.shops,
        _meta: { ...((prior.restaurants || {})._meta || {}), mooup: catalog.metadata },
      };
      const matches = restaurantMatches(glovo, catalog.shops);
      const runId = saveRun(now, now, errors.length ? "partial" : "completed", collected, matches, errors);
      const result = report();
      savePriceHistory(runId, result.price_comparisons, now);
      res.json({
        id: runId,
        status: errors.length ? "partial" : "completed",
        restaurants: catalog.shops.length,
        products: catalog.shops.reduce((total, shop) => total + (shop.products || []).length, 0),
        pages: catalog.metadata.pages,
        matches: (result.matches || []).filter((match) =>
          ["confirmed", "review"].includes(match.status)
        ).length,
        price_comparisons: result.price_comparisons.length,
        synced_at: now,
      });
    } finally {
      running = false;
    }
  })
);

app.get("/api/runs/current", (_req, res) => {
  res.json({ ...activeRun });
});

app.post(
  "/api/import/mooup",
  express.text({ type: () => true, limit: "20mb" }),
  (req, res) => {
    try {
      const format = String(req.query.format || "json").toLowerCase();
      let raw = typeof req.body === "string" ? req.body : String(req.body ?? "");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      let listings;

      if (format === "csv") {
        const rows = parseCsv(raw, {
          columns: true,
          skip_empty_lines: true,
          bom: true,
          relax_column_count: true,
        });
        const byName = new Map();
        const pick = (row, keys) => {
          for (const key of keys) {
            if (row[key] !== undefined) return row[key];
          }
          return "";
        };
        const parsePrice = (text) => {
          const cleaned = String(text ?? "")
            .trim()
            .replace(/ /g, "")
            .replace(/\u00a0/g, "")
            .replace(/,/g, ".");
          if (!cleaned) return null;
          const value = Number(cleaned);
          return Number.isNaN(value) ? null : value;
        };

        for (const row of rows) {
          const name = String(pick(row, ["restaurant", "restaurant_name"]) || "").trim();
          if (!name) continue;
          if (!byName.has(name)) {
            byName.set(name, {
              name,
              platform: "mooup",
              url: row.restaurant_url,
              image: row.restaurant_image,
              category: row.restaurant_category,
              address: row.address,
              phone: row.phone,
              delivery_zone: row.delivery_zone,
              products: [],
            });
          }
          const listing = byName.get(name);
          const productName = String(
            pick(row, ["product", "product_name", "name"]) || ""
          ).trim();
          if (!productName) continue;
          const price = parsePrice(row.price);
          const regularPrice = parsePrice(row.regular_price);
          const rawAvailability = row.available;
          const available =
            rawAvailability === undefined || rawAvailability === null
              ? null
              : ["1", "true", "yes", "available", "disponible"].includes(
                  String(rawAvailability).trim().toLowerCase()
                );
          listing.products.push({
            name: productName,
            price,
            sale_price:
              regularPrice !== null && price !== null && price < regularPrice ? price : null,
            regular_price: regularPrice,
            currency: row.currency || null,
            category: row.category,
            description: row.description,
            image: row.image,
            available,
            size: row.size,
            options: row.options || null,
            url: row.product_url || listing.url,
          });
        }
        listings = [...byName.values()];
      } else {
        const payload = JSON.parse(raw);
        listings = Array.isArray(payload) ? payload : payload.restaurants || [];
      }

      if (
        !Array.isArray(listings) ||
        listings.some((item) => !item || typeof item !== "object" || !item.name)
      ) {
        throw new Error("Chaque restaurant doit être un objet avec un champ name.");
      }

      const importedAt = new Date().toISOString();
      for (const item of listings) {
        item.platform = "mooup";
        if (!item.products) item.products = [];
        if (!item.collected_at) item.collected_at = importedAt;
        for (const product of item.products) {
          if (product.currency === undefined) product.currency = null;
          if (!product.collected_at) product.collected_at = importedAt;
        }
      }
      saveCatalog("mooup", importedAt, listings);
      const current = report();
      savePriceHistory((current.run || {}).id, current.price_comparisons, importedAt);
      res.json({
        status: "imported",
        restaurants: listings.length,
        products: listings.reduce((total, row) => total + (row.products || []).length, 0),
        price_comparisons: current.price_comparisons.length,
        imported_at: importedAt,
      });
    } catch (error) {
      res.status(400).json({ detail: `Import Mooup invalide : ${error.message}` });
    }
  }
);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

function updateProgress(stage, restaurants, products, errors) {
  Object.assign(activeRun, {
    stage,
    restaurants_processed: restaurants,
    products_processed: products,
    errors: [...(errors || [])],
  });
  const counts = String(stage).match(/\((\d+)\/(\d+)\)/);
  if (counts) activeRun.total_restaurants = Number.parseInt(counts[2], 10);
}

async function executeRun() {
  try {
    activeRun.stage = "Collecte Glovo : restaurants et menus publics";
    const { collected, errors } = await collectPlatforms(updateProgress);
    activeRun.stage = "Rapprochement des restaurants et produits";
    const prior = report();
    const mooupImported = Boolean(prior.mooup_catalog_available);
    if (mooupImported && !(collected.mooup || []).length) {
      collected.mooup = (prior.restaurants || {}).mooup || [];
      collected._meta = collected._meta || {};
      collected._meta.mooup = {
        ...((prior.restaurants || {})._meta || {}).mooup || { source: prior.mooup_source },
        stale_snapshot: true,
      };
    }
    const matches = restaurantMatches(collected.glovo || [], collected.mooup || []);
    if (!mooupImported && errors.some((error) => error.platform === "mooup")) {
      for (const match of matches) {
        match.status = "unverified";
        match.confidence = 0.0;
        match.reasons = ["Catalogue Mooup indisponible : l’absence ne peut pas être vérifiée."];
      }
    }
    const finished = new Date().toISOString();
    const status = errors.length ? "partial" : "completed";
    const runId = saveRun(activeRun.started_at, finished, status, collected, matches, errors);
    savePriceHistory(runId, report().price_comparisons, finished);
    Object.assign(activeRun, {
      id: runId,
      status,
      stage: "Terminé",
      finished_at: finished,
      restaurants_processed:
        (collected.glovo || []).length + (collected.mooup || []).length,
      products_processed: ["glovo", "mooup"].reduce(
        (total, platform) =>
          total +
          (collected[platform] || []).reduce(
            (sum, row) => sum + (row.products || []).length,
            0
          ),
        0
      ),
      errors,
    });
  } catch (error) {
    Object.assign(activeRun, {
      status: "failed",
      stage: "Échec de la collecte",
      finished_at: new Date().toISOString(),
      errors: [{ platform: "system", message: `${error.name}: ${error.message}` }],
    });
  } finally {
    running = false;
  }
}

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ detail: error.message });
  }
  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ detail: "Fichier trop volumineux (maximum 20 Mo)." });
  }
  console.error(error);
  res.status(500).json({ detail: error.message || "Erreur interne" });
});

export { app };

export function start() {
  initialize();
  seedIfEmpty();
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || "127.0.0.1";
  return app.listen(port, host, () => {
    console.log(`Comparateur Mooup × Glovo (Node.js) → http://${host}:${port}`);
  });
}
