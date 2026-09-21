import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { listProjectMemberCandidates } from "../../apps/worker/src/services/scoped-administrators.ts";
import { managedWorkspaceIds, projectDisplayRole } from "../../apps/web/src/lib/scoped-management.ts";

const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = { id: crypto.randomUUID(), token: `cfk_v1_scopeowner_${"A".repeat(43)}` };
let db;
async function call(actor, path, method = "GET", body, key = crypto.randomUUID()) {
  const headers = { "content-type": "application/json", "idempotency-key": key,
    ...(actor?.token ? { authorization: `Bearer ${actor.token}` } : actor?.headers ?? {}) };
  const response = await server.fetch(`https://kanban.example.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function ok(response) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.resource ?? response.body; }
async function person(name) {
  const id = crypto.randomUUID();
  const prefix = id.replaceAll("-", "");
  const token = `cfk_v1_${prefix}_${"B".repeat(43)}`;
  await db.batch([
    db.prepare("INSERT INTO principals (id,display_name,display_name_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)").bind(id, name, name.toLowerCase(), Date.now()),
    db.prepare("INSERT INTO credentials (id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(crypto.randomUUID(), id, prefix, await sha256Hex(token), Date.now(), crypto.randomUUID()),
  ]);
  return { id, token };
}
async function workspace(name) {
  const w = ok(await call(owner, "/api/v1/workspaces", "POST", { display_name: name }));
  return { ...w, path: `/api/v1/workspaces/${w.id}` };
}
async function project(w, name, actor = owner) {
  const p = ok(await call(actor, `${w.path}/projects`, "POST", { display_name: name }));
  return { ...p, path: `${w.path}/projects/${p.id}` };
}
async function grant(target, member, actor = owner, expectedVersion = 0, key) {
  return call(actor, `${target.path}/administrators`, "POST", { principal_id: member.id, expected_version: expectedVersion }, key);
}
async function revoke(target, grant, actor = owner, key) {
  return call(actor, `${target.path}/administrators/${grant.id}?expected_version=${grant.version}`, "DELETE", undefined, key);
}
async function session(actor, target) {
  const launch = ok(await call(actor, "/api/v1/web-launches", "POST", { target }));
  const exchange = await call(null, "/api/v1/web-sessions/redeem", "POST", { launch_code: new URL(launch.launch_url).searchParams.get("code") });
  ok(exchange);
  const cookies = exchange.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
  const csrf = /cfkanban_csrf=([^;]+)/.exec(cookies)?.[1];
  return { headers: { cookie: cookies, origin: "https://kanban.example.test", "x-csrf-token": csrf }, resource: exchange.body.resource };
}
before(async () => {
  await server.listen(); await server.getWorker().applyD1Migrations("DB"); ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: crypto.randomUUID(), operationId: crypto.randomUUID(), ownerPrincipalId: owner.id,
    ownerCredentialId: crypto.randomUUID(), ownerCredentialToken: owner.token, ownerDisplayName: "Scoped_Owner", preferredApiOrigin: "https://kanban.example.test" });
});
after(async () => server.close());

test("固定 Project 和 Issue 会话展示继承管理员身份但不扩大管理范围", async () => {
  const w = await workspace("FixedRoleWorkspace");
  const p = await project(w, "FixedRoleProject");
  const sibling = await project(w, "FixedRoleSibling");
  const hidden = await workspace("FixedRoleHidden");
  const lead = await person("FixedRoleLead");
  const inherited = ok(await grant(w, lead));
  const direct = ok(await grant(p, lead));
  ok(await grant(sibling, lead));
  ok(await grant(hidden, lead));
  ok(await call(owner, `/api/v1/admin/projects/${p.id}/grants`, "POST", { principal_id: lead.id, role: "writer" }));
  const issue = ok(await call(owner, `${p.path}/issues`, "POST", { title: "Fixed role issue" }));
  const fixedSessions = [];
  for (const kind of ["project", "issue"]) {
    const target = { kind, workspace_id: w.id, project_id: p.id,
      ...(kind === "issue" ? { identifier: issue.identifier, issue_id: issue.id } : {}),
      entry_path: kind === "issue" ? `/app/issues/${issue.identifier}` : `/app/w/${w.id}/p/${p.id}` };
    const fixed = await session(lead, kind === "issue" ? { kind, identifier: issue.identifier } : { kind, workspace_id: w.id, project_id: p.id });
    // 新 Launch 默认使用 project_selection；在隔离数据库中还原仍受支持的旧固定会话。
    await db.prepare("UPDATE web_sessions SET target_kind=?1, target_json=?2 WHERE id=?3")
      .bind(kind, JSON.stringify(target), fixed.resource.session_id).run();
    fixedSessions.push(fixed);
    const view = ok(await call(fixed, "/api/v1/web-session"));
    assert.equal(view.allowed_scope.kind, "project");
    assert.deepEqual(view.allowed_scope.projects.map(item => item.project_id), [p.id]);
    assert.deepEqual(view.management_grants.map(item => item.id).sort(), [inherited.id, direct.id].sort());
    const source = view.management_grants.find(item => item.id === inherited.id);
    assert.equal(source.project_id, null);
    assert.equal(source.role, "workspace_admin");
    assert.deepEqual(source.allowed_actions, ["read"]);
    assert.equal(projectDisplayRole(view, view.allowed_scope.projects[0]), "workspace_admin");
    assert.deepEqual(managedWorkspaceIds(view), []);
    assert.ok(ok(await call(fixed, p.path)).allowed_actions.includes("manage_members"));
    assert.equal((await call(fixed, `${w.path}/administrators`)).status, 403);
    assert.equal((await call(fixed, `${w.path}/projects`, "POST", { display_name: "Denied" })).status, 403);
    assert.equal((await call(fixed, sibling.path)).status, 404);
    assert.equal((await call(fixed, `${sibling.path}/administrators`)).status, 403);
    assert.equal((await call(fixed, hidden.path)).status, 404);
  }
  ok(await revoke(w, inherited));
  for (const fixed of fixedSessions) {
    const view = ok(await call(fixed, "/api/v1/web-session"));
    assert.deepEqual(view.management_grants.map(item => item.id), [direct.id]);
    assert.equal(projectDisplayRole(view, view.allowed_scope.projects[0]), "project_admin");
  }
  ok(await revoke(p, direct));
  for (const fixed of fixedSessions) {
    const view = ok(await call(fixed, "/api/v1/web-session"));
    assert.deepEqual(view.management_grants, []);
    assert.equal(projectDisplayRole(view, view.allowed_scope.projects[0]), "writer");
    assert.equal((await call(fixed, `${p.path}/administrators`)).status, 403);
  }
});

test("普通成员候选按项目可见范围搜索分页，排除直接成员并保留独立授权和重新授予", async () => {
  const w = await workspace("MemberCandidateWorkspace");
  const p = await project(w, "MemberCandidateProject");
  const sibling = await project(w, "MemberCandidateSibling");
  const hidden = await project(await workspace("MemberCandidateHidden"), "Hidden");
  const lead = await person("MemberLead");
  const admin = await person("MemberAdmin");
  const reader = await person("MemberReader");
  const writer = await person("MemberWriter");
  const former = await person("MemberFormer");
  const formerAdmin = await person("MemberFormerAdmin");
  const siblingMember = await person("MemberSibling");
  const hiddenMember = await person("MemberHidden");
  const stranger = await person("MemberStranger");
  const leadGrant = ok(await grant(w, lead));
  ok(await grant(p, admin));
  ok(await revoke(p, ok(await grant(p, formerAdmin))));
  for (const [target, actor, role] of [[p,reader,"reader"],[p,writer,"writer"],[sibling,siblingMember,"reader"],[hidden,hiddenMember,"writer"]]) {
    ok(await call(owner, `/api/v1/admin/projects/${target.id}/grants`, "POST", { principal_id: actor.id, role }));
  }
  const direct = ok(await call(owner, `/api/v1/admin/projects/${p.id}/grants`, "POST", { principal_id: former.id, role: "reader" }));
  ok(await call(owner, `/api/v1/admin/grants/${direct.id}?expected_version=${direct.version}`, "DELETE"));
  const path = `${p.path}/member-candidates`;
  const scoped = ok(await call(admin, `${path}?limit=100`)).items;
  assert.deepEqual(scoped.map(item => item.principal_id).sort(), [lead.id,admin.id,former.id,formerAdmin.id].sort());
  for (const item of scoped) assert.deepEqual(Object.keys(item).sort(), ["display_name", "principal_id"]);
  assert.deepEqual(ok(await call(lead, `${path}?limit=100`)).items, scoped);
  const all = ok(await call(owner, `${path}?q=Member&limit=100`)).items;
  for (const excluded of [owner, reader, writer]) assert.ok(!all.some(item => item.principal_id === excluded.id));
  for (const included of [lead,admin,former,formerAdmin,siblingMember,hiddenMember,stranger]) assert.ok(all.some(item => item.principal_id === included.id));
  const first = ok(await call(admin, `${path}?limit=1`));
  assert.equal(first.items.length, 1); assert.equal(first.has_more, true);
  let cursor = first.next_cursor;
  const paged = [...first.items];
  while (cursor) {
    const page = ok(await call(admin, `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`));
    paged.push(...page.items); cursor = page.next_cursor;
  }
  assert.deepEqual(paged, scoped);
  assert.equal((await call(admin, `${path}?q=former&cursor=${encodeURIComponent(first.next_cursor)}`)).status, 409);
  const search = ok(await call(admin, `${path}?q=${encodeURIComponent("  ＦＯＲＭＥＲ  ")}`));
  assert.deepEqual(search.items.map(item => item.principal_id).sort(), [former.id,formerAdmin.id].sort());
  assert.equal(ok(await call(admin, `${path}?q=%25`)).items.length, 0);
  assert.equal((await call(admin, `${path}?q=${"a".repeat(101)}`)).status, 400);
  assert.equal((await call(writer, path)).status, 403);
  assert.equal((await call(reader, path)).status, 403);
  assert.equal((await call(admin, `${sibling.path}/member-candidates`)).status, 403);
  assert.equal((await call(lead, `${hidden.path}/member-candidates`)).status, 403);
  const narrowOwner = await session(owner, { kind: "workspace", workspace_id: w.id });
  assert.deepEqual(ok(await call(narrowOwner, `${path}?limit=100`)).items, scoped);
  const fixed = await session(lead, { kind: "project", workspace_id: w.id, project_id: p.id });
  await db.prepare("UPDATE web_sessions SET target_kind='project', target_json=?1 WHERE id=?2")
    .bind(JSON.stringify({ kind: "project", workspace_id: w.id, project_id: p.id, entry_path: `/app/w/${w.id}/p/${p.id}` }), fixed.resource.session_id).run();
  assert.deepEqual(ok(await call(fixed, `${path}?limit=100`)).items, scoped);
  assert.equal((await call(fixed, `${sibling.path}/member-candidates`)).status, 403);
  ok(await call(admin, `/api/v1/admin/projects/${p.id}/grants`, "POST", { principal_id: former.id, role: "writer" }));
  ok(await call(admin, `/api/v1/admin/projects/${p.id}/grants`, "POST", { principal_id: lead.id, role: "reader" }));
  const after = ok(await call(admin, `${path}?limit=100`)).items;
  assert.deepEqual(after.map(item => item.principal_id).sort(), [admin.id,formerAdmin.id].sort());
  ok(await revoke(w, leadGrant));
  assert.equal((await call(lead, path)).status, 403);
});

test("成员候选查询在初始鉴权后并发撤权也不读取人员数据", async () => {
  const w = await workspace("MemberCandidateRace");
  const p = await project(w, "Race");
  const admin = await person("MemberRaceAdmin");
  const administrator = ok(await grant(p, admin));
  const auth = await authenticateBearer(db, `Bearer ${admin.token}`);
  let rawRows;
  function wrapStatement(statement) {
    return new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values) => wrapStatement(target.bind(...values));
      if (property === "all") return async () => {
        ok(await revoke(p, administrator));
        const result = await target.all(); rawRows = result.results; return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const raced = new Proxy(db, { get(target, property) {
    if (property === "prepare") return sql => {
      const statement = target.prepare(sql);
      return sql.includes("SELECT p.id AS principal_id, p.display_name") ? wrapStatement(statement) : statement;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(listProjectMemberCandidates(raced, auth, { workspaceId: w.id, projectId: p.id },
    new URL(`https://kanban.example.test${p.path}/member-candidates`), Date.now()), error => [403,404].includes(error.status));
  assert.deepEqual(rawRows, []);
});

test("administrator CRUD enforces hierarchy, independent grants, data capabilities, CAS and current replay authorization", async () => {
  const w = await workspace("Hierarchy");
  const outside = await workspace("Outside");
  const a = await person("WorkspaceLead");
  const b = await person("ProjectLead");
  const c = await person("OrdinaryWriter");
  const key = crypto.randomUUID();
  const wa = ok(await grant(w, a, owner, 0, key));
  assert.equal((await grant(w, a, owner, 0, key)).body.idempotent_replay, true);
  assert.equal((await grant(w, a)).status, 409);
  assert.equal((await grant(w, b, a)).status, 403);
  assert.equal((await grant(w, owner)).status, 403);
  const p = await project(w, "Future", a);
  const other = await project(outside, "Hidden");
  const pb = ok(await grant(p, b, a));
  assert.equal(ok(await call(b, "/api/v1/me")).management_grants[0].id, pb.id);
  assert.equal(ok(await call(a, "/api/v1/me")).is_owner, false);
  assert.equal(ok(await call(b, `${p.path}/administrators`)).items[0].allowed_actions.join(), "read");
  assert.equal((await grant(p, c, b)).status, 403);
  assert.equal((await grant(other, c, a)).status, 403);
  for (const path of ["/api/v1/admin/principals", "/api/v1/admin/audit-events", "/api/v1/admin/rate-limit-settings"]) {
    assert.equal((await call(b, path)).status, 403, path);
  }
  const direct = ok(await call(a, `/api/v1/admin/projects/${p.id}/grants`, "POST", { principal_id: b.id, role: "reader" }));
  const members = ok(await call(a, `${p.path}/members`));
  assert.equal(members.items.find((item) => item.principal_id === b.id).sources.length, 2);
  const created = ok(await call(b, `${p.path}/issues`, "POST", { title: "Admin can write", assignee_principal_id: a.id }));
  assert.equal((await call(b, `${other.path}/issues`)).status, 404);
  assert.equal(ok(await call(a, `/api/v1/issues/${created.identifier}`)).assignee.available, true);
  const audit = await db.prepare("SELECT authorized_via,administrator_grant_id FROM events WHERE subject_id=?1 AND type='issue.created'").bind(created.id).first();
  assert.deepEqual(audit, { authorized_via: "project_admin", administrator_grant_id: pb.id });
  const revoked = ok(await revoke(p, pb, a));
  assert.equal(revoked.version, 2);
  assert.equal((await call(b, `${p.path}/members`)).status, 403);
  assert.equal((await call(b, `${p.path}/issues`, "POST", { title: "Reader cannot write" })).status, 403);
  assert.equal(ok(await call(b, `/api/v1/issues/${created.identifier}`)).identifier, created.identifier);
  const paAgain = ok(await grant(p, b, a, revoked.version));
  assert.notEqual(paAgain.generation, pb.generation);
  assert.equal((await revoke(p, pb, a)).status, 409);
  ok(await call(a, `/api/v1/admin/grants/${direct.id}?expected_version=${direct.version}`, "DELETE"));
  assert.equal(ok(await call(b, `${p.path}/issues`)).items.length, 1);
  const commandKey = crypto.randomUUID();
  ok(await grant(p, c, a, 0, commandKey));
  ok(await revoke(w, wa));
  assert.equal((await grant(p, c, a, 0, commandKey)).status, 403);
  assert.equal(ok(await call(b, `/api/v1/issues/${created.identifier}`)).assignee.available, false);
});

test("workspace grant capacity is atomic across projects and counts the union of independent authorization sources", async () => {
  const w = await workspace("Capacity");
  const p = await project(w, "Room");
  const q = await project(w, "Full");
  const a = await person("CapacityAdmin");
  const b = await person("ExistingMember");
  ok(await call(owner, `/api/v1/admin/projects/${q.id}/grants`, "POST", { principal_id: b.id, role: "reader" }));
  for (const target of [p, q]) ok(await call(owner, `/api/v1/admin/projects/${target.id}/public-join`, "PUT", {
    expected_version: target.version, public_summary: "Capacity test", issue_limit: 10, comment_limit: 10, principal_limit: 1,
  }));
  const failed = await grant(w, a);
  assert.equal(failed.status, 409, JSON.stringify(failed.body));
  assert.equal(failed.body.code, "PROJECT_PRINCIPAL_LIMIT_REACHED");
  assert.equal(ok(await call(owner, `${w.path}/administrators`)).items.length, 0);
  assert.deepEqual((await db.prepare("SELECT active_principal_count FROM project_usage WHERE project_id IN (?1,?2) ORDER BY active_principal_count").bind(p.id,q.id).all()).results.map((r) => r.active_principal_count), [0,1]);
  const wb = ok(await grant(w, b));
  const pb = ok(await grant(p, b));
  const usage = async () => (await db.prepare("SELECT active_principal_count FROM project_usage WHERE project_id=?1").bind(p.id).first()).active_principal_count;
  assert.equal(await usage(), 1);
  ok(await revoke(w, wb));
  assert.equal(await usage(), 1);
  ok(await revoke(p, pb));
  assert.equal(await usage(), 0);
  const c = await person("ConcurrentA");
  const d = await person("ConcurrentB");
  const concurrent = await Promise.all([grant(p, c), grant(p, d)]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200,409]);
  assert.equal(await usage(), 1);
});

test("workspace Browser Launch supports empty workspaces and respects Owner workspace scope", async () => {
  const w = await workspace("EmptySession");
  const hidden = await workspace("OtherSession");
  const a = await person("SessionManager");
  const grantA = ok(await grant(w, a));
  const s = await session(a, { kind: "workspace", workspace_id: w.id });
  assert.equal(s.resource.entry_path, `/app/manage?workspace=${w.id}`);
  const view = ok(await call(s, "/api/v1/web-session"));
  assert.equal(view.allowed_scope.kind, "project_selection");
  assert.equal(view.management_grants[0].id, grantA.id);
  assert.equal(ok(await call(s, w.path)).allowed_actions.includes("create_project"), true);
  assert.equal((await call(s, hidden.path)).status, 404);
  const os = await session(owner, { kind: "workspace", workspace_id: w.id });
  const ownerView = ok(await call(os, "/api/v1/web-session"));
  assert.equal(ownerView.allowed_scope.kind, "workspace");
  assert.equal((await call(os, "/api/v1/admin/principals")).status, 403);
  assert.equal((await call(os, hidden.path)).status, 404);
  const p = await project(w, "FixedOwner");
  const hiddenProject = await project(hidden, "HiddenProject");
  const ownedIssue = ok(await call(os, `${p.path}/issues`, "POST", { title: "Scoped Owner write" }));
  assert.equal(ok(await call(os, `/api/v1/issues/${ownedIssue.identifier}`)).identifier, ownedIssue.identifier);
  const hiddenIssue = ok(await call(owner, `${hiddenProject.path}/issues`, "POST", { title: "Hidden deleted issue" }));
  ok(await call(owner, `/api/v1/issues/${hiddenIssue.identifier}?expected_version=${hiddenIssue.version}`, "DELETE"));
  assert.equal((await call(os, `/api/v1/issues/${hiddenIssue.identifier}?deleted=only`)).status, 404);
  assert.ok(!ok(await call(os, "/api/v1/issues?deleted=only")).items.some((item) => item.identifier === hiddenIssue.identifier));
  assert.equal((await call(os, `${hiddenProject.path}/issues`, "POST", { title: "Out of scope" })).status, 404);
  const fixed = await session(owner, { kind: "project", workspace_id: w.id, project_id: p.id });
  assert.equal((await call(fixed, `${p.path}/administrators`)).status, 403);
  ok(await revoke(w, grantA));
  assert.equal((await call(s, w.path)).status, 404);
  assert.deepEqual(ok(await call(s, "/api/v1/web-session")).management_grants, []);
});

test("administrator candidates filter existing access before pagination and preserve scope, search and regrant CAS", async () => {
  const w = await workspace("CandidateWorkspace");
  const p = await project(w, "CandidateProject");
  const sibling = await project(w, "CandidateSibling");
  const hidden = await workspace("CandidateHidden");
  const hiddenProject = await project(hidden, "CandidateHiddenProject");
  const lead = await person("CandidateLead");
  const admin = await person("CandidateAdmin");
  const reader = await person("CandidateReader");
  const writer = await person("CandidateWriter");
  const former = await person("CandidateFormer");
  const outside = await person("CandidateOutside");
  const siblingMember = await person("CandidateSiblingMember");
  const wa = ok(await grant(w, lead));
  ok(await grant(p, admin));
  const revoked = ok(await revoke(p, ok(await grant(p, former))));
  for (const [target, member, role] of [[p,reader,"reader"],[p,writer,"writer"],[hiddenProject,outside,"writer"],[sibling,siblingMember,"reader"]]) {
    ok(await call(owner, `/api/v1/admin/projects/${target.id}/grants`, "POST", { principal_id: member.id, role }));
  }
  const path = `${p.path}/administrator-candidates`;
  const all = ok(await call(owner, `${path}?q=Candidate&limit=100`)).items;
  for (const excluded of [owner, lead, admin]) assert.ok(!all.some(item => item.principal_id === excluded.id));
  for (const included of [reader,writer,former,outside,siblingMember]) assert.ok(all.some(item => item.principal_id === included.id));
  assert.equal(all.find(item => item.principal_id === former.id).expected_version, revoked.version);
  const scoped = ok(await call(lead, `${path}?limit=100`)).items;
  assert.deepEqual(scoped.map(item => item.principal_id).sort(), [reader.id,writer.id,former.id].sort());
  const first = ok(await call(lead, `${path}?limit=1`));
  assert.equal(first.items.length, 1); assert.equal(first.has_more, true);
  let cursor = first.next_cursor;
  const paged = [...first.items];
  while (cursor) {
    const page = ok(await call(lead, `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`));
    paged.push(...page.items); cursor = page.next_cursor;
  }
  assert.deepEqual(paged.map(item => item.principal_id).sort(), scoped.map(item => item.principal_id).sort());
  assert.equal((await call(lead, `${path}?q=reader&cursor=${encodeURIComponent(first.next_cursor)}`)).status, 409);
  const search = ok(await call(lead, `${path}?q=%EF%BC%B2%EF%BC%A5%EF%BC%A1%EF%BC%A4%EF%BC%A5%EF%BC%B2`));
  assert.deepEqual(search.items.map(item => item.principal_id), [reader.id]);
  assert.equal(ok(await call(lead, `${path}?q=%25`)).items.length, 0);
  assert.equal((await call(lead, `${path}?q=${"a".repeat(101)}`)).status, 400);
  assert.equal((await call(admin, path)).status, 403);
  assert.equal((await call(reader, path)).status, 403);
  assert.equal((await call(lead, `${w.path}/administrator-candidates`)).status, 403);
  assert.equal((await call(lead, `${hiddenProject.path}/administrator-candidates`)).status, 403);
  const narrowOwner = await session(owner, { kind: "workspace", workspace_id: w.id });
  const narrowCandidates = ok(await call(narrowOwner, `${w.path}/administrator-candidates?limit=100`)).items;
  assert.ok(!narrowCandidates.some(item => [outside.id,lead.id].includes(item.principal_id)));
  for (const included of [reader,writer,admin,siblingMember]) assert.ok(narrowCandidates.some(item => item.principal_id === included.id));
  assert.ok(!ok(await call(narrowOwner, `${path}?limit=100`)).items.some(item => item.principal_id === siblingMember.id));
  assert.equal((await call(narrowOwner, `${hidden.path}/administrator-candidates`)).status, 403);
  const projectSession = await session(lead, { kind: "project", workspace_id: w.id, project_id: p.id });
  assert.deepEqual(ok(await call(projectSession, `${path}?limit=100`)).items, scoped);
  assert.equal((await call(projectSession, `${sibling.path}/administrator-candidates`)).status, 200);
  await db.prepare("UPDATE web_sessions SET target_kind='project', target_json=?1 WHERE id=?2")
    .bind(JSON.stringify({ kind: "project", workspace_id: w.id, project_id: p.id, entry_path: `/app/w/${w.id}/p/${p.id}` }), projectSession.resource.session_id).run();
  assert.deepEqual(ok(await call(projectSession, `${path}?limit=100`)).items, scoped);
  assert.equal((await call(projectSession, `${sibling.path}/administrator-candidates`)).status, 403);
  const restored = ok(await grant(p, former, lead, revoked.version));
  assert.equal(restored.version, revoked.version + 1);
  assert.ok(!ok(await call(lead, `${path}?limit=100`)).items.some(item => item.principal_id === former.id));
  assert.equal((await grant(p, former, lead, revoked.version)).status, 409);
  ok(await revoke(w, wa));
  assert.equal((await call(lead, `${path}?cursor=${encodeURIComponent(first.next_cursor)}`)).status, 403);
});
