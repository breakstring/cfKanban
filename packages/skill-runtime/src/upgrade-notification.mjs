import { appendJournalEvent } from "./journal.mjs";
import { compareReleaseVersions, isUpgradeAnnouncementRelease } from "./release-versions.mjs";
import { trustedApiRequest } from "./transport.mjs";
import { canonicalDigest } from "./utils.mjs";

const apiPath = "/api/v1/admin/notifications/commands/publish-upgrade";

export async function notifyVerifiedUpgrade({ stateRoot, instanceId, operationId, journal, origin, owner, previousVersion, releaseVersion, schemaVersion, deploymentId, workerVersionId, token, fetchImpl = globalThis.fetch, requestImpl = trustedApiRequest, appendImpl = appendJournalEvent }) {
  const retained = journal.events.find(event => event?.type === "upgrade_notification_requested");
  if (!retained && schemaVersion < 21) return { status: "unsupported", attempted: false };
  if (!retained && !isUpgradeAnnouncementRelease(releaseVersion)) return { status: "unsupported_channel", attempted: false };
  if (!retained && compareReleaseVersions(releaseVersion, previousVersion) !== 1) return { status: "not_forward", attempted: false };
  const expected = {
    type: "upgrade_notification_requested", instance_id: instanceId, api_origin: origin,
    principal_id: owner.principal_id, credential_id: owner.credential_id, api_path: apiPath,
    idempotency_key: `upgrade-notification:${deploymentId}`,
    body: { previous_release_version: previousVersion, release_version: releaseVersion, deployment_id: deploymentId, worker_version_id: workerVersionId },
  };
  if (retained && canonicalDigest(Object.fromEntries(Object.keys(expected).map(key => [key, retained[key]]))) !== canonicalDigest(expected)) return { status: "recovery_required", attempted: false, recovery: "restore_original_notification_request" };
  const validResource = resource => resource?.release_version === releaseVersion && resource?.previous_release_version === previousVersion
    && resource?.deployment_id === deploymentId && resource?.worker_version_id === workerVersionId
    && ["published", "already_published", "disabled", "not_forward", "unsupported_channel"].includes(resource?.status)
    && (["published", "already_published"].includes(resource.status)
      ? typeof resource.notification_id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resource.notification_id)
      : resource.notification_id === null);
  const previousResult = [...journal.events].reverse().find(event => event?.type === "upgrade_notification_result" && event.idempotency_key === expected.idempotency_key);
  if (previousResult?.result?.ok === true) {
    if (!validResource(previousResult.result.data?.resource)) return { status: "recovery_required", attempted: false, idempotency_key: expected.idempotency_key, recovery: "inspect_original_notification_result" };
    return { ...previousResult.result.data.resource, attempted: true, resumed: true };
  }
  if (retained && (!Number.isFinite(Date.parse(retained.at)) || Date.now() - Date.parse(retained.at) >= 23 * 60 * 60 * 1000)) return { status: "recovery_required", attempted: false, idempotency_key: expected.idempotency_key, recovery: "inspect_original_notification_audit_replay_window_expired" };
  let response;
  let requestStarted = false;
  try {
    if (!retained) await appendImpl({ stateRoot, instanceId, operationId, event: expected });
    requestStarted = true;
    response = await requestImpl({ stateRoot, instanceId, method: "POST", apiPath, body: expected.body, idempotencyKey: expected.idempotency_key, authorizationToken: token, expectedApiOrigin: origin, fetchImpl, signal: AbortSignal.timeout(5_000) });
    const resource = response.data?.resource;
    if (response.ok && !validResource(resource)) {
      return { status: "recovery_required", attempted: true, idempotency_key: expected.idempotency_key, recovery: "recover_original_notification_request" };
    }
    // 仅保存固定业务结果或结构化错误；不保存异常栈、响应任意字段或Credential。
    const savedResource = response.ok ? Object.fromEntries(["status", "release_version", "previous_release_version", "deployment_id", "worker_version_id", "notification_id"].map(key => [key, resource[key]])) : null;
    const result = response.ok ? { ok: true, data: { resource: savedResource } } : { ok: false, status: response.status, code: /^[A-Z][A-Z0-9_]{0,80}$/.test(response.error?.code ?? "") ? response.error.code : "UPGRADE_NOTIFICATION_FAILED" };
    await appendImpl({ stateRoot, instanceId, operationId, event: { type: "upgrade_notification_result", idempotency_key: expected.idempotency_key, result } });
    if (response.ok) return { ...savedResource, attempted: true };
    return { status: "recovery_required", attempted: true, code: result.code, idempotency_key: expected.idempotency_key, recovery: "resume_original_upgrade_or_replay_notification_key" };
  } catch {
    return { status: "recovery_required", attempted: requestStarted, idempotency_key: expected.idempotency_key, recovery: "resume_original_upgrade_or_replay_notification_key" };
  }
}
