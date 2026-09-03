import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths, updateTrustedOrigin } from "./state.mjs";
import { normalizeNetworkFailure } from "./transport.mjs";
import { readJson, requireHttpsOrigin } from "./utils.mjs";
import { toolError } from "./errors.mjs";

export async function fetchDiscovery(origin, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL("/.well-known/cfkanban-instance.json", origin), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw toolError("DISCOVERY_NETWORK_FAILURE", "Instance discovery failed without sending a Credential", normalizeNetworkFailure(error).error.details, error);
  }
  if (!response.ok || response.status >= 300 && response.status < 400 || !(response.headers.get("content-type") || "").includes("application/json")) {
    throw toolError("DISCOVERY_REJECTED", "Instance discovery did not return a direct JSON success response", { origin, status: response.status });
  }
  return response.json();
}

export function validateDiscovery(discovery, requestedOrigin) {
  if (discovery?.discovery_version !== 1 || typeof discovery.instance_id !== "string" || !Number.isSafeInteger(discovery.origin_version)) {
    throw toolError("INVALID_DISCOVERY", "Instance discovery response is missing required fields", { requestedOrigin });
  }
  const observedOrigin = requireHttpsOrigin(discovery.observed_origin, "observed_origin");
  if (observedOrigin !== requestedOrigin) {
    throw toolError("DISCOVERY_ORIGIN_MISMATCH", "Instance discovery did not report the exact origin that was probed", { requestedOrigin, observedOrigin });
  }
  return {
    ...discovery,
    observed_origin: observedOrigin,
    preferred_api_origin: requireHttpsOrigin(discovery.preferred_api_origin, "preferred_api_origin"),
  };
}

export async function checkTrustedOriginRebind({ stateRoot = resolveStateRoot(), instanceId, fetchImpl = globalThis.fetch }) {
  const paths = getInstancePaths({ stateRoot, instanceId });
  const current = await readJson(paths.instanceMetadata);
  const trustedOrigin = requireHttpsOrigin(current.trusted_api_origin, "trusted_api_origin");
  const trustedDiscovery = validateDiscovery(await fetchDiscovery(trustedOrigin, fetchImpl), trustedOrigin);
  if (trustedDiscovery.instance_id !== current.instance_id) {
    throw toolError("DISCOVERY_INSTANCE_MISMATCH", "The trusted origin now reports a different instance_id", { expected: current.instance_id, actual: trustedDiscovery.instance_id });
  }
  if (trustedDiscovery.origin_version < current.origin_version) {
    throw toolError("DISCOVERY_VERSION_ROLLBACK", "The trusted origin reported an older origin version", { current: current.origin_version, reported: trustedDiscovery.origin_version });
  }
  if (trustedDiscovery.origin_version === current.origin_version) {
    return { changed: false, reason: "origin_version_unchanged", instance: current };
  }
  const targetOrigin = trustedDiscovery.preferred_api_origin;
  const targetDiscovery = validateDiscovery(await fetchDiscovery(targetOrigin, fetchImpl), targetOrigin);
  const fields = ["instance_id", "preferred_api_origin", "origin_version"];
  for (const field of fields) {
    if (targetDiscovery[field] !== trustedDiscovery[field]) {
      throw toolError("DISCOVERY_CROSS_CHECK_FAILED", "The target origin did not confirm the trusted origin's migration instruction", { field });
    }
  }
  const updated = await updateTrustedOrigin({
    stateRoot,
    instanceId,
    expectedOriginVersion: current.origin_version,
    discovery: targetDiscovery,
  });
  return { changed: true, previous_origin: trustedOrigin, trusted_api_origin: targetOrigin, origin_version: updated.origin_version };
}
