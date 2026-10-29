import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

DB_PATH = os.getenv("DATABASE_PATH", "./data/mooup_glovo.sqlite3")


@contextmanager
def connect():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize():
    with connect() as db:
        db.executescript('''
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
        ''')
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_products_snapshot ON products(platform,restaurant_name,name,price,currency,collected_at)")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_product_platform_snapshot ON product_platform_listings(run_id,platform_id,restaurant_name,name,price,currency)")
        db.executemany("INSERT OR IGNORE INTO platforms(name,base_url) VALUES(?,?)",
                       [("glovo", "https://glovoapp.com/en/ma/oujda/categories/food_1"), ("mooup", "https://app.mooup.ma/")])
        match_columns = {row[1] for row in db.execute("PRAGMA table_info(restaurant_matches)")}
        if "reasons" not in match_columns:
            db.execute("ALTER TABLE restaurant_matches ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]'")
        from .matching import normalize
        from .seed_data import MANUALLY_VALIDATED_MISSING, WATCHLIST_NAMES
        seeded_at = datetime.now(timezone.utc).isoformat()
        for position, name in enumerate(WATCHLIST_NAMES, start=1):
            db.execute("INSERT OR IGNORE INTO restaurant_watchlist(position,input_name,normalized_name,seeded_at) VALUES(?,?,?,?)",
                       (position, name, normalize(name), seeded_at))
        for name in MANUALLY_VALIDATED_MISSING:
            db.execute("INSERT OR IGNORE INTO user_missing_restaurants(name,source,status,verified_at) VALUES(?,?,?,?)",
                       (name, "validation manuelle de l’utilisateur", "À ajouter sur Mooup", seeded_at))
            if db.execute("SELECT 1 FROM user_missing_history WHERE restaurant_name=?", (name,)).fetchone() is None:
                db.execute("INSERT INTO user_missing_history(restaurant_name,status,checked_at,evidence) VALUES(?,?,?,?)",
                           (name, "À ajouter sur Mooup", seeded_at, "Restaurant déclaré absent de Mooup par l’utilisateur."))


def save_run(started, finished, status, collected, matches, errors):
    with connect() as db:
        cursor = db.execute("INSERT INTO collection_runs(started_at,finished_at,status,errors,results) VALUES(?,?,?,?,?)",
                            (started, finished, status, json.dumps(errors), json.dumps(collected)))
        run_id = cursor.lastrowid
        for platform, listings in collected.items():
            if platform == "_meta":
                continue
            platform_id = db.execute("SELECT id FROM platforms WHERE name=?", (platform,)).fetchone()[0]
            for item in listings:
                db.execute("INSERT OR IGNORE INTO restaurants(platform,external_id,name,url,category,address,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?)",
                           (platform, item.get("id", item.get("url")), item["name"], item.get("url"), item.get("category"), item.get("address"), finished, json.dumps(item)))
                db.execute("INSERT INTO restaurant_platform_listings(run_id,platform_id,external_id,name,url,image,address,category,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (run_id, platform_id, item.get("id", item.get("url")), item["name"], item.get("url"), item.get("image"), item.get("address"), item.get("category"), item.get("collected_at") or finished, json.dumps(item, ensure_ascii=False)))
                if item.get("category"):
                    db.execute("INSERT OR IGNORE INTO categories(platform_id,name) VALUES(?,?)", (platform_id, item["category"]))
                for product in item.get("products", []):
                    product_time = product.get("collected_at") or item.get("collected_at") or finished
                    db.execute("INSERT OR IGNORE INTO product_platform_listings(run_id,platform_id,restaurant_name,name,description,category,image,price,sale_price,regular_price,currency,available,url,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               (run_id, platform_id, item["name"], product["name"], product.get("description"), product.get("category"), product.get("image"), product.get("price"), product.get("sale_price"), product.get("regular_price"), product.get("currency"), product.get("available"), product.get("url"), product_time, json.dumps(product, ensure_ascii=False)))
                    db.execute("INSERT OR IGNORE INTO products(platform,restaurant_name,name,category,price,currency,available,url,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                               (platform, item["name"], product["name"], product.get("category"), product.get("price"), product.get("currency"), product.get("available"), product.get("url"), product_time, json.dumps(product, ensure_ascii=False)))
                    if product.get("category"):
                        db.execute("INSERT OR IGNORE INTO categories(platform_id,name) VALUES(?,?)", (platform_id, product["category"]))
        for match in matches:
            db.execute("INSERT INTO restaurant_matches(run_id,glovo_name,mooup_name,confidence,status,reasons) VALUES(?,?,?,?,?,?)",
                       (run_id, match["name"], (match.get("match") or {}).get("name"), match["confidence"], match["status"], json.dumps(match.get("reasons", []), ensure_ascii=False)))
            if match.get("match"):
                from .matching import match_products
                for product_match in match_products(match.get("products", []), match["match"].get("products", [])):
                    db.execute("INSERT INTO product_matches(run_id,restaurant_name,glovo_product,mooup_product,confidence,status,reasons) VALUES(?,?,?,?,?,?,?)",
                               (run_id, match["name"], product_match["glovo"].get("name"), (product_match.get("mooup") or {}).get("name"), product_match["confidence"], product_match["status"], json.dumps(product_match.get("reasons", []), ensure_ascii=False)))
        for error in errors:
            db.execute("INSERT INTO collection_errors(run_id,platform,message) VALUES(?,?,?)", (run_id, error.get("platform"), error["message"]))
    return run_id


def latest_data():
    with connect() as db:
        run = db.execute("SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1").fetchone()
        history = [dict(row) for row in db.execute("SELECT id,started_at,finished_at,status,errors FROM collection_runs ORDER BY id DESC LIMIT 50")]
        matches = [dict(row) for row in db.execute("SELECT * FROM restaurant_matches WHERE run_id=?", (run["id"],))] if run else []
        for match in matches:
            try:
                match["reasons"] = json.loads(match.get("reasons") or "[]")
            except (ValueError, TypeError):
                match["reasons"] = []
        data = {"run": dict(run) if run else None,
                "restaurants": json.loads(run["results"]) if run else {"glovo": [], "mooup": []},
                "matches": matches,
                "history": history, "errors": json.loads(run["errors"]) if run else []}
        data["price_history"] = [dict(row) for row in db.execute("SELECT * FROM price_history ORDER BY recorded_at DESC LIMIT 500")]
        data["catalog_history"] = [dict(row) for row in db.execute("SELECT id,platform,imported_at,restaurant_count,product_count FROM catalog_import_history ORDER BY id DESC LIMIT 50")]
        catalog = db.execute("SELECT imported_at,payload FROM platform_catalogs WHERE platform='mooup'").fetchone()
        if catalog:
            data["restaurants"]["mooup"] = json.loads(catalog["payload"])
            data["mooup_imported_at"] = catalog["imported_at"]
        data["match_overrides"] = [dict(row) for row in db.execute("SELECT * FROM restaurant_match_overrides")]
        return data


def save_catalog(platform, imported_at, listings):
    with connect() as db:
        platform_id = db.execute("SELECT id FROM platforms WHERE name=?", (platform,)).fetchone()[0]
        db.execute("INSERT INTO catalog_import_history(platform,imported_at,restaurant_count,product_count,payload) VALUES(?,?,?,?,?)",
                   (platform, imported_at, len(listings), sum(len(row.get("products", [])) for row in listings),
                    json.dumps(listings, ensure_ascii=False)))
        db.execute("INSERT INTO platform_catalogs(platform,imported_at,payload) VALUES(?,?,?) ON CONFLICT(platform) DO UPDATE SET imported_at=excluded.imported_at,payload=excluded.payload",
                   (platform, imported_at, json.dumps(listings, ensure_ascii=False)))
        for listing in listings:
            if listing.get("category"):
                db.execute("INSERT OR IGNORE INTO categories(platform_id,name) VALUES(?,?)", (platform_id, listing["category"]))
            db.execute("INSERT OR IGNORE INTO restaurants(platform,external_id,name,url,category,address,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?)",
                       (platform, listing.get("id", listing.get("url")), listing["name"], listing.get("url"), listing.get("category"), listing.get("address"), imported_at, json.dumps(listing, ensure_ascii=False)))
            for product in listing.get("products", []):
                db.execute("INSERT OR IGNORE INTO products(platform,restaurant_name,name,category,price,currency,available,url,collected_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (platform, listing["name"], product["name"], product.get("category"), product.get("price"), product.get("currency"), product.get("available"), product.get("url") or listing.get("url"), product.get("collected_at") or imported_at, json.dumps(product, ensure_ascii=False)))
                if product.get("category"):
                    db.execute("INSERT OR IGNORE INTO categories(platform_id,name) VALUES(?,?)", (platform_id, product["category"]))


def save_price_history(run_id, rows, recorded_at):
    if not run_id:
        return
    with connect() as db:
        for row in rows:
            db.execute("INSERT INTO price_history(run_id,product_name,restaurant_name,mooup_price,glovo_price,currency,recorded_at) VALUES(?,?,?,?,?,?,?)",
                       (run_id, row["product"], row["restaurant"], row["mooup_price"], row["glovo_price"],
                        row.get("currency", "MAD"), recorded_at))


def save_match_override(glovo_name, mooup_name, status, updated_at):
    with connect() as db:
        db.execute("INSERT INTO restaurant_match_overrides(glovo_name,mooup_name,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(glovo_name) DO UPDATE SET mooup_name=excluded.mooup_name,status=excluded.status,updated_at=excluded.updated_at",
                   (glovo_name, mooup_name, status, updated_at))


def seed_observations():
    with connect() as db:
        watchlist = [dict(row) for row in db.execute("SELECT * FROM restaurant_watchlist ORDER BY position")]
        manual = [dict(row) for row in db.execute("SELECT * FROM user_missing_restaurants ORDER BY name")]
        history = [dict(row) for row in db.execute("SELECT * FROM user_missing_history ORDER BY id DESC LIMIT 100")]
        return watchlist, manual, history


def update_user_missing(name, status, checked_at, matched_name=None, url=None, image=None, category=None):
    with connect() as db:
        previous = db.execute("SELECT status,matched_mooup_name FROM user_missing_restaurants WHERE name=?", (name,)).fetchone()
        if not previous:
            return
        changed = previous["status"] != status or previous["matched_mooup_name"] != matched_name
        db.execute("UPDATE user_missing_restaurants SET status=?,last_checked_at=?,matched_mooup_name=?,glovo_url=COALESCE(?,glovo_url),image=COALESCE(?,image),category=COALESCE(?,category) WHERE name=?",
                   (status, checked_at, matched_name, url, image, category, name))
        if changed:
            evidence = json.dumps({"matched_mooup_name": matched_name, "glovo_url": url}, ensure_ascii=False)
            db.execute("INSERT INTO user_missing_history(restaurant_name,status,checked_at,evidence) VALUES(?,?,?,?)",
                       (name, status, checked_at, evidence))
