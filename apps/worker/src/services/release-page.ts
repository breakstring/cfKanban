import { parseReleaseVersion } from "../../../../packages/skill-runtime/src/release-versions.mjs";

export const RELEASES_URL = "https://github.com/breakstring/cfKanban/releases";
export const RELEASE_PAGE_LIMIT = 20;
export const MAX_RELEASE_PAGE_BYTES = 1024 * 1024;
export type ReleasePageEntry = { version: string; url: string; published_at: string; prerelease: boolean };

export function trustedReleaseLink(value: string): { version: string; url: string } {
  const url = new URL(value, RELEASES_URL);
  const prefix = "/breakstring/cfKanban/releases/tag/";
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) {
    throw new Error("invalid_release_link");
  }
  const version = url.pathname.slice(prefix.length);
  if (version.includes("+") || !parseReleaseVersion(version)) throw new Error("invalid_release_tag");
  const expected = `${RELEASES_URL}/tag/${version}`;
  if (url.href !== expected || value !== expected && value !== `${prefix}${version}`) throw new Error("invalid_release_link");
  return { version, url: expected };
}

export function releaseTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== (value.includes(".") ? value : value.replace(/Z$/, ".000Z"))) throw new Error("invalid_release_time");
  return value;
}

export function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(new Error("release_query_timeout")); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("release_query_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readReleaseHtml(response: Response, signal: AbortSignal): Promise<string> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const declaredSize = response.headers.get("content-length");
  if (contentType !== "text/html" || !response.body || declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > MAX_RELEASE_PAGE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("invalid_release_page");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await beforeDeadline(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RELEASE_PAGE_BYTES) throw new Error("release_page_too_large");
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

const CONTAINER = "#repo-content-pjax-container > div.container-xl";
const LIST = `${CONTAINER} > div[data-pjax][data-hpc]`;
const CARD = `${LIST} > div > div.col-md-9 > section[data-release-anchor]`;
const LIST_BODY = `${CARD} > div > div > div.Box > div.Box-body`;
const DETAIL_BODY = `${CONTAINER} > div[data-hpc] > div.Box > div.Box-body`;
const HEADER = " > div.d-flex.flex-md-row.flex-column > div.wb-break-word";
const META = ' > div[data-pjax="#repo-content-pjax-container"] > div > div > relative-time[datetime]';
type PendingEntry = { link: { version: string; url: string } | null; date: string | null; prerelease: boolean; bodies: number; headers: number; tags: number; dates: number };

// Direct-child paths isolate GitHub's metadata from user-authored release Markdown.
export async function parseReleasePage(html: string, kind: "list" | "stable", target: string | null): Promise<ReleasePageEntry[]> {
  const rows: PendingEntry[] = [];
  const pending = (): PendingEntry => ({ link: null, date: null, prerelease: false, bodies: 0, headers: 0, tags: 0, dates: 0 });
  let containers = 0, lists = 0, cards = 0, active: PendingEntry | null = null;
  const detail: { link: { version: string; url: string } | null; tags: number } = { link: null, tags: 0 };
  let badge: { row: PendingEntry; text: string } | null = null;
  const emptyHeadings: string[] = [];
  let emptyHeading: { text: string } | null = null;
  const body = kind === "list" ? LIST_BODY : DETAIL_BODY;
  const header = body + HEADER;
  const rewriter = new HTMLRewriter().on(CONTAINER, { element() { containers++; } });
  if (kind === "list") {
    rewriter.on(LIST, { element() { lists++; } }).on(`${LIST} > div.blankslate > h2`, {
      element(element) {
        const current = { text: "" }; emptyHeading = current;
        element.onEndTag(() => { emptyHeadings.push(current.text.trim()); emptyHeading = null; });
      },
      text(chunk) { if (emptyHeading) { emptyHeading.text += chunk.text; if (emptyHeading.text.length > 128) throw new Error("invalid_release_empty_state"); } },
    }).on(CARD, { element(element) {
      cards++;
      active = cards <= RELEASE_PAGE_LIMIT ? pending() : null;
      if (active) rows.push(active);
      element.onEndTag(() => { active = null; });
    } });
  } else {
    rewriter.on(`${CONTAINER} > nav[aria-label="Breadcrumb"] > ol > li.breadcrumb-item-selected > a[aria-current="page"]`, { element(element) {
      const link = trustedReleaseLink(element.getAttribute("href") ?? "");
      detail.tags++;
      if (detail.link && detail.link.url !== link.url) throw new Error("ambiguous_release_tag");
      detail.link = link;
    } });
  }
  rewriter.on(body, { element(element) {
    if (kind === "stable") { active = pending(); rows.push(active); element.onEndTag(() => { active = null; }); }
    if (active) active.bodies++;
  } }).on(header, { element() { if (active) active.headers++; } });
  if (kind === "list") {
    rewriter.on(`${header} > div[data-pjax="#repo-content-pjax-container"] > span > a[href^="/breakstring/cfKanban/releases/tag/"]`, { element(element) {
      if (!active) return;
      const link = trustedReleaseLink(element.getAttribute("href") ?? "");
      active.tags++;
      if (active.link && active.link.url !== link.url) throw new Error("ambiguous_release_tag");
      active.link = link;
    } });
  }
  const badgeHandler: HTMLRewriterElementContentHandlers = {
    element(element) {
      if (!active) return;
      const current = { row: active, text: "" }; badge = current;
      element.onEndTag(() => {
        if (current.text.trim() !== "Pre-release") throw new Error("invalid_release_badge");
        current.row.prerelease = true; badge = null;
      });
    },
    text(chunk) { if (badge) { badge.text += chunk.text; if (badge.text.length > 128) throw new Error("invalid_release_badge"); } },
  };
  rewriter.on(`${header} > div[data-pjax="#repo-content-pjax-container"] > span > span.Label--warning`, badgeHandler)
    .on(`${header} > div.d-md-none > span.Label--warning`, badgeHandler).on(body + META, { element(element) {
    if (!active) return;
    active.dates++; active.date = releaseTimestamp(element.getAttribute("datetime") ?? "");
  } });
  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).arrayBuffer();
  if (containers !== 1 || kind === "list" && lists !== 1 || kind === "stable" && rows.length !== 1) throw new Error("invalid_release_structure");
  if (kind === "stable") {
    const row = rows[0];
    if (!row || !detail.link || target && detail.link.url !== target) throw new Error("invalid_release_tag");
    row.link = detail.link;
    row.tags = detail.tags;
    if (row.prerelease) throw new Error("invalid_stable_release");
  }
  if (!rows.length) {
    if (kind === "list" && emptyHeadings.length === 1 && emptyHeadings[0] === "There aren’t any releases here") return [];
    throw new Error("missing_release_cards");
  }
  if (emptyHeadings.length) throw new Error("invalid_release_empty_state");
  const result = rows.map(row => {
    if (!row.link || !row.date || row.bodies !== 1 || row.headers !== 1 || row.tags !== 1 || row.dates !== 1) throw new Error("invalid_release_metadata");
    return { ...row.link, published_at: row.date, prerelease: row.prerelease };
  });
  if (new Set(result.map(row => row.version)).size !== result.length) throw new Error("duplicate_release_tag");
  return result;
}
