import { randomUUID } from "node:crypto";
import { toolError } from "./errors.mjs";
import { canonicalDigest, requireUuid } from "./utils.mjs";

const MARKER = /^cfkanban:v1:[0-9a-f-]{36}:[0-9a-f]{64}$/u;

export function isDeploymentMarker(value) {
  return typeof value === "string" && MARKER.test(value);
}

function proofFor(plan, configDigest, attemptId) {
  const facts = {
    attempt_id: requireUuid(attemptId, "deployment_attempt_id"),
    operation_id: requireUuid(plan.operation_id, "operation_id"),
    plan_digest: canonicalDigest(plan),
    config_digest: configDigest,
    service_bundle_sha256: plan.release.service_bundle_sha256,
  };
  return { ...facts, marker: `cfkanban:v1:${facts.attempt_id}:${canonicalDigest(facts)}` };
}

export function findDeploymentAttempt(journal, plan, configDigest) {
  const index = journal.events.findLastIndex(event => event?.type === "command_started" && event.action === "deploy_worker_and_static_assets");
  if (index < 0 || !journal.events[index].deployment_proof) return null;
  const saved = journal.events[index].deployment_proof;
  let expected;
  try { expected = proofFor(plan, configDigest, saved.attempt_id); }
  catch { throw toolError("WORKER_DEPLOYMENT_PROOF_INVALID", "Deployment attempt does not match this frozen plan and configuration"); }
  if (canonicalDigest(saved) !== canonicalDigest(expected)) {
    throw toolError("WORKER_DEPLOYMENT_PROOF_INVALID", "Deployment attempt does not match this frozen plan and configuration");
  }
  return { index, proof: expected };
}

export function prepareDeploymentProof(journal, plan, configDigest) {
  return findDeploymentAttempt(journal, plan, configDigest)?.proof ?? proofFor(plan, configDigest, randomUUID());
}

export function deploymentCompletion(journal, plan, configDigest) {
  const finishedIndex = journal.events.findLastIndex(event => event?.type === "command_finished" && event.action === "deploy_worker_and_static_assets");
  if (finishedIndex >= 0 && journal.events[finishedIndex].exit_code === 0) {
    return { index: finishedIndex, event: journal.events[finishedIndex], recovered: false };
  }
  if (plan.current?.provenance !== "remote_observed") return null;
  const attempt = findDeploymentAttempt(journal, plan, configDigest);
  if (!attempt) return null;
  const index = journal.events.findLastIndex(event => event?.type === "worker_deployment_recovered");
  const event = journal.events[index];
  if (index <= attempt.index || index <= finishedIndex || event?.source !== "verified_cloudflare_readback"
    || canonicalDigest(event.deployment_proof) !== canonicalDigest(attempt.proof)) return null;
  return { index, event, recovered: true };
}
