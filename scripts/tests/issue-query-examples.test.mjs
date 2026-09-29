import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("contracts/openapi.json", root), "utf8"));
const files = [
  "skills/cfkanban/references/workflows.md",
  "skills/cfkanban/references/workflows.zh-CN.md",
  "apps/docs/en/usage/issues.md",
  "apps/docs/zh-CN/usage/issues.md",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const exampleProject = "33333333-3333-4333-8333-333333333333";
const examplePrincipal = "44444444-4444-4444-8444-444444444444";
const exampleLabels = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];

function queryExamples(file) {
  const source = readFileSync(new URL(file, root), "utf8");
  return [...source.matchAll(/```json\n([\s\S]*?)\n```/gu)]
    .map(match => JSON.parse(match[1]))
    .filter(input => input.method === "GET" && typeof input.apiPath === "string")
    .filter(input => {
      const url = new URL(input.apiPath, "https://example.invalid");
      return url.pathname === "/api/v1/issues/candidates"
        || url.pathname.endsWith("/issues") || url.pathname.endsWith("/labels");
    });
}

function dereference(schema) {
  return schema.$ref ? schema.$ref.slice(2).split("/").reduce((value, key) => value[key], contract) : schema;
}

function validValue(value, inputSchema) {
  const schema = dereference(inputSchema);
  if (schema.anyOf && !schema.anyOf.some(option => validValue(value, option))) return false;
  if (schema.oneOf && schema.oneOf.filter(option => validValue(value, option)).length !== 1) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Object.hasOwn(schema, "const") && schema.const !== value) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.format === "uuid" && !uuid.test(value)) return false;
  if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false;
  if (schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  if (schema.type === "integer") {
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) return false;
    if (schema.minimum !== undefined && Number(value) < schema.minimum) return false;
    if (schema.maximum !== undefined && Number(value) > schema.maximum) return false;
  }
  return true;
}

function validateRequest(input) {
  assert.deepEqual(Object.keys(input).sort(), ["apiPath", "instanceId", "method"]);
  assert.match(input.instanceId, uuid);
  assert.equal(input.method, "GET");
  assert.ok(input.apiPath.startsWith("/api/v1/"));
  const url = new URL(input.apiPath, "https://example.invalid");
  assert.equal(url.origin, "https://example.invalid");
  assert.equal(url.hash, "");
  const segments = url.pathname.split("/");
  const match = Object.entries(contract.paths).find(([template]) => {
    const parts = template.split("/");
    return parts.length === segments.length && parts.every((part, i) => part === segments[i] || part.startsWith("{"));
  });
  assert.ok(match, `No documented endpoint: ${url.pathname}`);
  const [template, operations] = match;
  const operation = operations.get;
  assert.ok(operation, `GET is missing for ${template}`);
  const parameters = [...(operations.parameters ?? []), ...(operation.parameters ?? [])].map(dereference);
  for (const name of new Set(url.searchParams.keys())) {
    const parameter = parameters.find(item => item.in === "query" && item.name === name);
    assert.ok(parameter, `Unknown query parameter ${name} on ${template}`);
  }
  for (const parameter of parameters) {
    if (parameter.in === "path") {
      const index = template.split("/").indexOf(`{${parameter.name}}`);
      assert.ok(validValue(segments[index], parameter.schema), `Invalid path ${parameter.name}`);
      continue;
    }
    if (parameter.in !== "query") continue;
    const values = url.searchParams.getAll(parameter.name);
    assert.ok(!parameter.required || values.length > 0, `Missing required ${parameter.name}`);
    const schema = dereference(parameter.schema);
    if (schema.type === "array") {
      assert.equal(parameter.style, "form");
      assert.equal(parameter.explode, true);
      assert.ok(schema.maxItems === undefined || values.length <= schema.maxItems);
      for (const value of values) assert.ok(validValue(value, schema.items), `Invalid ${parameter.name}: ${value}`);
    } else {
      assert.ok(values.length <= 1, `Repeated scalar ${parameter.name}`);
      for (const value of values) assert.ok(validValue(value, schema), `Invalid ${parameter.name}: ${value}`);
    }
  }
  return url;
}

for (const file of files) {
  test(`${file}: query JSON and URL inputs conform to OpenAPI`, () => {
    const examples = queryExamples(file);
    assert.equal(examples.length, 6);
    examples.forEach(validateRequest);
  });
}

test("daily workflows and public documentation preserve the same bilingual query semantics", () => {
  const reference = queryExamples(files[0]);
  for (const file of files.slice(1)) assert.deepEqual(queryExamples(file), reference, file);
  const [labels, mine, unfinished, unassigned, candidates] = reference.map(validateRequest);
  assert.equal(labels.pathname, `/api/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/${exampleProject}/labels`);
  assert.equal(labels.searchParams.get("deleted") ?? "exclude", "exclude");
  assert.deepEqual(mine.searchParams.getAll("project"), [exampleProject]);
  assert.deepEqual(mine.searchParams.getAll("status"), ["todo"]);
  assert.deepEqual(mine.searchParams.getAll("assignee"), [examplePrincipal]);
  assert.deepEqual(mine.searchParams.getAll("priority"), ["high"]);
  assert.deepEqual(unfinished.searchParams.getAll("status"), ["backlog", "todo", "in_progress"]);
  assert.deepEqual(unfinished.searchParams.getAll("label"), exampleLabels);
  assert.deepEqual(unassigned.searchParams.getAll("assignee"), ["unassigned"]);
  assert.equal(unassigned.searchParams.has("status"), false);
  assert.equal(unassigned.pathname, `/api/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/${exampleProject}/issues`);
  assert.equal(candidates.pathname, "/api/v1/issues/candidates");
  assert.equal(candidates.searchParams.get("assignment"), "unassigned");
  assert.equal(candidates.searchParams.get("blocked"), "exclude");
  assert.deepEqual(candidates.searchParams.getAll("priority"), ["high", "urgent"]);
  assert.deepEqual(candidates.searchParams.getAll("label"), [exampleLabels[0]]);
  assert.equal(candidates.searchParams.has("status"), false);
  assert.equal(candidates.searchParams.has("assignee"), false);
});

test("the pagination example preserves the original query and safely replaces an opaque cursor", () => {
  const examples = queryExamples(files[0]);
  const first = validateRequest(examples[2]);
  const next = validateRequest(examples[5]);
  assert.equal(next.searchParams.get("cursor"), "CURSOR_FROM_PREVIOUS_RESPONSE");
  const returnedCursor = "opaque+/cursor=with&reserved?characters";
  next.searchParams.set("cursor", returnedCursor);
  assert.equal(new URL(next.href).searchParams.get("cursor"), returnedCursor);
  next.searchParams.delete("cursor");
  assert.equal(next.pathname, first.pathname);
  assert.deepEqual([...next.searchParams], [...first.searchParams]);
});

test("example validation rejects an unsupported filter, a Label name, and a missing candidate policy", () => {
  const examples = queryExamples(files[0]);
  assert.throws(() => validateRequest({ ...examples[1], apiPath: `${examples[1].apiPath}&not_a_filter=high` }));
  assert.throws(() => validateRequest({ ...examples[2], apiPath: examples[2].apiPath.replace(exampleLabels[0], "bug") }));
  const candidate = new URL(examples[4].apiPath, "https://example.invalid");
  candidate.searchParams.delete("assignment");
  assert.throws(() => validateRequest({ ...examples[4], apiPath: candidate.pathname + candidate.search }));
});
