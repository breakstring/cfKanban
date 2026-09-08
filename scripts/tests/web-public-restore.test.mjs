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
  const server = await createServer({ root: fileURLToPath(new URL("../../apps/web", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { default: Preview } = await server.ssrLoadModule("/src/components/PublicJoinRestorePreview.vue");
    const project = { id: "fixture", workspace_id: "workspace-fixture", workspace_display_name: "测试工作区", display_name: "公开测试", public_summary: "<script>alert(1)</script>\n测试摘要", role_choices: ["reader", "writer"], active_usage: { issues: 9, comments: 12, principals: 4 }, resource_limits: { issues: 7, comments: 11, principals: 3 } };
    for (const language of ["zh-CN", "en"]) {
      const html = await renderToString(createSSRApp(Preview, { projects: [project], language }));
      assert.match(html, /测试工作区 \/ 公开测试/); assert.doesNotMatch(html, /workspace-fixture|>fixture</); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
      for (const number of [9, 12, 4, 7, 11, 3]) assert(html.includes(`>${number}</td>`));
      for (const label of language === "zh-CN" ? ["公开摘要", "公开角色", "当前用量", "上限", "事项", "评论", "参与者"] : ["Public summary", "Public roles", "Active", "Limit", "Issues", "Comments", "Participants"]) assert(html.includes(label));
    }
    const incomplete = await renderToString(createSSRApp(Preview, { projects: [{ id: "old" }], language: "en" }));
    assert(incomplete.includes("Unavailable")); assert(incomplete.includes("—")); assert.doesNotMatch(incomplete, />0<\/td>/);
  } finally { await server.close(); }
});

test("archived same-name targets expose distinct identities without changing confirmation names", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../../apps/web", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { default: Details } = await server.ssrLoadModule("/src/components/ContainerIdentityDetails.vue");
    const { containerChoiceLabels } = await server.ssrLoadModule("/src/lib/container-choice.ts");
    const choices = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"].map(id => ({ id, name: "Same project", workspaceName: "Same workspace" }));
    const labels = containerChoiceLabels(choices);
    assert.notEqual(labels.get(choices[0].id).label, labels.get(choices[1].id).label);
    for (const language of ["en", "zh-CN"]) {
      const outputs = await Promise.all(choices.map(choice => renderToString(createSSRApp(Details, { id: choice.id, language, workspaceId: "33333333-3333-4333-8333-333333333333", workspaceName: choice.workspaceName, context: "<script>notes</script>" }))));
      assert.notEqual(outputs[0], outputs[1]);
      for (let index = 0; index < choices.length; index += 1) {
        assert(outputs[index].includes(choices[index].id));
        assert(outputs[index].includes(language === "en" ? "View object details" : "查看对象详情"));
        assert.match(outputs[index], /&lt;script&gt;notes&lt;\/script&gt;/);
        assert.doesNotMatch(outputs[index], /<details[^>]*\bopen\b/);
      }
    }
    const owner = await readFile(new URL("../../apps/web/src/views/OwnerView.vue", import.meta.url), "utf8");
    assert.match(owner, /confirm_name: purgeName\.value/);
    assert.match(owner, /purgeName\.value !== preview\.target\.display_name/);
    assert.match(owner, /ContainerIdentityDetails :id="purgePreview\.target\.id"/);
  } finally { await server.close(); }
});
