import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDshPlugin } from "../packages/dsh-plugin/scripts/build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "release/version.json"), "utf8"));
const { manifest, ...result } = await buildDshPlugin({ outputDirectory: path.join(root, "build/dsh"), version });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
