import { readFile } from "node:fs/promises";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { readServiceReleaseVersion } from "./service-release-version.mjs";
import { satisfiesSimpleRange } from "./tool-runtime.mjs";
import { assertNoSymlinkPath } from "./utils.mjs";

const API_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

async function readContract(bundleRoot, relativePath) {
  const filePath = path.join(bundleRoot, relativePath);
  await assertNoSymlinkPath(filePath, bundleRoot);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Service version contract must be valid JSON", { entry: relativePath });
    throw error;
  }
}

export async function readServiceApiVersion(bundleRoot, { expectedReleaseVersion, expectedApiVersion, serviceApiRange } = {}) {
  const [openapi, declaration, migrationManifest] = await Promise.all([
    readContract(bundleRoot, "contracts/openapi.json"),
    readContract(bundleRoot, "contracts/service-api.json"),
    readContract(bundleRoot, "migrations/manifest.json"),
  ]);
  if (openapi === undefined) throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Service bundle is missing its OpenAPI contract");
  const extension = openapi?.["x-cfkanban-service-version"];
  let serviceVersion;
  if (declaration !== undefined || extension !== undefined) {
    serviceVersion = declaration?.service_version;
    if (typeof serviceVersion !== "string" || !API_VERSION.test(serviceVersion) || extension !== serviceVersion) {
      throw toolError("SERVICE_API_DECLARATION_MISMATCH", "Service API declaration and OpenAPI extension must contain the same API version");
    }
    const releaseVersion = await readServiceReleaseVersion(bundleRoot, expectedReleaseVersion);
    if (releaseVersion === null || openapi?.info?.version !== releaseVersion) {
      throw toolError("DEPLOYMENT_RELEASE_DRIFT", "OpenAPI document version must match the Service release declaration");
    }
  } else {
    // 只有历史格式将 info.version 用作 API 版本；新的 API 版本必须提供独立声明。
    serviceVersion = openapi?.info?.version;
    if (typeof serviceVersion !== "string" || !API_VERSION.test(serviceVersion)
      || !satisfiesSimpleRange(serviceVersion, ">=0.1.0 <0.2.0")) {
      throw toolError("SERVICE_API_DECLARATION_REQUIRED", "This Service bundle requires an independent API version declaration");
    }
    await readServiceReleaseVersion(bundleRoot, expectedReleaseVersion);
  }
  const compatibility = migrationManifest?.service_compatibility;
  if (compatibility !== undefined && (typeof compatibility?.minimum !== "string" || !API_VERSION.test(compatibility.minimum)
    || typeof compatibility?.maximum_exclusive !== "string" || !API_VERSION.test(compatibility.maximum_exclusive)
    || !satisfiesSimpleRange(serviceVersion, `>=${compatibility.minimum} <${compatibility.maximum_exclusive}`))) {
    throw toolError("DEPLOYMENT_SERVICE_VERSION_DRIFT", "Service API version does not match migration compatibility");
  }
  if ((expectedApiVersion !== undefined && serviceVersion !== expectedApiVersion)
    || (serviceApiRange !== undefined && !satisfiesSimpleRange(serviceVersion, serviceApiRange))) {
    throw toolError("DEPLOYMENT_SERVICE_VERSION_DRIFT", "Service API version does not match the authorized release compatibility");
  }
  return serviceVersion;
}
