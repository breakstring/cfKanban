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
