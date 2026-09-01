import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths } from "./state.mjs";
import { atomicWriteJson, canonicalDigest, readJson, requireString, requireUuid } from "./utils.mjs";
import { ensurePrivateDirectory } from "./utils.mjs";
import { toolError } from "./errors.mjs";

function journalPath(stateRoot, instanceId, operationId) {
  const paths = getInstancePaths({ stateRoot, instanceId });
  return { paths, filePath: path.join(paths.journalsRoot, `${requireUuid(operationId, "operation_id")}.json`) };
}

export async function createJournal({ stateRoot = resolveStateRoot(), instanceId, operationId, plan }) {
  const { paths, filePath } = journalPath(stateRoot, instanceId, operationId);
  await ensurePrivateDirectory(paths.journalsRoot);
  const existing = await readJson(filePath, { allowMissing: true });
  const digest = canonicalDigest(plan);
  if (existing !== null) {
    if (existing.plan_digest !== digest) throw toolError("JOURNAL_PLAN_MISMATCH", "Existing operation journal belongs to a different plan", { operationId });
    return existing;
  }
  const journal = {
    schema_version: 1,
    operation_id: requireUuid(operationId, "operation_id"),
    instance_id: requireUuid(instanceId, "instance_id"),
    plan_digest: digest,
    task_id: plan.task_id,
    authorization: null,
    events: [{ type: "plan_created", at: new Date().toISOString(), plan_digest: digest }],
  };
  await atomicWriteJson(filePath, journal);
  return journal;
}

export async function authorizeJournal({ stateRoot = resolveStateRoot(), instanceId, operationId, taskId, planDigest }) {
  const { filePath } = journalPath(stateRoot, instanceId, operationId);
  const journal = await readJson(filePath);
  if (journal.plan_digest !== planDigest || journal.task_id !== taskId) {
    throw toolError("PLAN_AUTHORIZATION_MISMATCH", "Authorization does not match the current task and frozen plan", { operationId });
  }
  journal.authorization = {
    task_id: requireString(taskId, "task_id"),
    plan_digest: requireString(planDigest, "plan_digest", { max: 64 }),
    authorized_at: new Date().toISOString(),
  };
  journal.events.push({ type: "plan_authorized", at: journal.authorization.authorized_at, plan_digest: planDigest });
  await atomicWriteJson(filePath, journal);
  return { authorized: true, operation_id: operationId, plan_digest: planDigest };
}

export async function assertJournalAuthorization({ stateRoot = resolveStateRoot(), instanceId, operationId, taskId, plan }) {
  const { filePath } = journalPath(stateRoot, instanceId, operationId);
  const journal = await readJson(filePath);
  const digest = canonicalDigest(plan);
  if (journal.plan_digest !== digest || journal.authorization?.plan_digest !== digest || journal.authorization?.task_id !== taskId || journal.task_id !== taskId) {
    throw toolError("PLAN_NOT_AUTHORIZED", "No matching authorization exists for this task, operation, and plan digest", { operationId, planDigest: digest });
  }
  return journal;
}

export async function appendJournalEvent({ stateRoot = resolveStateRoot(), instanceId, operationId, event }) {
  const { filePath } = journalPath(stateRoot, instanceId, operationId);
  const journal = await readJson(filePath);
  journal.events.push({ ...event, at: event.at || new Date().toISOString() });
  await atomicWriteJson(filePath, journal);
  return { event_count: journal.events.length, operation_id: operationId };
}
