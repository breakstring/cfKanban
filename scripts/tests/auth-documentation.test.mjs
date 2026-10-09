import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { authenticationGuideBody } from "../../apps/worker/src/kernel/auth-documentation.ts";
import { RELEASE_VERSION } from "../../apps/worker/src/release-version.ts";

const origin = "https://self-hosted.example.test:9443";

test("auth.md describes existing authentication and permission boundaries in both languages", () => {
  const body = authenticationGuideBody(origin);
  assert.match(body, /^# [^\n]*auth\.md\n/u);
  assert(body.includes(`Release / 发行版本: ${RELEASE_VERSION}`));
  for (const heading of ["## English", "## 简体中文"]) assert(body.includes(heading));
  assert.equal(body.match(/Authorization: Bearer <credential>/gu)?.length, 2);
  assert.match(body, /not OAuth/u);
  assert.match(body, /不是 OAuth/u);
  assert.match(body, /no separate registration that creates a Credential with zero Project permissions/u);
  assert.match(body, /不提供独立注册后获得零项目权限凭据的接口/u);
  assert.match(body, /Authentication identifies a Principal; it does not grant access to arbitrary Projects/u);
  assert.match(body, /项目角色（`reader` 或 `writer`）及管理权限在每次操作时独立检查/u);
  assert.match(body, /passive discovery must not POST or create an account/u);
  assert.match(body, /被动发现不得发起 POST 或创建账号/u);
  assert.match(body, /private local storage/u);
  assert.match(body, /不要索取或输出明文凭据/u);
  assert.match(body, /secure Browser Launch/u);
  assert.match(body, /恢复保留原身份，不是注册/u);
  assert.doesNotMatch(body, /cfk_v1_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43,512}/u);
  assert.doesNotMatch(body, /\/oauth-protected-resource|\/oauth-authorization-server|\/agent\/auth/u);
});

test("documented provisioning methods match OpenAPI rather than inventing registration", async () => {
  const body = authenticationGuideBody(origin);
  const openapi = JSON.parse(await readFile(new URL("../../contracts/openapi.json", import.meta.url), "utf8"));
  for (const path of ["/api/v1/me", "/api/v1/meta"]) {
    assert(openapi.paths[path].get.security.some(item => item.BearerCredential));
    assert(body.includes(`GET ${path}`));
  }
  for (const path of ["/api/v1/invitations/redeem", "/api/v1/public-joins/{public_id}/redeem"]) {
    const operation = openapi.paths[path].post;
    assert(operation.parameters.some(item => item.$ref === "#/components/parameters/IdempotencyKey"));
    const schemaName = operation.requestBody.content["application/json"].schema.$ref.split("/").at(-1);
    const modes = openapi.components.schemas[schemaName].oneOf;
    for (const mode of ["new_principal", "current_principal"]) {
      assert(modes.some(schema => schema.properties.redeem_as.const === mode));
      assert(body.includes(mode));
    }
    const newPrincipal = modes.find(schema => schema.properties.redeem_as.const === "new_principal");
    for (const field of ["display_name", "new_credential_token"]) {
      assert(newPrincipal.required.includes(field));
      assert(body.includes(field));
    }
    assert(body.includes(`${origin}${path}`));
  }
  assert.match(body, /`credential prepare`, `invite redeem`, and `public-join redeem`/u);
  assert.match(body, /`Idempotency-Key`/u);
});

test("authentication guide links stay at the supplied origin except official installation guides", async () => {
  const body = authenticationGuideBody(origin);
  const links = [...body.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]);
  const external = links.filter(link => new URL(link).origin !== origin);
  assert.deepEqual(external, [
    "https://github.com/breakstring/cfKanban/releases/latest/download/install.md",
    "https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md",
  ]);
  const catalog = JSON.parse(await readFile(new URL("../../apps/docs/catalog.json", import.meta.url), "utf8"));
  const documentedPaths = catalog.flatMap(group => group.pages.map(page => page.path.replace(/\/index$/u, "/")));
  for (const locale of ["en", "zh-CN"]) {
    for (const path of ["usage/access", "administration/devices", "deployment/recovery"]) {
      assert(documentedPaths.includes(path), path);
      assert(links.includes(`${origin}/docs/${locale}/${path}`));
    }
  }
  for (const path of ["/openapi.json", "/.well-known/api-catalog", "/.well-known/agent-skills/index.json", "/llms.txt"]) {
    assert(links.includes(`${origin}${path}`));
  }
  assert.doesNotMatch(body, /cfkanban\.dev|\/agent\/auth/u);
});
