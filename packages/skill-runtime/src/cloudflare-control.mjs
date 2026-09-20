import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { requireString } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const API_ORIGIN = "https://api.cloudflare.com";

function assertControlPath(value, allowEmpty) {
  if ((allowEmpty && value === "") || (typeof value === "string"
    && /^\/(?!\/)[A-Za-z0-9._/-]+$/u.test(value)
    && !value.split("/").some((segment) => segment === "." || segment === ".."))) return;
  throw toolError("INVALID_CONTROL_PATH", "Control requests require a fixed same-origin resource path");
}

async function authHeaders({ wranglerExecutable, cloudflareProfile = null, contextDirectory = null, environment = process.env, tokenRunner = execFileAsync }, errorPrefix) {
  if (cloudflareProfile && contextDirectory) throw toolError("AMBIGUOUS_WRANGLER_AUTH_CONTEXT", "Choose the frozen profile or context, not both");
  if (cloudflareProfile && !/^[A-Za-z0-9_-]{1,128}$/u.test(cloudflareProfile)) throw toolError("INVALID_WRANGLER_PROFILE", "The frozen profile name is invalid");
  if (cloudflareProfile && (environment.CLOUDFLARE_API_TOKEN || environment.CLOUDFLARE_API_KEY)) throw toolError("WRANGLER_PROFILE_SHADOWED_BY_ENV", "Environment authentication shadows the frozen profile");
  if (!cloudflareProfile && environment.CLOUDFLARE_API_TOKEN) return { Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` };
  if (!cloudflareProfile && environment.CLOUDFLARE_API_KEY && environment.CLOUDFLARE_EMAIL) return { "X-Auth-Key": environment.CLOUDFLARE_API_KEY, "X-Auth-Email": environment.CLOUDFLARE_EMAIL };
  if (environment.CLOUDFLARE_API_KEY || environment.CLOUDFLARE_EMAIL) throw toolError(`${errorPrefix}_AUTH_UNAVAILABLE`, "Cloudflare environment authentication is incomplete");
  if (!cloudflareProfile && !contextDirectory) throw toolError(`${errorPrefix}_AUTH_CONTEXT_REQUIRED`, "Use the frozen profile or private authentication context directory");
  if (!path.isAbsolute(wranglerExecutable ?? "")) throw toolError("ABSOLUTE_PATH_REQUIRED", "Wrangler must be an absolute executable path");
  if (contextDirectory && !path.isAbsolute(contextDirectory)) throw toolError("ABSOLUTE_PATH_REQUIRED", "Cloudflare context must be an absolute path");
  const args = ["auth", "token", "--json", ...(cloudflareProfile ? ["--profile", cloudflareProfile] : []), ...(contextDirectory ? ["--cwd", contextDirectory] : [])];
  try {
    const result = await tokenRunner(wranglerExecutable, args, { env: { ...environment, WRANGLER_WRITE_LOGS: "false" }, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    const parsed = JSON.parse(result.stdout);
    if (!["oauth", "api_token"].includes(parsed?.type) || typeof parsed.token !== "string" || !parsed.token) throw new Error();
    return { Authorization: `Bearer ${parsed.token}` };
  } catch {
    throw toolError(`${errorPrefix}_AUTH_UNAVAILABLE`, "The frozen Cloudflare authentication could not be read; no login or profile change was performed");
  }
}

export async function createCloudflareControlClient(input, resourcePath = "/r2/buckets", { errorPrefix = "R2", resourceLabel = "R2" } = {}) {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(errorPrefix)) throw toolError("INVALID_ERROR_PREFIX", "Control client error prefix is invalid");
  assertControlPath(resourcePath, false);
  const account = requireString(input.accountId, "account_id", { max: 128 });
  if (!/^[A-Za-z0-9_-]+$/u.test(account)) throw toolError("INVALID_ACCOUNT_ID", "Account ID is invalid");
  const headers = await authHeaders(input, errorPrefix);
  const base = `/client/v4/accounts/${account}${resourcePath}`;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  return async (suffix, { method = "GET", body, raw = false, allowMissing = false } = {}) => {
    assertControlPath(suffix, true);
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${base}${suffix}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { ...headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw toolError(`${errorPrefix}_CONTROL_UNAVAILABLE`, `Cloudflare ${resourceLabel} response is uncertain; read back before retrying`, { method });
    }
    let text;
    try {
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 64 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      text = Buffer.concat(chunks).toString("utf8");
    } catch { throw toolError(`${errorPrefix}_CONTROL_READBACK_INVALID`, `${resourceLabel} readback exceeded its bound or could not be read`); }
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { throw toolError(`${errorPrefix}_CONTROL_READBACK_INVALID`, `${resourceLabel} returned an invalid readback`); }
    if (allowMissing && response.status === 404 && (raw || value?.errors?.some((error) => error.code === 10006))) return null;
    if (!response.ok || (!raw && value?.success !== true)) {
      throw toolError(`${errorPrefix}_CONTROL_FAILED`, `Cloudflare ${resourceLabel} request failed; check subscription and the selected account's permissions`, { status: response.status, codes: Array.isArray(value?.errors) ? value.errors.map((entry) => Number(entry.code)).filter(Number.isSafeInteger) : [] });
    }
    return raw ? value : value.result;
  };
}
