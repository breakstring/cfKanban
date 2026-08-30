function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed, "https://cfkanban.invalid");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "mailto:") {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function inline(value: string): string {
  const token = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(token)) {
    const index = match.index;
    output += escapeHtml(value.slice(cursor, index));
    const raw = match[0];
    if (raw.startsWith("`")) {
      output += `<code>${escapeHtml(raw.slice(1, -1))}</code>`;
    } else if (raw.startsWith("**")) {
      output += `<strong>${escapeHtml(raw.slice(2, -2))}</strong>`;
    } else if (raw.startsWith("*")) {
      output += `<em>${escapeHtml(raw.slice(1, -1))}</em>`;
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      const href = link === null ? null : safeUrl(link[2] ?? "");
      if (link !== null && href !== null) {
        output += `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(link[1] ?? "")}</a>`;
      } else {
        output += escapeHtml(raw);
      }
    }
    cursor = index + raw.length;
  }
  return output + escapeHtml(value.slice(cursor));
}

export function renderMarkdown(source: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let code: string[] | null = null;
  let listOpen = false;

  const closeList = (): void => {
    if (listOpen) output.push("</ul>");
    listOpen = false;
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      if (code === null) {
        code = [];
      } else {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
      closeList();
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item !== null) {
      if (!listOpen) output.push("<ul>");
      listOpen = true;
      output.push(`<li>${inline(item[1] ?? "")}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") {
      continue;
    }
    output.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code !== null) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return output.join("\n");
}
