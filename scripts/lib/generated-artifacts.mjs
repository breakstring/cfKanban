import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function sha256NormalizedText(value) {
  return createHash("sha256").update(normalizeLineEndings(value)).digest("hex");
}

export function renderGeneratedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseGeneratedMode(args) {
  if (args.length === 0) return "write";
  if (args.length === 1 && args[0] === "--check") return "check";
  throw new Error(`Unsupported generator arguments: ${args.join(" ")}`);
}

export async function syncGeneratedFile(target, expected, options = {}) {
  const mode = options.mode ?? "write";
  const targetPath = target instanceof URL ? fileURLToPath(target) : target;
  const normalizedExpected = normalizeLineEndings(expected);

  if (mode === "check") {
    let actual;
    try {
      actual = await readFile(targetPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Generated artifact is missing: ${relative(process.cwd(), targetPath)}`);
      }
      throw error;
    }

    if (normalizeLineEndings(actual) !== normalizedExpected) {
      const hint = options.regenerateCommand ? ` Run ${options.regenerateCommand}.` : "";
      throw new Error(`Generated artifact drift detected: ${relative(process.cwd(), targetPath)}.${hint}`);
    }
    return "checked";
  }

  if (mode !== "write") throw new Error(`Unsupported generated artifact mode: ${mode}`);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, normalizedExpected, "utf8");
  return "written";
}
