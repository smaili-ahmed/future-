import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const exportRoot = path.resolve(
  process.env.GLOVO_EXPORT_PATH || path.join(ROOT, "glovo-export"),
  "restaurants",
);
const outRoot = path.join(ROOT, "public", "images", "glovo");
const force = process.argv.includes("--force");
const width = Number(process.env.IMAGE_WIDTH || 260);
const quality = Number(process.env.IMAGE_QUALITY || 62);

if (!fs.existsSync(exportRoot)) {
  console.error(`Export Glovo introuvable: ${exportRoot}`);
  console.error("Définir GLOVO_EXPORT_PATH vers le dossier export-data.");
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(webp|jpe?g|png)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

function isFresh(src, dest) {
  if (force || !fs.existsSync(dest)) return false;
  return fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs;
}

async function convert(src, dest) {
  const ext = path.extname(src).toLowerCase();
  const pipeline = sharp(src)
    .rotate()
    .resize({ width, height: width, fit: "inside", withoutEnlargement: true });

  if (ext === ".webp") return pipeline.webp({ quality }).toFile(dest);
  if (ext === ".jpg" || ext === ".jpeg") {
    return pipeline.jpeg({ quality: Math.min(82, quality + 8), mozjpeg: true }).toFile(dest);
  }
  if (ext === ".png") return pipeline.png({ compressionLevel: 9, palette: true }).toFile(dest);
  throw new Error(`Format non supporté: ${ext}`);
}

const files = walk(exportRoot);
let next = 0;
let converted = 0;
let skipped = 0;
let failed = 0;
let total = 0;

async function worker() {
  while (next < files.length) {
    const src = files[next++];
    const rel = path.relative(exportRoot, src);
    const dest = path.join(outRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (isFresh(src, dest)) {
      skipped += 1;
      total += fs.statSync(dest).size;
      continue;
    }
    try {
      await convert(src, dest);
      converted += 1;
      total += fs.statSync(dest).size;
    } catch (error) {
      failed += 1;
      fs.copyFileSync(src, dest);
      total += fs.statSync(dest).size;
      console.warn(`Échec ${rel}: ${error.message}`);
    }
    if ((converted + skipped + failed) % 250 === 0) {
      console.log(`${converted + skipped + failed}/${files.length}...`);
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: 6 }, () => worker()));
console.log(
  `Images: ${files.length} | converties ${converted} | ignorées ${skipped} | erreurs ${failed} | ${(total / 1024 / 1024).toFixed(1)} Mo | ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
