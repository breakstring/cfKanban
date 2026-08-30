import assert from "node:assert/strict";
import test from "node:test";

import { presentApiProblem } from "../../apps/web/src/lib/error-presentation.ts";
import { resolveLocalePreference } from "../../apps/web/src/lib/locale-preference.ts";
import { renderMarkdown } from "../../apps/web/src/lib/markdown.ts";

function apiError(category, code, requestId = "request-test", retryAfter = null, status = 503) {
  return {
    body: {
      category,
      code,
      message: "Raw server wording must not become UI copy.",
      request_id: requestId,
    },
    retryAfter,
    status,
  };
}

const englishErrors = {
  "error.authorization": "Your current session does not allow this action.",
  "error.businessQuota": "This Project has reached its active quota.",
  "error.capability": "This one-time link is no longer available.",
  "error.conflict": "The issue changed on the server.",
  "error.generic": "This action could not be completed.",
  "error.notFound": "This resource is unavailable.",
  "error.platform": "The service is temporarily unavailable.",
  "error.platformQuota": "Cloudflare platform capacity is unavailable.",
  "error.rate": "Too many requests. Wait before trying again.",
  "error.session": "Your session ended.",
  "error.validation": "Check the highlighted input and try again.",
};

const translate = (key) => englishErrors[key];

test("locale preference uses the saved choice or the browser's first language", () => {
  assert.equal(resolveLocalePreference("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocalePreference("en", ["zh-CN"]), "en");
  assert.equal(resolveLocalePreference(null, ["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveLocalePreference(null, ["zh-Hans-SG"]), "zh-CN");
  assert.equal(resolveLocalePreference(null, ["en-US", "zh-CN"]), "en");
  assert.equal(resolveLocalePreference(null, ["zh-TW"]), "en");
  assert.equal(resolveLocalePreference("invalid", ["fr-FR", "zh-CN"]), "en");
});

test("Markdown rendering escapes raw HTML and unsafe links", () => {
  const rendered = renderMarkdown([
    "# Safe heading",
    "**strong** and *emphasis*",
    "<img src=x onerror=alert(1)>",
    "[unsafe](javascript:alert(1))",
    "[also unsafe](data:text/html,boom)",
    "[safe](https://example.com/path)",
    "```",
    "<script>alert(1)</script>",
    "```",
  ].join("\n"));

  assert.match(rendered, /<h1>Safe heading<\/h1>/);
  assert.match(rendered, /<strong>strong<\/strong> and <em>emphasis<\/em>/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /href="javascript:/);
  assert.doesNotMatch(rendered, /href="data:/);
  assert.match(rendered, /href="https:\/\/example\.com\/path" rel="noreferrer noopener"/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
});

test("Markdown rendering keeps supported structure deterministic", () => {
  assert.equal(
    renderMarkdown("- one\n- `two`\n\nParagraph"),
    "<ul>\n<li>one</li>\n<li><code>two</code></li>\n</ul>\n<p>Paragraph</p>",
  );
});

test("stable API errors become localized UI copy without echoing server messages", () => {
  const english = presentApiProblem(
    apiError("platform_failure", "PLATFORM_UNAVAILABLE", "request-en"),
    "en",
    translate,
  );
  assert.match(english, /temporarily unavailable/);
  assert.match(english, /request-en/);
  assert.doesNotMatch(english, /Raw server wording/);

  const quota = presentApiProblem(
    apiError("business_quota", "PROJECT_ISSUE_LIMIT_REACHED"),
    "zh-CN",
    translate,
  );
  assert.match(quota, /active quota/);
});

test("rate limit recovery includes the verified Retry-After value", () => {
  const limited = apiError("rate_limit", "RATE_LIMITED", "request-rate", 17, 429);
  assert.equal(
    presentApiProblem(limited, "en", translate),
    "Too many requests. Wait before trying again. Try again in 17 seconds.",
  );
});
