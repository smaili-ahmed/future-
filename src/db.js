import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { matchProducts, normalize, restaurantMatches } from "./matching.js";
import { MANUALLY_VALIDATED_MISSING, WATCHLIST_NAMES } from "./seed_data.js";

const DB_PATH =
  process.env.DATABASE_PATH ||
  (process.env.VERCEL ? "/tmp/mooup_glovo.sqlite3" : "./data/mooup_glovo.sqlite3");
const SEED_PATH =
  process.env.SEED_PATH ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "seed.json");
const SEED_MARKER =
  process.env.SEED_MARKER ||
  path.join(path.dirname(path.resolve(DB_PATH)), "mooup_glovo.seed.sha256");

let database = null;

function isLfsPointer(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(64);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, read).toString("utf8").startsWith("version https://git-lfs");
  } catch {
    return false;
  }
}

function moveLfsPointer(filePath) {
  let target = `${filePath}.lfs-pointer`;
  if (fs.existsSync(target)) target = `${filePath}.lfs-pointer-${Date.now()}`;
  fs.renameSync(filePath, target);
  console.warn(
    `[db] ${filePath} était un pointeur Git LFS (données réelles non téléchargées) ; déplacé vers ${target}. Une base locale vide est créée.`
  );
}

function connect() {
  if (!database) {
    const absolute = path.resolve(DB_PATH);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (fs.existsSync(absolute) && isLfsPointer(absolute)) moveLfsPointer(absolute);
    database = new DatabaseSync(DB_PATH);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }
  return database;
}

function dbv(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function plain(row) {
  return row === null || row === undefined ? null : { ...row };
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

export function initialize() {
  const db = connect();
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_runs(id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, errors TEXT NOT NULL DEFAULT '[]', results TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS restaurants(id INTEGER PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL, url TEXT, category TEXT, address TEXT, collected_at TEXT NOT NULL, raw_json TEXT NOT NULL, UNIQUE(platform, external_id, name));
    CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, platform TEXT NOT NULL, restaurant_name TEXT NOT NULL, name TEXT NOT NULL, category TEXT, price REAL, currency TEXT, available INTEGER, url TEXT, collected_at TEXT NOT NULL, raw_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS restaurant_matches(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, glovo_name TEXT NOT NULL, mooup_name TEXT, confidence REAL NOT NULL, status TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', FOREIGN KEY(run_id) REFERENCES collection_runs(id));
    CREATE TABLE IF NOT EXISTS price_history(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, product_name TEXT NOT NULL, restaurant_name TEXT NOT NULL, mooup_price REAL, glovo_price REAL, currency TEXT, recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_errors(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, platform TEXT, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_catalogs(platform TEXT PRIMARY KEY, imported_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog_import_history(id INTEGER PRIMARY KEY, platform TEXT NOT NULL, imported_at TEXT NOT NULL, restaurant_count INTEGER NOT NULL, product_count INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS restaurant_match_overrides(glovo_name TEXT PRIMARY KEY, mooup_name TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platforms(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_url TEXT);
    CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, platform_id INTEGER NOT NULL, name TEXT NOT NULL, parent_id INTEGER, external_id TEXT, UNIQUE(platform_id,name), FOREIGN KEY(platform_id) REFERENCES platforms(id));
    CREATE TABLE IF NOT EXISTS restaurant_platform_listings(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, platform_id INTEGER NOT NULL, external_id TEXT, name TEXT NOT NULL, url TEXT, image TEXT, address TEXT, category TEXT, collected_at TEXT NOT NULL, raw_json TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES collection_runs(id), FOREIGN KEY(platform_id) REFERENCES platforms(id));
    CREATE TABLE IF NOT EXISTS product_platform_listings(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, platform_id INTEGER NOT NULL, restaurant_name TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL, description TEXT, category TEXT, image TEXT, price REAL, sale_price REAL, regular_price REAL, currency TEXT, available INTEGER, url TEXT, collected_at TEXT NOT NULL, raw_json TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES collection_runs(id), FOREIGN KEY(platform_id) REFERENCES platforms(id));
    CREATE TABLE IF NOT EXISTS product_matches(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, restaurant_name TEXT NOT NULL, glovo_product TEXT NOT NULL, mooup_product TEXT, confidence REAL NOT NULL, status TEXT NOT NULL, reasons TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES collection_runs(id));
    CREATE TABLE IF NOT EXISTS restaurant_watchlist(position INTEGER PRIMARY KEY, input_name TEXT NOT NULL, normalized_name TEXT NOT NULL, seeded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_missing_restaurants(name TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, verified_at TEXT NOT NULL, last_checked_at TEXT, matched_mooup_name TEXT, glovo_url TEXT, image TEXT, category TEXT);
    CREATE TABLE IF NOT EXISTS user_missing_history(id INTEGER PRIMARY KEY, restaurant_name TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL, evidence TEXT NOT NULL);
  `);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_products_snapshot ON products(platform,restaurant_name,name,price,currency,collected_at)"
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_product_platform_snapshot ON product_platform_listings(run_id,platform_id,restaurant_name,name,price,currency)"
  );
  const platformInsert = db.prepare("INSERT OR IGNORE INTO platforms(name,base_url) VALUES(?,?)");
  platformInsert.run("glovo", "https://glovoapp.com/en/ma/oujda/categories/food_1");
  platformInsert.run("mooup", "https://app.mooup.ma/");

  const matchColumns = new Set(
    db.prepare("PRAGMA table_info(restaurant_matches)").all().map((row) => row.name)
  );
  if (!matchColumns.has("reasons")) {
    db.exec("ALTER TABLE restaurant_matches ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]'");
  }

  const seededAt = new Date().toISOString();
  const watchInsert = db.prepare(
    "INSERT OR IGNORE INTO restaurant_watchlist(position,input_name,normalized_name,seeded_at) VALUES(?,?,?,?)"
  );
  WATCHLIST_NAMES.forEach((name, index) => {
    watchInsert.run(dbv(index + 1), name, normalize(name), seededAt);
  });

  const missingInsert = db.prepare(
    "INSERT OR IGNORE INTO user_missing_restaurants(name,source,status,verified_at) VALUES(?,?,?,?)"
  );
  const historyCheck = db.prepare("SELECT 1 FROM user_missing_history WHERE restaurant_name=?");
  const historyInsert = db.prepare(
    "INSERT INTO user_missing_history(restaurant_name,status,checked_at,evidence) VALUES(?,?,?,?)"
  );
  for (const name of MANUALLY_VALIDATED_MISSING) {
    missingInsert.run(name, "validation manuelle de l’utilisateur", "À ajouter sur Mooup", seededAt);
    if (historyCheck.get(name) === undefined) {
      historyInsert.run(
        name,
        "À ajouter sur Mooup",
        seededAt,
        "Restaurant déclaré absent de Mooup par l’utilisateur."
      );
    }
  }
}

export function seedIfEmpty() {
  const db = connect();
  if (!fs.existsSync(SEED_PATH)) return false;

  const row = db.prepare("SELECT COUNT(*) AS n FROM collection_runs").get();
  const hasRuns = Number(row.n) > 0;
  const seedHash = crypto.createHash("sha256").update(fs.readFileSync(SEED_PATH)).digest("hex");

  if (process.env.VERCEL) {
    let marker = null;
    try {
      marker = fs.readFileSync(SEED_MARKER, "utf8").trim();
    } catch {
      marker = null;
    }
    if (marker === seedHash && hasRuns) return false;
  } else if (hasRuns) {
    return false;
  }

  const snapshot = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  const restaurants = snapshot.restaurants || { glovo: [], mooup: [] };
  const errors = snapshot.errors || [];
  const run = snapshot.run || {};
  const started = run.started_at || new Date().toISOString();
  const finished = run.finished_at || started;
  const matches = restaurantMatches(restaurants.glovo || [], restaurants.mooup || []);

  db.exec("BEGIN");
  try {
    const insertRun = db.prepare(
      "INSERT INTO collection_runs(started_at,finished_at,status,errors,results) VALUES(?,?,?,?,?)"
    );
    const result = insertRun.run(
      dbv(started),
      dbv(finished),
      dbv(run.status || "completed"),
      JSON.stringify(errors),
      JSON.stringify(restaurants)
    );
    const runId = Number(result.lastInsertRowid);
    const insertMatch = db.prepare(
      "INSERT INTO restaurant_matches(run_id,glovo_name,mooup_name,confidence,status,reasons) VALUES(?,?,?,?,?,?)"
    );
    for (const match of matches) {
      insertMatch.run(
        dbv(runId),
        dbv(match.name),
        dbv((match.match || {}).name),
        dbv(match.confidence),
        dbv(match.status),
        JSON.stringify(match.reasons || [])
      );
    }
    db.exec("COMMIT");
    if (process.env.VERCEL) {
      try {
        fs.writeFileSync(SEED_MARKER, seedHash);
      } catch (error) {
        console.warn(`[db] Impossible d’écrire le marqueur de seed : ${error.message}`);
      }
    }
    console.log(`[db] Instantané read-only chargé depuis ${SEED_PATH}`);
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveRun(started, finished, status, collected, matches, errors) {
  const db = connect();
  db.exec("BEGIN");
  try {
    return saveRunBody(db, started, finished, status, collected, matches, errors);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function saveRunBody(db, started, finished, status, collected, matches, errors) {
  const runInsert = db.prepare(
    "INSERT INTO collection_runs(started_at,finished_at,status,errors,results) VALUES(?,?,?,?,?)"
  );
  const runResult = runInsert.run(started, finished, status, JSON.stringify(errors), JSON.stringify(collected));
  const runId = Number(runResult.lastInsertRowid);

  const restaurantInsert = db.prepare(
    "INSERT OR IGNORE INTO restaurants(platform,external_id,name,url,category,address,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?)"
  );
  const listingInsert = db.prepare(
    "INSERT INTO restaurant_platform_listings(run_id,platform_id,external_id,name,url,image,address,category,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)"
  );
  const categoryInsert = db.prepare("INSERT OR IGNORE INTO categories(platform_id,name) VALUES(?,?)");
  const productListingInsert = db.prepare(
    "INSERT OR IGNORE INTO product_platform_listings(run_id,platform_id,restaurant_name,name,description,category,image,price,sale_price,regular_price,currency,available,url,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const productInsert = db.prepare(
    "INSERT OR IGNORE INTO products(platform,restaurant_name,name,category,price,currency,available,url,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)"
  );
  const platformQuery = db.prepare("SELECT id FROM platforms WHERE name=?");

  for (const [platform, listings] of Object.entries(collected)) {
    if (platform === "_meta") continue;
    const platformRow = platformQuery.get(platform);
    const platformId = platformRow ? platformRow.id : null;
    for (const item of listings || []) {
      const externalId = item.id !== undefined ? item.id : item.url;
      restaurantInsert.run(
        dbv(platform),
        dbv(externalId),
        dbv(item.name),
        dbv(item.url),
        dbv(item.category),
        dbv(item.address),
        dbv(finished),
        JSON.stringify(item)
      );
      listingInsert.run(
        dbv(runId),
        dbv(platformId),
        dbv(externalId),
        dbv(item.name),
        dbv(item.url),
        dbv(item.image),
        dbv(item.address),
        dbv(item.category),
        dbv(item.collected_at || finished),
        JSON.stringify(item)
      );
      if (item.category) categoryInsert.run(dbv(platformId), dbv(item.category));
      for (const product of item.products || []) {
        const productTime = product.collected_at || item.collected_at || finished;
        productListingInsert.run(
          dbv(runId),
          dbv(platformId),
          dbv(item.name),
          dbv(product.name),
          dbv(product.description),
          dbv(product.category),
          dbv(product.image),
          dbv(product.price),
          dbv(product.sale_price),
          dbv(product.regular_price),
          dbv(product.currency),
          dbv(product.available),
          dbv(product.url),
          dbv(productTime),
          JSON.stringify(product)
        );
        productInsert.run(
          dbv(platform),
          dbv(item.name),
          dbv(product.name),
          dbv(product.category),
          dbv(product.price),
          dbv(product.currency),
          dbv(product.available),
          dbv(product.url),
          dbv(productTime),
          JSON.stringify(product)
        );
        if (product.category) categoryInsert.run(dbv(platformId), dbv(product.category));
      }
    }
  }

  const matchInsert = db.prepare(
    "INSERT INTO restaurant_matches(run_id,glovo_name,mooup_name,confidence,status,reasons) VALUES(?,?,?,?,?,?)"
  );
  const productMatchInsert = db.prepare(
    "INSERT INTO product_matches(run_id,restaurant_name,glovo_product,mooup_product,confidence,status,reasons) VALUES(?,?,?,?,?,?,?)"
  );
  for (const match of matches) {
    matchInsert.run(
      dbv(runId),
      dbv(match.name),
      dbv((match.match || {}).name),
      dbv(match.confidence),
      dbv(match.status),
      JSON.stringify(match.reasons || [])
    );
    if (match.match) {
      for (const productMatch of matchProducts(match.products || [], match.match.products || [])) {
        productMatchInsert.run(
          dbv(runId),
          dbv(match.name),
          dbv((productMatch.glovo || {}).name),
          dbv((productMatch.mooup || {}).name),
          dbv(productMatch.confidence),
          dbv(productMatch.status),
          JSON.stringify(productMatch.reasons || [])
        );
      }
    }
  }

  const errorInsert = db.prepare(
    "INSERT INTO collection_errors(run_id,platform,message) VALUES(?,?,?)"
  );
  for (const error of errors) {
    errorInsert.run(dbv(runId), dbv(error.platform), dbv(error.message));
  }
  db.exec("COMMIT");
  return runId;
}

export function latestData() {
  const db = connect();
  const runRow = db.prepare("SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1").get();
  const run = plain(runRow);
  const history = plainRows(
    db.prepare("SELECT id,started_at,finished_at,status,errors FROM collection_runs ORDER BY id DESC LIMIT 50").all()
  );
  const matches = run
    ? plainRows(db.prepare("SELECT * FROM restaurant_matches WHERE run_id=?").all(run.id))
    : [];
  for (const match of matches) {
    try {
      match.reasons = JSON.parse(match.reasons || "[]");
    } catch {
      match.reasons = [];
    }
  }

  const data = {
    run,
    restaurants: run ? JSON.parse(run.results) : { glovo: [], mooup: [] },
    matches,
    history,
    errors: run ? JSON.parse(run.errors) : [],
  };
  data.price_history = plainRows(
    db.prepare("SELECT * FROM price_history ORDER BY recorded_at DESC LIMIT 500").all()
  );
  data.catalog_history = plainRows(
    db
      .prepare(
        "SELECT id,platform,imported_at,restaurant_count,product_count FROM catalog_import_history ORDER BY id DESC LIMIT 50"
      )
      .all()
  );
  const catalog = db.prepare("SELECT imported_at,payload FROM platform_catalogs WHERE platform='mooup'").get();
  if (catalog) {
    data.restaurants.mooup = JSON.parse(catalog.payload);
    data.mooup_imported_at = catalog.imported_at;
  }
  data.match_overrides = plainRows(db.prepare("SELECT * FROM restaurant_match_overrides").all());
  return data;
}

export function saveCatalog(platform, importedAt, listings) {
  const db = connect();
  db.exec("BEGIN");
  try {
    saveCatalogBody(db, platform, importedAt, listings);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function saveCatalogBody(db, platform, importedAt, listings) {
  const platformRow = db.prepare("SELECT id FROM platforms WHERE name=?").get(platform);
  const platformId = platformRow ? platformRow.id : null;
  db.prepare(
    "INSERT INTO catalog_import_history(platform,imported_at,restaurant_count,product_count,payload) VALUES(?,?,?,?,?)"
  ).run(
    platform,
    importedAt,
    listings.length,
    listings.reduce((total, row) => total + (row.products || []).length, 0),
    JSON.stringify(listings)
  );
  db.prepare(
    "INSERT INTO platform_catalogs(platform,imported_at,payload) VALUES(?,?,?) ON CONFLICT(platform) DO UPDATE SET imported_at=excluded.imported_at,payload=excluded.payload"
  ).run(platform, importedAt, JSON.stringify(listings));

  const categoryInsert = db.prepare("INSERT OR IGNORE INTO categories(platform_id,name) VALUES(?,?)");
  const restaurantInsert = db.prepare(
    "INSERT OR IGNORE INTO restaurants(platform,external_id,name,url,category,address,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?)"
  );
  const productInsert = db.prepare(
    "INSERT OR IGNORE INTO products(platform,restaurant_name,name,category,price,currency,available,url,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)"
  );
  for (const listing of listings) {
    if (listing.category) categoryInsert.run(dbv(platformId), dbv(listing.category));
    restaurantInsert.run(
      platform,
      dbv(listing.id !== undefined ? listing.id : listing.url),
      dbv(listing.name),
      dbv(listing.url),
      dbv(listing.category),
      dbv(listing.address),
      dbv(importedAt),
      JSON.stringify(listing)
    );
    for (const product of listing.products || []) {
      productInsert.run(
        platform,
        dbv(listing.name),
        dbv(product.name),
        dbv(product.category),
        dbv(product.price),
        dbv(product.currency),
        dbv(product.available),
        dbv(product.url || listing.url),
        dbv(product.collected_at || importedAt),
        JSON.stringify(product)
      );
      if (product.category) categoryInsert.run(dbv(platformId), dbv(product.category));
    }
  }
}

export function savePriceHistory(runId, rows, recordedAt) {
  if (!runId) return;
  const db = connect();
  db.exec("BEGIN");
  try {
    const insert = db.prepare(
      "INSERT INTO price_history(run_id,product_name,restaurant_name,mooup_price,glovo_price,currency,recorded_at) VALUES(?,?,?,?,?,?,?)"
    );
    for (const row of rows) {
      insert.run(
        dbv(runId),
        dbv(row.product),
        dbv(row.restaurant),
        dbv(row.mooup_price),
        dbv(row.glovo_price),
        dbv(row.currency || "MAD"),
        dbv(recordedAt)
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveMatchOverride(glovoName, mooupName, status, updatedAt) {
  const db = connect();
  db.prepare(
    "INSERT INTO restaurant_match_overrides(glovo_name,mooup_name,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(glovo_name) DO UPDATE SET mooup_name=excluded.mooup_name,status=excluded.status,updated_at=excluded.updated_at"
  ).run(dbv(glovoName), dbv(mooupName), dbv(status), dbv(updatedAt));
}

export function seedObservations() {
  const db = connect();
  return {
    watchlist: plainRows(db.prepare("SELECT * FROM restaurant_watchlist ORDER BY position").all()),
    manual: plainRows(db.prepare("SELECT * FROM user_missing_restaurants ORDER BY name").all()),
    history: plainRows(db.prepare("SELECT * FROM user_missing_history ORDER BY id DESC LIMIT 100").all()),
  };
}

export function updateUserMissing(name, status, checkedAt, matchedName = null, url = null, image = null, category = null) {
  const db = connect();
  const previous = db.prepare(
    "SELECT status,matched_mooup_name FROM user_missing_restaurants WHERE name=?"
  ).get(name);
  if (!previous) return;
  const changed = previous.status !== status || previous.matched_mooup_name !== matchedName;
  db.prepare(
    "UPDATE user_missing_restaurants SET status=?,last_checked_at=?,matched_mooup_name=?,glovo_url=COALESCE(?,glovo_url),image=COALESCE(?,image),category=COALESCE(?,category) WHERE name=?"
  ).run(dbv(status), dbv(checkedAt), dbv(matchedName), dbv(url), dbv(image), dbv(category), dbv(name));
  if (changed) {
    const evidence = JSON.stringify({ matched_mooup_name: matchedName, glovo_url: url });
    db.prepare(
      "INSERT INTO user_missing_history(restaurant_name,status,checked_at,evidence) VALUES(?,?,?,?)"
    ).run(dbv(name), dbv(status), dbv(checkedAt), evidence);
  }
}
