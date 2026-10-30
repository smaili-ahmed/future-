import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalize } from "./matching.js";

export function exportRoot() {
  const configured = process.env.GLOVO_EXPORT_PATH;
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(os.homedir(), "Downloads", "glovo-clone4", "export-data");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function sizeFromName(name) {
  const match = String(name || "").match(
    /\b(?:XS|S|M|L|XL|XXL|small|medium|large|mini|maxi|\d+\s?(?:cl|ml|l|g|kg))\b/i
  );
  return match ? match[0] : null;
}

export function assetUrl(slug, relative) {
  if (!relative) return null;
  const encode = (part) => encodeURIComponent(String(part));
  const safeSlug = encode(slug);
  const safePath = String(relative)
    .replace(/\\/g, "/")
    .split("/")
    .map(encode)
    .join("/");
  return `/api/glovo-export-assets/${safeSlug}/${safePath}`;
}

export function assetPath(slug, asset) {
  if (!slug || path.basename(slug) !== slug || slug === "." || slug === "..") return null;
  const root = exportRoot();
  const folder = path.resolve(root, "restaurants", slug);
  const target = path.resolve(folder, asset);
  if (!isInside(root, folder) || !isInside(folder, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return null;
  }
  return target;
}

function extractProducts(source, entry, root, scrapedAt) {
  const slug = source.slug || entry.slug || "";
  const products = [];
  const byKey = new Map();

  for (const category of source.categories || []) {
    const categoryName = category.name;
    for (const item of category.products || []) {
      const name = item.name;
      if (!name) continue;
      const price = numberOrNull(item.price);
      const regular = numberOrNull(item.oldPrice);
      const key = `${normalize(name)}|${price}|${normalize(item.description)}`;
      const product = {
        id: item.id,
        name,
        description: item.description,
        category: categoryName,
        price,
        sale_price: regular !== null && price !== null && price < regular ? price : null,
        regular_price: regular,
        currency: price !== null ? "MAD" : null,
        available: item.available,
        image: assetUrl(slug, item.image),
        size: sizeFromName(name),
        options: item.optionGroups || [],
        url: source.glovoUrl || entry.url,
        collected_at: item.scrapedAt || scrapedAt,
        promotion_percent: item.discount,
      };
      if (byKey.has(key)) {
        const prior = products[byKey.get(key)];
        if (["promotions", "top sellers"].includes(normalize(prior.category)) && categoryName) {
          prior.category = categoryName;
        }
        if (product.regular_price !== null) {
          prior.regular_price = product.regular_price;
          prior.sale_price = product.sale_price;
        }
        prior.options = (prior.options && prior.options.length ? prior.options : product.options) || [];
        continue;
      }
      byKey.set(key, products.length);
      products.push(product);
    }
  }
  return products;
}

export function loadGlovoExport() {
  const root = exportRoot();
  const indexPath = path.join(root, "restaurants-index.json");
  if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) return null;

  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const rows = [];
  const errors = [];
  const scrapedAt =
    index.scrapedAt || index.exportedAt || new Date().toISOString();

  for (const entry of index.restaurants || []) {
    const relative = String(entry.json || "");
    const filePath = path.resolve(root, relative);
    if (!isInside(root, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      errors.push({
        platform: "glovo-export",
        message: `Fiche JSON manquante/invalide pour ${entry.name || "restaurant inconnu"}`,
      });
      continue;
    }
    try {
      const source = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const products = extractProducts(source, entry, root, scrapedAt);
      const slug = source.slug || entry.slug || path.basename(path.dirname(filePath));
      const missing = Boolean(source.dataMissing);
      if (missing) {
        errors.push({
          platform: "glovo-export",
          message: `L’export signale des données partielles pour ${source.name || entry.name}`,
        });
      }
      rows.push({
        id: source.glovoStoreId || slug,
        slug,
        name: source.name || entry.name,
        url: source.glovoUrl || entry.url,
        image: assetUrl(slug, source.logoUrl || source.image),
        category: (source.cuisines || []).join(", ") || "Food",
        address: source.address,
        rating: source.rating,
        reviews: source.reviews,
        promotion: source.promotion,
        available: source.open,
        data_missing: source.dataMissing,
        products,
        product_count_reported: (source.categories || []).reduce(
          (total, category) => total + (category.products || []).length,
          0
        ),
        menu_collect_status: missing ? "partial" : "collected",
        collected_at: source.scrapedAt || scrapedAt,
        platform: "glovo",
        source: "export local glovo-clone4",
        raw: source,
      });
    } catch (error) {
      errors.push({
        platform: "glovo-export",
        message: `Erreur de lecture pour ${entry.name || path.basename(relative)} : ${error.name}: ${error.message}`,
      });
    }
  }

  const metadata = {
    source: "local export",
    index: path.basename(indexPath),
    scraped_at: scrapedAt,
    restaurants_reported: index.count,
    restaurants_loaded: rows.length,
    incomplete: rows.length !== index.count || errors.length > 0,
    errors,
  };
  return { rows, metadata };
}
