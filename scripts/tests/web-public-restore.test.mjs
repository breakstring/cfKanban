import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

test("Owner restore confirmation includes the public summary instead of an unlabeled quota tuple", async () => {
  const owner = await readFile(new URL("../../apps/web/src/views/OwnerView.vue", import.meta.url), "utf8");
  const start = owner.indexOf('<ModalDialog v-if="showRestore');
  const restore = owner.slice(start, owner.indexOf('</ModalDialog>', start));
  assert.match(restore, /PublicJoinRestorePreview|publicProject\.public_summary/);
  assert.doesNotMatch(restore, /resource_limits\.issues }}\/{{/);
});

test("restore preview renders bilingual named quotas, actual usage and escaped public summary", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../../apps/web", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  try {
    const { default: Preview } = await server.ssrLoadModule("/src/components/PublicJoinRestorePreview.vue");
    const project = { id: "fixture", workspace_key: "test", key: "PUBLIC", display_name: "公开测试", public_summary: "<script>alert(1)</script>\n测试摘要", role_choices: ["reader", "writer"], active_usage: { issues: 9, comments: 12, principals: 4 }, resource_limits: { issues: 7, comments: 11, principals: 3 } };
    for (const language of ["zh-CN", "en"]) {
      const html = await renderToString(createSSRApp(Preview, { projects: [project], language }));
      assert.match(html, /test\/PUBLIC/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
      for (const number of [9, 12, 4, 7, 11, 3]) assert(html.includes(`>${number}</td>`));
      for (const label of language === "zh-CN" ? ["公开摘要", "公开角色", "当前用量", "上限", "事项", "评论", "参与者"] : ["Public summary", "Public roles", "Active", "Limit", "Issues", "Comments", "Participants"]) assert(html.includes(label));
    }
    const incomplete = await renderToString(createSSRApp(Preview, { projects: [{ id: "old", key: "OLD" }], language: "en" }));
    assert(incomplete.includes("Unavailable")); assert(incomplete.includes("—")); assert.doesNotMatch(incomplete, />0<\/td>/);
  } finally { await server.close(); }
});
