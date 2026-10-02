import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function verifyEmbeddedBuild({ outputDirectory, version }) {
  const metadata = JSON.parse(await readFile(path.join(outputDirectory, "embedded-build.json"), "utf8"));
  if (metadata.schema_version !== 1 || metadata.protocol !== 1 || metadata.entry !== "embedded.html"
    || metadata.release_version !== version) {
    throw new Error("Embedded page metadata does not match the current release; rebuild before packaging");
  }
  const html = await readFile(path.join(outputDirectory, metadata.entry));
  if (metadata.size_bytes !== html.length || metadata.sha256 !== createHash("sha256").update(html).digest("hex")) {
    throw new Error("Embedded page digest changed; rebuild before packaging");
  }
  return metadata;
}
