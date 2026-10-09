const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const quality = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

type MediaRange = { subtype: string; specificity: number; parameters: number; quality: number };

function splitOutsideQuotes(value: string, delimiter: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start).trim());
  return parts;
}

function parameterValue(value: string): string | null {
  if (token.test(value)) return value;
  if (!/^"(?:[\t !#-\[\]-~\x80-\xFF]|\\[\t -~\x80-\xFF])*"$/.test(value)) return null;
  return value.slice(1, -1).replace(/\\([\s\S])/g, "$1");
}

function parseRange(value: string): MediaRange | null {
  const parts = splitOutsideQuotes(value, ";");
  if (!parts) return null;
  const media = parts[0]?.toLowerCase();
  const match = /^(?:text\/(html|markdown|\*)|(\*)\/\*)$/.exec(media ?? "");
  if (!match) return null;
  const subtype = match[1] ?? "*";
  const specificity = match[2] ? 0 : subtype === "*" ? 1 : 2;
  const seen = new Set<string>();
  let weight = 1;
  let parameters = 0;
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator < 1) return null;
    const name = part.slice(0, separator).trim().toLowerCase();
    const rawValue = part.slice(separator + 1).trim();
    if (!token.test(name) || seen.has(name)) return null;
    seen.add(name);
    if (name === "q") {
      if (!quality.test(rawValue)) return null;
      weight = Number(rawValue);
    } else {
      const value = parameterValue(rawValue);
      // Both available representations are UTF-8 and have no other media type parameters.
      if (name !== "charset" || value?.toLowerCase() !== "utf-8") return null;
      parameters++;
    }
  }
  return { subtype, specificity, parameters, quality: weight };
}

function representationQuality(ranges: MediaRange[], subtype: string): number {
  let best: MediaRange | null = null;
  let result = 0;
  for (const range of ranges) {
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    if (!best || range.specificity > best.specificity
      || (range.specificity === best.specificity && range.parameters > best.parameters)) {
      best = range;
      result = range.quality;
    } else if (range.specificity === best.specificity && range.parameters === best.parameters) {
      // Conflicting duplicate ranges must not undo an explicit refusal (q=0).
      result = Math.min(result, range.quality);
    }
  }
  return result;
}

export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const entries = splitOutsideQuotes(accept, ",");
  if (!entries) return false;
  const ranges = entries.map(parseRange).filter((range): range is MediaRange => range !== null);
  const markdown = representationQuality(ranges, "markdown");
  return markdown > 0 && markdown > representationQuality(ranges, "html");
}

export function addAcceptVary(headers: Headers): void {
  const existing = headers.get("vary");
  const fields = existing?.split(",").map(field => field.trim().toLowerCase()) ?? [];
  if (fields.includes("*") || fields.includes("accept")) return;
  headers.set("vary", existing ? `${existing}, Accept` : "Accept");
}
