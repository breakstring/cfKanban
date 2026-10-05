import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const assets = new URL("../apps/web/src/assets/", import.meta.url);

export async function renderBrandAssets() {
  const source = await readFile(new URL("cfkanban-mark.svg", assets), "utf8");
  const plugin = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  const color = plugin.interface.brandColor;
  assert.match(color, /^#[\da-f]{6}$/iu, "Plugin brand color must be an opaque hex color");
  assert.equal(source.match(/stroke="currentColor"/gu)?.length, 1, "The canonical mark must define one inherited stroke color");
  const svg = Buffer.from(source.replace('stroke="currentColor"', `stroke="${color}"`));
  const png = await sharp(svg, { density: 960 }).resize(256, 256).ensureAlpha().png({ compressionLevel: 9, palette: false }).toBuffer();
  return new Map([["cfkanban-mark-orange.svg", svg], ["cfkanban-mark.png", png]]);
}

export async function generateBrandAssets({ check = false } = {}) {
  for (const [name, bytes] of await renderBrandAssets()) {
    const output = new URL(name, assets);
    if (check) assert.deepEqual(await readFile(output), bytes, `${name} is stale; run npm run brand:generate`);
    else await writeFile(output, bytes);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateBrandAssets({ check: process.argv.includes("--check") });
  console.log(process.argv.includes("--check") ? "Brand assets match their canonical SVG and brand color." : "Generated the orange SVG and transparent 256px PNG from the canonical mark.");
}
