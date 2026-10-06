export type TypedIssueSearch =
  | { kind: "empty"; normalized: string }
  | { kind: "invalid"; normalized: string; reason: "short" | "long" | "number" }
  | { kind: "title"; normalized: string }
  | { kind: "number"; normalized: string; prefix: string; number: number };

export function typedIssueSearch(raw: string): TypedIssueSearch {
  const normalized = raw.normalize("NFKC").toLowerCase().trim();
  if (!normalized) return { kind: "empty", normalized };
  if (new TextEncoder().encode(normalized).byteLength > 128) return { kind: "invalid", normalized, reason: "long" };
  const full = /^cfk-([1-9][0-9]{0,15})$/.exec(normalized);
  const bare = /^[1-9][0-9]{1,15}$/.test(normalized);
  if (full || bare) {
    const prefix = full?.[1] ?? normalized;
    const number = Number(prefix);
    return Number.isSafeInteger(number)
      ? { kind: "number", normalized, prefix, number }
      : { kind: "invalid", normalized, reason: "number" };
  }
  if (/^(?:cfk-|[0-9]+$)/.test(normalized)) return { kind: "invalid", normalized, reason: /^[0-9]$/.test(normalized) ? "short" : "number" };
  return [...normalized].length >= 2
    ? { kind: "title", normalized }
    : { kind: "invalid", normalized, reason: "short" };
}

export function matchesTypedIssueSearch(issue: { number: number; title: string }, query: TypedIssueSearch): boolean {
  if (query.kind === "empty") return true;
  if (query.kind === "number") return String(issue.number).startsWith(query.prefix);
  return query.kind === "title" && issue.title.normalize("NFKC").toLowerCase().includes(query.normalized);
}

export function issueNumberRanges(prefix: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  let low = BigInt(prefix), high = low;
  while (low <= limit) {
    ranges.push([Number(low), Number(high > limit ? limit : high)]);
    low *= 10n;
    high = high * 10n + 9n;
  }
  return ranges;
}
