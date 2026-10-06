import { compareReleaseVersions } from "../../../../packages/skill-runtime/src/release-versions.mjs";
import { requireOwnerControl, reauthenticateOwner } from "../kernel/authorization.ts";
import type { AuthContext, WorkerEnv } from "../kernel/types.ts";
import { RELEASE_VERSION } from "../release-version.ts";
import { beforeDeadline, parseReleasePage, readReleaseHtml, RELEASES_URL, RELEASE_PAGE_LIMIT, trustedReleaseLink, type ReleasePageEntry } from "./release-page.ts";

const TTL = 15 * 60_000;
const RETRY = 60_000;
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

function release(value: ReleasePageEntry): AvailableRelease {
  const comparison = compareReleaseVersions(value.version, RELEASE_VERSION);
  return { version: value.version, url: value.url, published_at: value.published_at, newer_than_instance: comparison === null ? null : comparison > 0 };
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
      const signal = AbortSignal.timeout(5_000);
      async function page(url: string): Promise<Response> {
        const operation = fetcher(url, {
          headers: { accept: "text/html", "user-agent": "cfKanban-release-discovery" },
          redirect: "manual", signal,
        });
        void operation.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
        const response = await beforeDeadline(operation, signal);
        if (response.status === 429 || response.status === 403) error = "rate_limited";
        if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error("unexpected_redirect"); }
        return response;
      }
      let response = await page(isPrerelease ? RELEASES_URL : `${RELEASES_URL}/latest`);
      let target: string | null = null;
      if (!isPrerelease && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => {});
        if (!location) throw new Error("missing_release_redirect");
        target = trustedReleaseLink(location).url;
        response = await page(target);
      }
      let releases: AvailableRelease[];
      if (!isPrerelease && !target && response.status === 404) { void response.body?.cancel().catch(() => {}); releases = []; }
      else {
        if (response.status !== 200 || !isPrerelease && !target) { void response.body?.cancel().catch(() => {}); throw new Error("github_unavailable"); }
        const html = await readReleaseHtml(response, signal);
        const entries = await beforeDeadline(parseReleasePage(html, isPrerelease ? "list" : "stable", target), signal);
        releases = isPrerelease ? entries.filter(row => row.prerelease)
          .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
          .slice(0, 5).map(release) : entries.map(release);
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
    return structuredClone({ current_version: RELEASE_VERSION, stable, prereleases, prerelease_window: RELEASE_PAGE_LIMIT });
  };
}
const readUpdates = createReleaseUpdatesReader();
export async function getReleaseUpdates(env: WorkerEnv, request: Request, auth: AuthContext): Promise<ReleaseUpdates> {
  requireOwnerControl(auth);
  const result = await readUpdates();
  await reauthenticateOwner(env.DB, request, Date.now());
  return result;
}
