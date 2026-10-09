import assert from "node:assert/strict";
import test from "node:test";

import { addAcceptVary, prefersMarkdown } from "../../apps/worker/src/kernel/content-negotiation.ts";

test("HTML remains the default for absent, equally preferred and unrelated Accept ranges", () => {
  for (const accept of [null, "", "*/*", "text/*", "text/html", "text/markdown, text/html", "text/html;q=0.7,text/markdown;q=0.7", "application/json", "application/json; profile=\"text/markdown\"", "application/x-example; note=\"other,text/markdown\",text/html"]) {
    assert.equal(prefersMarkdown(accept), false, String(accept));
  }
});

test("Markdown is selected only when its effective quality is positive and exceeds HTML", () => {
  for (const accept of ["text/markdown", "TEXT/MARKDOWN", "text/markdown;q=0.001", "text/html;q=0.5,text/markdown;q=0.8", "text/markdown;q=1.000, text/html;q=0.999", "text/html;q=0,text/*;q=0.8", "text/markdown;q=0.8,*/*;q=0.2", "text/html;q=0,text/markdown;q=0.001"]) {
    assert.equal(prefersMarkdown(accept), true, accept);
  }
  for (const accept of ["text/markdown;q=0", "text/markdown;q=0,text/html;q=0", "text/markdown;q=0.5,text/html;q=0.8", "text/markdown;q=0.5,*/*;q=0.8"]) {
    assert.equal(prefersMarkdown(accept), false, accept);
  }
});

test("specific Accept ranges determine quality before wildcard values", () => {
  const cases = [
    ["text/markdown;q=0, */*;q=1", false],
    ["text/markdown;q=0, text/*;q=1", false],
    ["text/markdown;q=0.2, text/*;q=0.8, */*;q=0.1", false],
    ["text/html;q=0.2, text/*;q=0.8, */*;q=1", true],
    ["text/html;q=0.8,text/*;q=0.2,*/*;q=1", false],
    ["text/html;q=0,text/*;q=0,*/*;q=1", false],
    ["text/markdown;q=0.8,text/*;q=0,*/*;q=1", true],
  ];
  for (const [accept, expected] of cases) assert.equal(prefersMarkdown(accept), expected, accept);
});

test("UTF-8 parameters match the offered representations and refine range precedence", () => {
  const cases = [
    ["text/markdown;charset=utf-8", true],
    ["text/markdown;charset=\"UTF-8\";q=0.8,text/html;q=0.2", true],
    ["text/markdown;q=0.8;charset=utf-8,text/html;q=0.2", true],
    ["text/markdown;q=1,text/markdown;charset=utf-8;q=0,text/html;q=0.5", false],
    ["text/markdown;charset=ascii,text/html;q=0.5", false],
    ["text/markdown;variant=example,text/html;q=0.5", false],
    ["text/markdown;charset=\"utf\\-8\"", true],
  ];
  for (const [accept, expected] of cases) assert.equal(prefersMarkdown(accept), expected, accept);
});

test("malformed weights, invalid types and conflicting duplicates do not enable Markdown", () => {
  for (const accept of ["text/markdown;q=-1", "text/markdown;q=2", "text/markdown;q=.8", "text/markdown;q=0.1234", "text/markdown;q=1.001", "text/markdown;q=\"1\"", "text/markdown;q=NaN", "text/markdown;q=1;q=0", "text/markdown;bad", "*/markdown", "text/markdown-example", "text/markdown;charset=\"utf-8", "text/markdown;q=0,text/markdown;q=1", "text/markdown;q=1,text/markdown;q=0"]) {
    assert.equal(prefersMarkdown(accept), false, accept);
  }
  assert.equal(prefersMarkdown("text/markdown;q=wrong,text/markdown;q=0.8,text/html;q=0.2"), true);
});

test("Vary adds Accept while preserving prior dimensions and wildcard semantics", () => {
  const cases = [[null, "Accept"], ["Accept-Encoding", "Accept-Encoding, Accept"], ["accept-encoding, ACCEPT", "accept-encoding, ACCEPT"], ["*", "*"], ["Accept-Encoding, *", "Accept-Encoding, *"]];
  for (const [value, expected] of cases) {
    const headers = new Headers(value === null ? {} : { vary: value });
    addAcceptVary(headers);
    assert.equal(headers.get("vary"), expected);
    addAcceptVary(headers);
    assert.equal(headers.get("vary"), expected);
  }
});
