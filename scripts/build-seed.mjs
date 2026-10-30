import fs from "node:fs";
import path from "node:path";

import { loadGlovoExport } from "../src/glovo_export.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const seedPath = path.join(ROOT, "data", "seed.json");
const PLACEHOLDER = "/images/placeholder.svg";

function staticImage(url) {
  if (!url) return null;
  return String(url).replace(/^\/api\/glovo-export-assets\//, "/images/glovo/");
}

const existing = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const loaded = loadGlovoExport();
if (!loaded || !loaded.rows) {
  console.error("Export Glovo introuvable: définir GLOVO_EXPORT_PATH.");
  process.exit(1);
}

const glovo = loaded.rows.map((restaurant) => {
  const image = staticImage(restaurant.image) || PLACEHOLDER;
  const products = (restaurant.products || []).map((product) => ({
    ...product,
    image: staticImage(product.image) || image,
  }));
  const raw = restaurant.raw || {};
  return {
    ...restaurant,
    image,
    products,
    raw: {
      rating: raw.rating,
      reviews: raw.reviews,
      cuisines: raw.cuisines,
      open: raw.open,
      promotion: raw.promotion,
    },
  };
});

const mooup = (existing.restaurants?.mooup || []).map((restaurant) => {
  const image = restaurant.image || restaurant.background_image || PLACEHOLDER;
  const products = (restaurant.products || []).map((product) => ({
    ...product,
    image: product.image || image,
  }));
  return { ...restaurant, image, products };
});

const snapshot = {
  ...existing,
  generated_at: new Date().toISOString(),
  restaurants: { glovo, mooup },
};

fs.writeFileSync(seedPath, JSON.stringify(snapshot));

const glovoProducts = glovo.flatMap((restaurant) => restaurant.products);
const mooupProducts = mooup.flatMap((restaurant) => restaurant.products);
const missing = [...glovo, ...mooup, ...glovoProducts, ...mooupProducts].filter(
  (item) => !item.image
).length;

console.log(
  `Seed: ${glovo.length} Glovo + ${mooup.length} Mooup restaurants | ` +
    `${glovoProducts.length} + ${mooupProducts.length} produits | sans image ${missing} | ` +
    `${(fs.statSync(seedPath).size / 1024 / 1024).toFixed(1)} Mo`,
);
