import { readFile } from "node:fs/promises";

const document = JSON.parse(await readFile(new URL("../contracts/openapi.json", import.meta.url), "utf8"));
const methods = new Set(["get", "post", "put", "patch", "delete"]);
const operationIds = new Set();
const failures = [];
let operationCount = 0;

const hasParameter = (operation, name) =>
  (operation.parameters ?? []).some((parameter) =>
    parameter.$ref?.endsWith(`/${name}`) || parameter.name === name,
  );

for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue;
    operationCount += 1;
    if (!operation.operationId) failures.push(`${method.toUpperCase()} ${path}: missing operationId`);
    if (operationIds.has(operation.operationId)) failures.push(`${method.toUpperCase()} ${path}: duplicate operationId ${operation.operationId}`);
    operationIds.add(operation.operationId);

    const mode = operation["x-cfkanban-write-contract"];
    const permission = operation["x-cfkanban-permission"];
    if (!permission) failures.push(`${method.toUpperCase()} ${path}: missing permission contract`);
    if (method !== "get" && !mode) failures.push(`${method.toUpperCase()} ${path}: missing write contract`);
    if (mode?.includes("idempotent") && !hasParameter(operation, "IdempotencyKey")) failures.push(`${method.toUpperCase()} ${path}: missing Idempotency-Key`);
    if (mode?.includes("cas-delete") && !hasParameter(operation, "ExpectedVersion")) failures.push(`${method.toUpperCase()} ${path}: missing DELETE expected_version`);
    const allowsCookie = (operation.security ?? []).some((requirement) => Object.hasOwn(requirement, "WebSession"));
    const allowsBearer = (operation.security ?? []).some((requirement) => Object.hasOwn(requirement, "BearerCredential"));
    const allowsAnonymous = (operation.security ?? []).some((requirement) => Object.keys(requirement).length === 0);
    if (method !== "get" && allowsCookie) {
      const expectedCsrf = allowsBearer || allowsAnonymous ? "ConditionalCsrfToken" : "CsrfToken";
      if (!hasParameter(operation, expectedCsrf)) failures.push(`${method.toUpperCase()} ${path}: missing ${expectedCsrf}`);
    }
    if (method === "patch") {
      const schemaRef = operation.requestBody?.content?.["application/json"]?.schema?.$ref;
      const schema = schemaRef && document.components.schemas[schemaRef.split("/").at(-1)];
      if (!schema?.required?.includes("expected_version")) failures.push(`${method.toUpperCase()} ${path}: PATCH schema lacks expected_version`);
    }
    for (const status of ["400", "401", "403", "404", "409", "429", "503"]) {
      if (!operation.responses?.[status]) failures.push(`${method.toUpperCase()} ${path}: missing ${status} response`);
    }
    if (operation.requestBody && !operation.responses?.["413"]) failures.push(`${method.toUpperCase()} ${path}: request body lacks 413 response`);
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      const resolved = response.$ref ? document.components.responses[response.$ref.split("/").at(-1)] : response;
      if (!resolved?.headers?.["X-Request-ID"]) failures.push(`${method.toUpperCase()} ${path}: ${status} lacks X-Request-ID`);
    }
  }
}

if (operationCount < 80) failures.push(`expected at least 80 operations, found ${operationCount}`);
const discoveryHeaders = document.paths["/.well-known/cfkanban-instance.json"]?.get?.responses?.["200"]?.headers;
if (discoveryHeaders?.["Cache-Control"]?.schema?.const !== "no-store") failures.push("instance discovery must require Cache-Control: no-store");
for (const path of ["/api/v1/web-sessions/redeem", "/api/v1/web-authentication/verify"]) {
  const headers = document.paths[path]?.post?.responses?.["200"]?.headers;
  if (!headers?.["Set-Cookie"]) failures.push(`${path}: missing Set-Cookie response contract`);
}
for (const path of ["/api/v1/invitations/redeem", "/api/v1/public-joins/{public_id}/redeem"]) {
  const security = document.paths[path]?.post?.security ?? [];
  if (!security.some((requirement) => Object.keys(requirement).length === 0)) failures.push(`${path}: missing unauthenticated conditional-auth branch`);
}
for (const path of ["/invite", "/app/launch", "/api/v1/invitations/redeem", "/api/v1/web-sessions/redeem"]) {
  const method = path.startsWith("/api/") ? "post" : "get";
  if (!document.paths[path]?.[method]?.responses?.["410"]) failures.push(`${path}: missing expired capability 410 response`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`OpenAPI contract checks passed for ${operationCount} operations and ${operationIds.size} unique operationIds.`);
