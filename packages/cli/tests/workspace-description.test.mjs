import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseArguments } from "../src/parser.mjs";

test("工作区描述参数保持 nullable 原文、UTF-8上限与独立更新语义", async () => {
  const id = randomUUID();
  const created = await parseArguments(["workspace", "create", "--instance", id, "--display-name", "Workspace", "--description", "  团队描述\n  "]);
  assert.equal(created.input.description, "  团队描述\n  ");
  const omitted = await parseArguments(["workspace", "update", "--instance", id, "--workspace-id", id, "--expected-version", "3", "--display-name", "Renamed"]);
  assert.ok(!Object.hasOwn(omitted.input, "description"));
  for (const [raw, expected] of [["null", null], ["", ""], ["说明", "说明"]]) {
    const updated = await parseArguments(["workspace", "update", "--instance", id, "--workspace-id", id, "--expected-version", "3", "--description", raw]);
    assert.equal(updated.input.description, expected);
    assert.ok(!Object.hasOwn(updated.input, "display_name"));
  }
  await assert.rejects(parseArguments(["workspace", "update", "--instance", id, "--workspace-id", id, "--expected-version", "3", "--description", "界".repeat(10923)]), { code: "CLI_INVALID_ARGUMENT" });
  await assert.rejects(parseArguments(["workspace", "update", "--instance", id, "--workspace-id", id, "--expected-version", "3", "--description", "false"]), { code: "CLI_INVALID_ARGUMENT" });
});
