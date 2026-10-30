import { setTimeout as sleep } from "node:timers/promises";

export class MooupCatalogError extends Error {}

function toFloat(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeShop(shop) {
  const location = shop.location || {};
  const category = shop.category || {};
  const products = (shop.products || []).map((product) => {
    const productCategory = product.category || {};
    let current = product.discounted_price;
    if (current === null || current === undefined) current = product.price;
    const images = product.images || [];
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      category: productCategory.name || productCategory.slug,
      price: toFloat(current),
      sale_price: toFloat(product.discounted_price),
      regular_price: toFloat(product.original_price),
      currency: product.currency,
      available: product.available,
      availability_status: product.availability_status,
      stock_status: product.stock_status,
      image: images.length ? images[0] : null,
      images,
      size: null,
      options: product.variants || [],
      variants: product.variants || [],
      url: product.url,
      collected_at: product.updated_at || product.created_at,
      external_id: product.id,
      discount: product.discount,
    };
  });

  return {
    id: shop.id,
    external_id: shop.id,
    name: shop.name,
    slug: shop.slug,
    url: shop.url,
    image: shop.logo,
    background_image: shop.background_img,
    platform: "mooup",
    category: category.name || category.slug,
    description: shop.description,
    address: location.address,
    latitude: toFloat(location.latitude),
    longitude: toFloat(location.longitude),
    availability: shop.availability,
    available: (shop.availability || {}).open,
    status: shop.status,
    products,
    product_count: products.length,
    collected_at: shop.updated_at,
    source: "MOOUP catalog:read",
    raw: shop,
  };
}

export async function fetchMooupCatalog() {
  const key = (process.env.MOOUP_CATALOG_API_KEY || "").trim();
  if (!key) {
    throw new MooupCatalogError("MOOUP_CATALOG_API_KEY n’est pas configurée dans l’environnement local.");
  }
  const base = (process.env.MOOUP_API_BASE || "https://api.mooup.ma").replace(/\/+$/, "");
  const timeout = Number(process.env.REQUEST_TIMEOUT || 20);
  let pageSize = Math.min(100, Math.max(1, Number.parseInt(process.env.MOOUP_API_PAGE_SIZE || "15", 10)));
  const delay = Number(process.env.MOOUP_API_DELAY_SECONDS || 1);
  const shops = [];
  let pageNumber = 1;
  let lastPage = null;
  let route = "/api/integrations/catalog/all";

  const request = async (page, size) => {
    const url = new URL(route.replace(/^\/+/, ""), `${base}/`);
    url.searchParams.set("per_page", String(size));
    url.searchParams.set("page", String(page));
    url.searchParams.set("status", "approved");
    url.searchParams.set("lang", "fr");
    return fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout * 1000),
    });
  };

  while (pageNumber <= (lastPage || 1)) {
    let response = await request(pageNumber, pageSize);

    if (response.status >= 500 && pageNumber === 1 && pageSize > 15) {
      pageSize = 15;
      response = await request(1, pageSize);
    }
    if (response.status === 404 && route === "/api/integrations/catalog/all" && pageNumber === 1) {
      route = "/api/v1/integrations/catalog/all";
      response = await request(1, pageSize);
    }
    if (response.status === 429) {
      const retryHeader = response.headers.get("retry-after") || "5";
      const parsed = Number.parseInt(retryHeader, 10);
      const wait = Number.isNaN(parsed) ? 5 : Math.min(60, Math.max(1, parsed));
      await sleep(wait * 1000);
      response = await request(pageNumber, pageSize);
    }
    if (response.status === 401 || response.status === 403) {
      let detail = null;
      try {
        const body = await response.json();
        detail = body.message || body.error;
      } catch {
        detail = null;
      }
      throw new MooupCatalogError(
        `API Mooup HTTP ${response.status}: ${
          detail || "clé invalide, révoquée ou sans autorisation catalog:read"
        }`
      );
    }
    if (response.status >= 400) {
      throw new MooupCatalogError(`API Mooup HTTP ${response.status} (page ${pageNumber})`);
    }

    const payload = await response.json();
    if (payload.success === false) {
      throw new MooupCatalogError(`API Mooup : ${payload.error || "requête refusée"}`);
    }
    for (const shop of payload.data || []) shops.push(normalizeShop(shop));
    const meta = payload.meta || {};
    lastPage = Number.parseInt(meta.last_page || pageNumber, 10) || pageNumber;
    if (pageNumber >= lastPage) break;
    pageNumber += 1;
    await sleep(delay * 1000);
  }

  return {
    shops,
    metadata: {
      pages: pageNumber,
      shop_count: shops.length,
      per_page: pageSize,
      source: base + route,
      status_filter: "approved",
      synced_at: new Date().toISOString(),
    },
  };
}
