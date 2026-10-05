import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  preferredPageLocale, WEB_LAUNCH_PAGE_SCRIPT, webLaunchBootstrapHtml,
  webLaunchPageContentSecurityPolicy, webLaunchUnavailableHtml,
} from "../../apps/worker/src/services/web-auth.ts";
import { getInvitationBootstrapHtml, INVITATION_PAGE_SCRIPT, invitationPageContentSecurityPolicy } from "../../apps/worker/src/services/invitations.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const origin = "https://kanban.example.test";
const principal = (locale = null, is_owner = false) => ({ id: randomUUID(), display_name: "用户 Member", is_owner, locale });
const session = (locale = null, owner = false) => ({ session_id: randomUUID(), principal: principal(locale, owner) });
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

test("HTML entry pages use the highest-priority language and support every Chinese tag", () => {
  for (const language of ["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH_hans_CN"]) assert.equal(preferredPageLocale(language), "zh-CN");
  for (const language of [null, "", "fr-FR,zh-CN;q=0.9", "en-US,zh-TW;q=0.9", "zh-CN;q=0,en;q=0.5", "zh-TW;q=invalid,en", "zhfoo"]) assert.equal(preferredPageLocale(language), "en");
  assert.equal(preferredPageLocale("en;q=0.1,zh-Hant;q=0.8"), "zh-CN");
  assert.equal(preferredPageLocale("fr-FR;q=1,zh-CN;q=1"), "en");
  assert.match(webLaunchBootstrapHtml("zh-TW"), /<html lang="zh-CN">[\s\S]*<noscript>此页面需要 JavaScript/);
  for (const language of ["en-US", "zh-Hant"]) {
    const html = webLaunchUnavailableHtml(language);
    assert.equal((html.match(/<p>/g) ?? []).length, 1);
    assert.match(html, language === "en-US" ? /<html lang="en">[\s\S]*This Browser Launch/ : /<html lang="zh-CN">[\s\S]*此浏览器启动链接已失效/);
    assert.doesNotMatch(html, language === "en-US" ? /此浏览器启动链接已失效/ : /This Browser Launch/);
  }
});

test("entry script CSP hashes retain their restrictive policy", async () => {
  for (const [script, policy] of [[WEB_LAUNCH_PAGE_SCRIPT, await webLaunchPageContentSecurityPolicy()], [INVITATION_PAGE_SCRIPT, await invitationPageContentSecurityPolicy()]]) {
    assert.ok(policy.includes(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`));
    for (const directive of ["default-src 'none'", "base-uri 'none'", "connect-src 'self'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(policy.includes(directive));
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  }
});

async function launchFixture(languages, hasCode = false, serverLocale = "en") {
  const status = { textContent: "" };
  const document = { title: "cfKanban", documentElement: { lang: serverLocale }, querySelector: () => status };
  const calls = [], stored = [], cleaned = [], navigation = [];
  runInNewContext(WEB_LAUNCH_PAGE_SCRIPT, {
    URL, URLSearchParams, crypto, navigator: languages === null ? undefined : { languages, language: languages[0] }, document,
    location: { origin, search: hasCode ? "?code=isolated-launch-capability" : "", replace: path => navigation.push(path) },
    history: { replaceState: (_state, _title, path) => cleaned.push(path) },
    localStorage: { getItem: () => "zh-CN", setItem: (...args) => stored.push(args) },
    fetch: async (path, options) => { calls.push({ path, options }); return response(200, { resource: { entry_path: "/app/issues/CFK-42" } }); },
  });
  await tick();
  return { document, status, calls, stored, cleaned, navigation };
}

test("launch script uses the first browser language, sets HTML lang and never persists automatic selection", async () => {
  for (const [languages, expected] of [[["en-US", "zh-CN"], "en"], [["fr-FR", "zh-TW"], "en"], [["", "zh-TW"], "en"], [["zh_Hant_HK", "en"], "zh-CN"]]) {
    const f = await launchFixture(languages);
    assert.equal(f.document.documentElement.lang, expected);
    assert.match(f.status.textContent, expected === "en" ? /This launch link is invalid/ : /打开链接无效/);
    assert.deepEqual(f.stored, []);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.cleaned, ["/app/launch"]);
  }
  assert.equal((await launchFixture(null, false, "zh-CN")).document.documentElement.lang, "zh-CN");
  const opened = await launchFixture(["zh-TW"], true);
  assert.equal(opened.calls.length, 1);
  assert.equal(opened.calls[0].path, "/api/v1/web-sessions/redeem");
  assert.equal(opened.calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(opened.calls[0].options.body), { launch_code: "isolated-launch-capability" });
  assert.deepEqual(opened.navigation, ["/app/issues/CFK-42"]);
  assert.deepEqual(opened.stored, []);
});

function invitationFixture({ languages = ["en-US"], storedLocale = "zh-CN", sessionResponse = response(200, session()), kind = "project_grant" } = {}) {
  const handlers = {}, calls = [], writes = [];
  const element = () => ({ textContent: "", hidden: false, dataset: {}, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(name, handler) { this[name] = handler; } });
  const elements = Object.fromEntries(["invitation-status", "invitation-accept", "invitation-next", "cfkanban-invitation-metadata"].map(id => [id, element()]));
  elements["cfkanban-invitation-metadata"].textContent = JSON.stringify({ kind, invitation_id: randomUUID(), grants: [] });
  const title = element(), languageNav = element();
  const sections = ["en", "zh-CN"].map(locale => ({ ...element(), dataset: { invitationLocale: locale } }));
  const controls = ["en", "zh-CN"].map(locale => ({ ...element(), dataset: { selectLocale: locale } }));
  const document = { title: "cfKanban Invitation", documentElement: { lang: "en" }, cookie: "", getElementById: id => elements[id], querySelectorAll(selector) {
    return ({ "[data-invitation-title]": [title], "[data-invitation-language]": [languageNav], "[data-invitation-locale]": sections, "[data-select-locale]": controls })[selector] ?? [];
  } };
  runInNewContext(INVITATION_PAGE_SCRIPT, {
    URL, crypto, AbortSignal, navigator: { languages, language: languages[0] }, document,
    location: { href: origin + "/invite?code=isolated-invitation-capability" }, history: { replaceState() {} },
    localStorage: { getItem: () => storedLocale, setItem: (...args) => writes.push(args) },
    fetch: async (path, options) => { calls.push({ path, options }); if (path !== "/api/v1/web-session") assert.fail("bootstrap and locale selection must not redeem or patch"); return sessionResponse; },
  });
  for (const control of controls) handlers[control.dataset.selectLocale] = () => control.click();
  return { document, title, languageNav, sections, elements, calls, writes, select: locale => handlers[locale]() };
}

test("invitation applies an already-read account preference and falls back to system language for null", async () => {
  for (const [saved, languages, guest, expected, owner] of [["en", ["zh-CN"], "zh-CN", "en", false], ["zh-CN", ["en"], "en", "zh-CN", false], [null, ["en", "zh-CN"], "zh-CN", "en", false], [null, ["zh-TW"], "en", "zh-CN", false], ["zh-CN", ["en"], "en", "zh-CN", true]]) {
    const f = invitationFixture({ languages, storedLocale: guest, sessionResponse: response(200, session(saved, owner)) });
    await tick();
    assert.equal(f.document.documentElement.lang, expected);
    assert.equal(f.document.title, expected === "en" ? "cfKanban Invitation" : "cfKanban 邀请");
    assert.equal(f.title.textContent, f.document.title);
    assert.equal(f.languageNav.attrs["aria-label"], expected === "en" ? "Language" : "语言");
    assert.deepEqual(f.sections.filter(section => !section.hidden).map(section => section.dataset.invitationLocale), [expected]);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.writes, []);
    f.select(expected === "en" ? "zh-CN" : "en");
    assert.deepEqual(f.writes, []);
    assert.equal(f.calls.length, 1);
    assert.equal(f.elements["invitation-accept"].hidden, owner);
  }
});

test("invitation saves only an explicit confirmed-guest choice and ignores guest values for an unreadable account", async () => {
  const guest = invitationFixture({ languages: ["zh-TW"], storedLocale: "en", sessionResponse: response(401, {}) });
  await tick();
  assert.equal(guest.document.documentElement.lang, "en");
  assert.deepEqual(guest.writes, []);
  guest.select("zh-CN");
  assert.deepEqual(guest.writes, [["cfkanban_locale", "zh-CN"]]);
  assert.equal(guest.calls.length, 1);
  for (const failure of [response(503, {}), response(200, {})]) {
    const unreadable = invitationFixture({ languages: ["en"], storedLocale: "zh-CN", sessionResponse: failure });
    await tick();
    assert.equal(unreadable.document.documentElement.lang, "en");
    unreadable.select("zh-CN");
    assert.deepEqual(unreadable.writes, []);
  }
  const recovery = invitationFixture({ languages: ["en"], storedLocale: "zh-CN", kind: "principal_recovery" });
  await tick();
  assert.equal(recovery.document.documentElement.lang, "en");
  recovery.select("zh-CN");
  assert.deepEqual(recovery.calls, []);
  assert.deepEqual(recovery.writes, []);
});

test("invitation SSR keeps business names and metadata wire roles while translating public labels", async () => {
  const row = { id: randomUUID(), kind: "project_grant", expires_at: Date.now() + 60000, revoked_at: null, redeemed_at: null, bound_principal_id: null, recovery_mode: null };
  const grant = { project_id: randomUUID(), workspace_id: randomUUID(), workspace_display_name: "Workspace 原文", display_name: "Project 原文", role: "writer" };
  const db = { prepare(sql) { return { bind() { return this; }, first: async () => sql.includes("FROM invitations AS i") ? row : { authorized: 1 }, all: async () => ({ results: [grant] }) }; } };
  const html = await getInvitationBootstrapHtml(db, "isolated-render-capability", Date.now(), "zh_Hant_HK");
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>cfKanban 邀请<\/title>/);
  assert.match(html, /<section data-invitation-locale="zh-CN"><p>[\s\S]*?<h2>目标项目<\/h2>/);
  assert.match(html, /Workspace 原文 \/ Project 原文<\/strong> — 协作者（可读写）/);
  const metadata = JSON.parse(/<script id="cfkanban-invitation-metadata" type="application\/json">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(metadata.grants[0].role, "writer");
  assert.equal(metadata.kind, "project_grant");
  assert.ok(!html.includes("isolated-render-capability"));
});
