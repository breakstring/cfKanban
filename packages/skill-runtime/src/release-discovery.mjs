import { toolError } from "./errors.mjs";
import { validateReleaseManifest, verifyReleasePointer } from "./release.mjs";

export const STABLE_RELEASE_POINTER = "https://github.com/breakstring/cfKanban/releases/latest/download/stable.json";
const RELEASE_BASE = "https://github.com/breakstring/cfKanban/releases/download/";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const MAX_DOCUMENT_BYTES = 256 * 1024;

function requireCanonical(condition) {
  if (!condition) throw toolError("INVALID_RELEASE_DISCOVERY", "Release discovery must identify one immutable canonical cfKanban release");
}

async function fetchDocument(url, fetchImpl) {
  const signal = AbortSignal.timeout(30_000);
  try {
    for (let hops = 0; hops < 5; hops += 1) {
      const parsed = new URL(url);
      requireCanonical(parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port
        && ["github.com", "release-assets.githubusercontent.com"].includes(parsed.hostname));
      const response = await fetchImpl(url, { redirect: "manual", signal, cache: "no-store", credentials: "omit" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        requireCanonical(Boolean(location));
        url = new URL(location, url).href;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw toolError("RELEASE_DISCOVERY_UNAVAILABLE", "The requested release could not be discovered; do not fall back to a prerelease or source checkout", { status: response.status });
      }
      requireCanonical(response.body !== null);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          requireCanonical(size <= MAX_DOCUMENT_BYTES);
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      return Buffer.concat(chunks);
    }
    requireCanonical(false);
  } catch (error) {
    if (["INVALID_RELEASE_DISCOVERY", "RELEASE_DISCOVERY_UNAVAILABLE"].includes(error?.code)) throw error;
    // Redirects can contain GitHub's signed asset URLs; transport errors never leave this boundary.
    throw toolError("RELEASE_DISCOVERY_UNAVAILABLE", "The release response could not be verified; retry discovery without changing the requested source");
  }
}

function parseDocument(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw toolError("INVALID_RELEASE_DISCOVERY", "Release discovery returned an invalid JSON document"); }
}

export async function discoverRelease({ version = null } = {}, { fetchImpl = fetch } = {}) {
  if (version !== null && (typeof version !== "string" || !VERSION.test(version))) {
    throw toolError("INVALID_INPUT", "version must be an exact release version; omit it to discover the latest stable release");
  }
  const channel = version?.includes("-") ? "prerelease" : "stable";
  const discoveryUrl = version === null ? STABLE_RELEASE_POINTER : `${RELEASE_BASE}${version}/${channel}.json`;
  const pointer = parseDocument(await fetchDocument(discoveryUrl, fetchImpl));
  const resolvedVersion = pointer?.release_version;
  requireCanonical(typeof resolvedVersion === "string" && VERSION.test(resolvedVersion)
    && (version === null || resolvedVersion === version) && pointer.channel === channel
    && (channel === "prerelease") === resolvedVersion.includes("-"));
  const base = `${RELEASE_BASE}${resolvedVersion}/`;
  requireCanonical(pointer.manifest_url === `${base}cfkanban-release-${resolvedVersion}.json`);
  const manifestBytes = await fetchDocument(pointer.manifest_url, fetchImpl);
  verifyReleasePointer({ pointer, manifestBytes });
  const manifest = validateReleaseManifest(parseDocument(manifestBytes));
  for (const document of [pointer, manifest]) {
    requireCanonical(document.product === "cfkanban" && document.publisher?.id === "cfkanban"
      && document.publisher.canonical_origin === "https://github.com"
      && document.documents?.en === `${base}install.md`
      && document.documents?.["zh-CN"] === `${base}install.zh-CN.md`);
  }
  requireCanonical(manifest.release?.version === resolvedVersion && manifest.release.immutable === true
    && typeof manifest.compatibility?.node === "string" && typeof manifest.compatibility.wrangler === "string"
    && typeof manifest.compatibility.service_api === "string" && Number.isSafeInteger(manifest.compatibility.schema_version)
    && manifest.compatibility.schema_version >= 1);
  for (const artifact of manifest.artifacts) {
    const name = artifact.kind === "skill_bundle" ? "skills" : "service";
    requireCanonical(artifact.version === resolvedVersion && artifact.url === `${base}cfkanban-${name}-${resolvedVersion}.zip`
      && artifact.allowed_origins.length === 1 && artifact.allowed_origins[0] === "https://github.com");
  }
  return {
    discovery_url: discoveryUrl,
    release_pointer_url: `${base}${channel}.json`,
    release_version: resolvedVersion,
    manifest_sha256: pointer.manifest_sha256,
    pointer,
    manifest,
    artifacts_verified: false,
    marketplace: { source: "https://github.com/breakstring/cfKanban.git", ref: resolvedVersion },
  };
}
