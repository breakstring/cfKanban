import { readFile } from "node:fs/promises";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { assertNoSymlinkPath } from "./utils.mjs";

export async function readServiceReleaseVersion(bundleRoot, expectedVersion) {
  const filePath = path.join(bundleRoot, "release", "version.json");
  await assertNoSymlinkPath(filePath, bundleRoot);
  let bytes;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let declaration;
  try {
    declaration = JSON.parse(bytes);
  } catch (error) {
    throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Service release declaration must be valid JSON", {}, error);
  }
  if (typeof declaration?.version !== "string" || declaration.version !== expectedVersion) {
    throw toolError("DEPLOYMENT_RELEASE_DRIFT", "Service release declaration does not match the authorized bundle version");
  }
  return declaration.version;
}
