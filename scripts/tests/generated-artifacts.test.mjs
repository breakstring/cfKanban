import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeLineEndings,
  sha256NormalizedText,
  syncGeneratedFile,
} from "../lib/generated-artifacts.mjs";

test("normalizes migration line endings before hashing", () => {
  assert.equal(normalizeLineEndings("one\r\ntwo\rthree\n"), "one\ntwo\nthree\n");
  assert.equal(sha256NormalizedText("one\r\ntwo\n"), sha256NormalizedText("one\ntwo\n"));
});

test("accepts line-ending-only differences while rejecting generated drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfkanban-generated-test-"));
  const target = join(root, "artifact.json");

  try {
    await writeFile(target, "{\r\n  \"stable\": true\r\n}\r\n", "utf8");
    await syncGeneratedFile(target, "{\n  \"stable\": true\n}\n", { mode: "check" });

    await writeFile(target, "{\n  \"stable\": false\n}\n", "utf8");
    await assert.rejects(
      syncGeneratedFile(target, "{\n  \"stable\": true\n}\n", { mode: "check" }),
      /Generated artifact drift detected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAPI models Invitation create and redeem requests as discriminated unions", async () => {
  const document = JSON.parse(await readFile(
    new URL("../../contracts/openapi.json", import.meta.url),
    "utf8",
  ));
  const createBranches = document.components.schemas.CreateInvitationRequest.oneOf;
  assert.equal(createBranches.length, 2);
  assert.deepEqual(createBranches.map((branch) => branch.properties.kind.const), [
    "project_grant",
    "principal_recovery",
  ]);
  assert.deepEqual(createBranches.map((branch) => branch.required), [
    ["kind", "grants"],
    ["kind", "principal_id", "recovery_mode"],
  ]);
  assert.equal(createBranches[0].properties.grants["x-cfkanban-unique-by"], "project_id");

  const redeemBranches = document.components.schemas.RedeemInvitationRequest.oneOf;
  assert.equal(redeemBranches.length, 3);
  assert.deepEqual(redeemBranches.map((branch) => branch.properties.redeem_as.const), [
    "new_principal",
    "current_principal",
    "recovery",
  ]);
  assert.equal(redeemBranches.every((branch) => branch.additionalProperties === false), true);

  assert.equal(
    document.paths["/api/v1/admin/invitations"].post
      .responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/InvitationCreateWriteResult",
  );
  assert.equal(
    document.paths["/api/v1/invitations/redeem"].post
      .responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/InvitationRedemptionWriteResult",
  );
  assert.deepEqual(
    document.components.schemas.InvitationCreateResource.oneOf
      .map((branch) => branch.properties.secret_available.const),
    [true, false],
  );
  assert.deepEqual(
    document.components.schemas.InvitationRedemptionResource.properties.results.items
      .properties.outcome.enum,
    ["created", "regranted", "already_has_access"],
  );
});

test("OpenAPI fixes Public Join request unions, projections, and rate settings", async () => {
  const document = JSON.parse(await readFile(
    new URL("../../contracts/openapi.json", import.meta.url),
    "utf8",
  ));
  const redeemBranches = document.components.schemas.RedeemPublicJoinRequest.oneOf;
  assert.deepEqual(redeemBranches.map((branch) => branch.properties.redeem_as.const), [
    "new_principal",
    "current_principal",
  ]);
  assert.deepEqual(redeemBranches.map((branch) => branch.required), [
    ["display_name", "new_credential_token", "redeem_as", "role"],
    ["redeem_as", "role"],
  ]);
  assert.equal(redeemBranches.every((branch) => branch.additionalProperties === false), true);

  assert.equal(document.components.schemas.PublicProject.additionalProperties, false);
  assert.deepEqual(document.components.schemas.PublicProject.required, [
    "display_name",
    "public_id",
    "public_summary",
    "role_choices",
  ]);
  assert.equal(
    document.paths["/api/v1/public-projects"].get.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/PublicProjectListResult",
  );
  assert.equal(
    document.paths["/api/v1/public-joins/{public_id}/redeem"].post.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/PublicJoinRedemptionWriteResult",
  );
  assert.deepEqual(
    document.components.schemas.PublicJoinRedemptionResource.properties.outcome.enum,
    ["already_has_access", "created", "promoted", "regranted"],
  );
  assert.equal(
    document.paths["/api/v1/admin/rate-limit-settings"].get.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/RateLimitSettings",
  );
  assert.equal(
    document.components.schemas.RateLimitSettings.properties.recent_429_summary.properties
      .observation_scope.const,
    "worker_isolate_best_effort",
  );
});

test("OpenAPI exposes exact Workspace and Project lifecycle response models", async () => {
  const document = JSON.parse(await readFile(
    new URL("../../contracts/openapi.json", import.meta.url),
    "utf8",
  ));
  const responseRef = (path, method) => document.paths[path][method]
    .responses["200"].content["application/json"].schema;
  assert.deepEqual(responseRef("/api/v1/workspaces", "get"), {
    $ref: "#/components/schemas/WorkspaceListResult",
  });
  assert.deepEqual(responseRef("/api/v1/workspaces/{workspace_key}", "get").oneOf, [
    { $ref: "#/components/schemas/WorkspaceActive" },
    { $ref: "#/components/schemas/WorkspaceTombstoneDetail" },
  ]);
  assert.deepEqual(responseRef("/api/v1/workspaces/{workspace_key}/commands/restore", "post"), {
    $ref: "#/components/schemas/WorkspaceRestoredWriteResult",
  });
  assert.deepEqual(responseRef("/api/v1/workspaces/{workspace_key}/projects", "get"), {
    $ref: "#/components/schemas/ProjectListResult",
  });
  assert.deepEqual(
    responseRef("/api/v1/workspaces/{workspace_key}/projects/{project_key}", "get").oneOf,
    [
      { $ref: "#/components/schemas/ProjectActiveRead" },
      { $ref: "#/components/schemas/ProjectTombstoneRead" },
    ],
  );
  assert.deepEqual(
    responseRef("/api/v1/workspaces/{workspace_key}/projects/{project_key}/commands/restore", "post"),
    { $ref: "#/components/schemas/ProjectRestoredWriteResult" },
  );
  for (const schemaName of [
    "WorkspaceActive",
    "WorkspaceTombstone",
    "WorkspaceTombstoneDetail",
    "WorkspaceRestored",
    "ProjectActiveRead",
    "ProjectActiveWrite",
    "ProjectTombstoneRead",
    "ProjectTombstoneWrite",
    "ProjectRestoredWrite",
    "ResumedPublicProject",
  ]) {
    assert.equal(document.components.schemas[schemaName].additionalProperties, false, schemaName);
  }
  assert.deepEqual(
    document.components.schemas.ProjectTombstoneRead.required.filter((field) =>
      ["parent_status", "resumed_public_projects", "unavailability_reason"].includes(field)),
    ["parent_status", "resumed_public_projects", "unavailability_reason"],
  );
  assert.equal(
    document.components.schemas.WorkspaceTombstoneDetail.properties
      .resumed_public_projects.properties.projects.maxItems,
    100,
  );
});

test("OpenAPI distinguishes Comment lifecycle shapes and deleted-only permissions", async () => {
  const document = JSON.parse(await readFile(
    new URL("../../contracts/openapi.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    document.components.schemas.Comment.oneOf.map((branch) => branch.$ref),
    [
      "#/components/schemas/ActiveStandardComment",
      "#/components/schemas/CompletionComment",
      "#/components/schemas/DeletedStandardComment",
    ],
  );
  assert.equal(
    document.components.schemas.CompleteIssueRequest.properties.verification.items.minLength,
    1,
  );
  assert.equal(
    document.components.schemas.CompleteIssueRequest.properties.follow_ups.items.minLength,
    1,
  );
  const relationRead = document.paths["/api/v1/relations/{relation_id}"].get;
  const relationWrite = document.paths["/api/v1/issues/{identifier}/relations"].post;
  assert.match(relationRead.description, /both Relation endpoint Projects/);
  assert.match(relationRead.description, /deleted=only recovery view requires writer access to both endpoints/);
  assert.equal(
    relationRead["x-cfkanban-permission"],
    "relation_endpoints_reader_active_writer_tombstone",
  );
  assert.match(relationWrite.description, /active writer Grants for both Relation endpoint Projects/);
  const commentRead = document.paths["/api/v1/comments/{comment_id}"].get;
  const labelList = document.paths["/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels"].get;
  for (const operation of [commentRead, labelList]) {
    assert.match(operation.description, /deleted=only recovery view requires writer/);
    assert.equal(operation["x-cfkanban-permission"], "project_reader_active_writer_tombstone");
  }
  const deletedPermissionByOperation = new Map([
    ["listWorkspaces", "visible_scope_active_owner_tombstone"],
    ["getWorkspace", "visible_scope_active_owner_tombstone"],
    ["listProjects", "visible_scope_active_owner_tombstone"],
    ["getProject", "visible_scope_active_owner_tombstone"],
    ["listIssues", "project_reader_active_writer_tombstone"],
    ["listProjectIssues", "project_reader_active_writer_tombstone"],
    ["getIssue", "project_reader_active_writer_tombstone"],
    ["listComments", "project_reader_active_writer_tombstone"],
    ["getComment", "project_reader_active_writer_tombstone"],
    ["listLabels", "project_reader_active_writer_tombstone"],
    ["getLabel", "project_reader_active_writer_tombstone"],
    ["listIssueRelations", "relation_endpoints_reader_active_writer_tombstone"],
    ["getRelation", "relation_endpoints_reader_active_writer_tombstone"],
  ]);
  const operationsWithDeleted = [];
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (
        typeof operation === "object"
        && operation !== null
        && operation.operationId !== undefined
        && operation.parameters?.some((parameter) => parameter.name === "deleted")
      ) operationsWithDeleted.push(operation);
    }
  }
  assert.deepEqual(
    operationsWithDeleted.map((operation) => operation.operationId).sort(),
    [...deletedPermissionByOperation.keys()].sort(),
  );
  for (const operation of operationsWithDeleted) {
    assert.equal(
      operation["x-cfkanban-permission"],
      deletedPermissionByOperation.get(operation.operationId),
    );
  }
});

test("OpenAPI exposes concrete Issue contracts and reserves done for complete", async () => {
  const document = JSON.parse(await readFile(
    new URL("../../contracts/openapi.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(document.components.schemas.NonDoneStatusKey.enum, [
    "backlog",
    "todo",
    "in_progress",
    "canceled",
  ]);
  assert.equal(
    document.components.schemas.CreateIssueRequest.properties.status_key.$ref,
    "#/components/schemas/NonDoneStatusKey",
  );
  assert.equal(
    document.components.schemas.UpdateIssueRequest.properties.status_key.$ref,
    "#/components/schemas/NonDoneStatusKey",
  );
  assert.equal(document.components.schemas.IssueSummary.additionalProperties, false);
  assert.equal(document.components.schemas.IssueTombstone.additionalProperties, false);
  assert.equal(document.components.schemas.IssueContext.additionalProperties, false);

  const listOperation = document.paths["/api/v1/issues"].get;
  assert.deepEqual(
    listOperation.parameters.filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name),
    ["deleted", "project", "workspace", "status", "assignee", "q", "cursor", "limit"],
  );
  assert.equal(
    listOperation.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/IssueListResult",
  );
  assert.equal(
    document.paths["/api/v1/issues/{identifier}/context"].get
      .responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/IssueContext",
  );
});

test("OpenAPI exposes concrete Browser Launch, Session, and WebAuthn contracts", async () => {
  const document = JSON.parse(await readFile(
    new URL("../../contracts/openapi.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    document.paths["/api/v1/web-launches"].post.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/BrowserLaunchWriteResult",
  );
  assert.equal(
    document.paths["/api/v1/web-sessions/redeem"].post.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/WebSessionExchangeWriteResult",
  );
  assert.equal(
    document.paths["/api/v1/web-authentication/options"].post["x-cfkanban-permission"],
    "webauthn_options",
  );
  assert.equal(
    document.paths["/api/v1/web-authentication/verify"].post["x-cfkanban-permission"],
    "webauthn_capability",
  );
  assert.equal(document.components.schemas.WebAuthnChallenge.minLength, 43);
  assert.equal(document.components.schemas.WebAuthnChallenge.maxLength, 43);
  assert.equal(document.components.schemas.WebAuthnAttestation.maxLength, 87382);
  assert.equal(document.components.schemas.WebAuthnSignature.maxLength, 2731);
  const registrationCredential = document.components.schemas.WebAuthnRegistrationCredential;
  const authenticationCredential = document.components.schemas.WebAuthnAuthenticationCredential;
  assert.equal(registrationCredential.additionalProperties, false);
  assert.equal(registrationCredential.properties.response.additionalProperties, false);
  assert.equal(authenticationCredential.additionalProperties, false);
  assert.equal(authenticationCredential.properties.response.additionalProperties, false);
  assert.deepEqual(
    registrationCredential.properties.authenticatorAttachment.anyOf[0].enum,
    ["platform", "cross-platform"],
  );
  assert.equal(registrationCredential.properties.clientExtensionResults.maxProperties, 0);
  assert.equal(authenticationCredential.properties.clientExtensionResults.maxProperties, 0);
  assert.deepEqual(
    document.components.schemas.Event.properties.authorized_via.enum,
    ["deployment_owner", "project_grant", "public_join", "invitation", "browser_launch", "web_session", "webauthn", "deployment_recovery"],
  );
  assert.match(document.components.schemas.Event.properties.authorized_via.description, /does not identify the mutated resource/u);
  assert.match(document.components.schemas.Event.properties.grant_id.description, /authorization context/u);
  assert.match(document.components.schemas.Event.properties.subject.description, /not grant_id alone/u);
  assert.deepEqual(
    document.components.schemas.PasskeyRegistrationOptions.properties.public_key.properties
      .pubKeyCredParams.items.properties.alg.enum,
    [-7, -257],
  );
  assert.equal(
    document.paths["/api/v1/admin/principals/{principal_id}"].get.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/PrincipalDetail",
  );
  assert.ok(document.components.schemas.PrincipalDetail.required.includes("passkeys"));
  assert.equal(
    document.components.schemas.PrincipalDetail.properties.passkeys.items.$ref,
    "#/components/schemas/PrincipalPasskeySummary",
  );
  assert.equal(document.components.schemas.PrincipalPasskeySummary.additionalProperties, false);
  assert.equal("public_key_cose" in document.components.schemas.PrincipalPasskeySummary.properties, false);
  const launchQuery = document.paths["/app/launch"].get.parameters
    .find((parameter) => parameter.name === "code").schema;
  assert.equal(launchQuery.minLength, 59);
  assert.equal(launchQuery.maxLength, 59);
});
