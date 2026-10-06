import { compareReleaseVersions, parseReleaseVersion } from "../../../../packages/skill-runtime/src/release-versions.mjs";
import { requireOwnerControl, reauthenticateOwner } from "../kernel/authorization.ts";
import type { AuthContext, WorkerEnv } from "../kernel/types.ts";
import { RELEASE_VERSION } from "../release-version.ts";

const API = "https://api.github.com/repos/breakstring/cfKanban/releases";
const TTL = 15 * 60_000;
const RETRY = 60_000;
const MAX_BYTES = 512 * 1024;
export type AvailableRelease = {
  version: string;
  url: string;
  published_at: string;
  newer_than_instance: boolean | null;
}
export type ReleaseChannel = {
  status: "fresh" | "stale" | "unavailable";
  checked_at: string | null;
  last_attempt_at: string | null;
  retry_at: string | null;
  error: "rate_limited" | "query_failed" | null;
  releases: AvailableRelease[];
}
export type ReleaseUpdates = {
  current_version: string;
  stable: ReleaseChannel;
  prereleases: ReleaseChannel;
  prerelease_window: number;
}
type Fetcher = typeof fetch;
const empty = (): ReleaseChannel => ({ status: "unavailable", checked_at: null, last_attempt_at: null, retry_at: null, error: null, releases: [] });

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function release(value: unknown, prerelease: boolean): AvailableRelease {
  if (!value || typeof value !== "object") throw new Error("invalid_release");
  const row = value as Record<string, unknown>;
  const version = row.tag_name;
  if (typeof version !== "string" || version.length > 128 || version.includes("+") || !parseReleaseVersion(version)
    || row.draft !== false || row.prerelease !== prerelease || version.includes("-") !== prerelease
    || typeof row.published_at !== "string" || !Number.isFinite(Date.parse(row.published_at))) throw new Error("invalid_release");
  const expectedUrl = `https://github.com/breakstring/cfKanban/releases/tag/${version}`;
  if (row.html_url !== expectedUrl) throw new Error("invalid_release_link");
  const comparison = compareReleaseVersions(version, RELEASE_VERSION);
  return { version, url: expectedUrl, published_at: row.published_at, newer_than_instance: comparison === null ? null : comparison > 0 };
}

// Public release metadata is shared within one isolate; no identity or Credential enters this cache.
export function createReleaseUpdatesReader(fetcher: Fetcher = fetch, now: () => number = Date.now) {
  let stable = empty(), prereleases = empty();
  let pending: Promise<void> | null = null;
  async function channel(previous: ReleaseChannel, isPrerelease: boolean): Promise<ReleaseChannel> {
    const attempted = now();
    if (previous.retry_at && attempted < Date.parse(previous.retry_at)) return previous;
    let error: ReleaseChannel["error"] = "query_failed";
    try {
      const response = await fetcher(isPrerelease ? `${API}?per_page=20&page=1` : `${API}/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "cfKanban-release-discovery", "x-github-api-version": "2022-11-28" },
        redirect: "manual", signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 429 || response.status === 403) error = "rate_limited";
      let releases: AvailableRelease[];
      if (!isPrerelease && response.status === 404) releases = [];
      else {
        if (!response.ok) throw new Error("github_unavailable");
        const body = await readBoundedJson(response);
        if (isPrerelease) {
          if (!Array.isArray(body) || body.length > 20) throw new Error("invalid_release_list");
          releases = body.filter(row => row?.prerelease === true && row?.draft === false).map(row => release(row, true));
          releases.sort((a, b) => compareReleaseVersions(b.version, a.version) ?? 0);
          releases = [...new Map(releases.map(item => [item.version, item])).values()].slice(0, 5);
        } else releases = [release(body, false)];
      }
      return { status: "fresh", checked_at: new Date(attempted).toISOString(), last_attempt_at: new Date(attempted).toISOString(), retry_at: new Date(attempted + TTL).toISOString(), error: null, releases };
    } catch {
      return { ...previous, status: previous.checked_at ? "stale" : "unavailable", last_attempt_at: new Date(attempted).toISOString(), retry_at: new Date(attempted + RETRY).toISOString(), error };
    }
  }
  return async (): Promise<ReleaseUpdates> => {
    if (pending || [stable, prereleases].some(item => !item.retry_at || now() >= Date.parse(item.retry_at))) {
      if (!pending) pending = (async () => {
        [stable, prereleases] = await Promise.all([channel(stable, false), channel(prereleases, true)]);
      })().finally(() => { pending = null; });
      await pending;
    }
    return structuredClone({ current_version: RELEASE_VERSION, stable, prereleases, prerelease_window: 20 });
  };
}
const readUpdates = createReleaseUpdatesReader();
export async function getReleaseUpdates(env: WorkerEnv, request: Request, auth: AuthContext): Promise<ReleaseUpdates> {
  requireOwnerControl(auth);
  const result = await readUpdates();
  await reauthenticateOwner(env.DB, request, Date.now());
  return result;
}
