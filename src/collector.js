import { loadGlovoExport } from "./glovo_export.js";
import { fetchMooupCatalog, MooupCatalogError } from "./mooup_api.js";

const GLOVO_URL = "https://glovoapp.com/en/ma/oujda/categories/food_1";
const MOOUP_URL = "https://app.mooup.ma/";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; CatalogResearch/1.0; +public-page analysis)",
};

function stripTags(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStoreCards(html, baseUrl) {
  const stores = [];
  const seen = new Set();
  const linkPattern = /<a\b[^>]*href=["']([^"']*\/stores\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = new URL(match[1], baseUrl).toString();
    const altMatch = match[2].match(/<img\b[^>]*alt=["']([^"']+)["']/i);
    const name = altMatch ? altMatch[1].trim() : stripTags(match[2]);
    if (!name || name.length <= 2) continue;
    const key = ` ${name.toLowerCase().replace(/\W+/g, "")} `;
    if (seen.has(key)) continue;
    const imgMatch = match[2].match(/<img\b[^>]*src=["']([^"']+)["']/i);
    stores.push({
      name,
      url: href,
      platform: "glovo",
      image: imgMatch ? new URL(imgMatch[1], baseUrl).toString() : null,
      products: [],
      category: "Food",
      collected_at: new Date().toISOString(),
      menu_collect_status: "not_collected",
    });
    seen.add(key);
  }
  return stores;
}

export async function collectPlatforms(onProgress) {
  const timeout = Number(process.env.REQUEST_TIMEOUT || 20);
  const errors = [];
  const collected = { glovo: [], mooup: [], _meta: {} };
  const collectedAt = new Date().toISOString();

  let glovoExport = null;
  try {
    glovoExport = loadGlovoExport();
  } catch (error) {
    errors.push({
      platform: "glovo-export",
      message: `Export Glovo illisible : ${error.name}: ${error.message}`,
    });
  }

  if (glovoExport) {
    const metadata = { ...glovoExport.metadata };
    const metadataErrors = metadata.errors || [];
    errors.push(...metadataErrors);
    delete metadata.errors;
    collected.glovo = glovoExport.rows;
    collected._meta.glovo = metadata;
    if (onProgress) {
      onProgress(
        "Glovo : import de l’export local",
        collected.glovo.length,
        collected.glovo.reduce((total, item) => total + (item.products || []).length, 0),
        errors
      );
    }
  } else {
    try {
      const response = await fetch(GLOVO_URL, {
        headers: HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      collected.glovo = extractStoreCards(html, response.url || GLOVO_URL);
      if (onProgress) {
        onProgress("Glovo : fiches restaurants", collected.glovo.length, 0, errors);
      }
    } catch (error) {
      errors.push({
        platform: "glovo",
        message: `Collecte inaccessible : ${error.name}: ${error.message}`,
      });
    }
  }

  if ((process.env.MOOUP_CATALOG_API_KEY || "").trim()) {
    try {
      const { shops, metadata } = await fetchMooupCatalog();
      collected.mooup = shops;
      collected._meta.mooup = metadata;
    } catch (error) {
      errors.push({
        platform: "mooup",
        message:
          error instanceof MooupCatalogError
            ? error.message
            : `Erreur API Mooup : ${error.name}: ${error.message}`,
      });
    }
  } else {
    try {
      const response = await fetch(MOOUP_URL, {
        headers: HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      collected.mooup = [];
      errors.push({
        platform: "mooup",
        message:
          "Page publique accessible, mais aucun catalogue restaurant exploitable sans navigation/adresse ou accès authentifié.",
      });
    } catch (error) {
      errors.push({
        platform: "mooup",
        message: `Collecte inaccessible : ${error.name}: ${error.message}`,
      });
    }
  }

  if (onProgress) {
    onProgress(
      "Collecte terminée",
      collected.glovo.length + collected.mooup.length,
      [...collected.glovo, ...collected.mooup].reduce(
        (total, row) => total + (row.products || []).length,
        0
      ),
      errors
    );
  }
  return { collected, errors };
}
