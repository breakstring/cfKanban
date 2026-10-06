import { requireUuid, requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { RequestContext, WorkerEnv } from "../kernel/types.ts";
import { acknowledgeNotification, getNotificationPreferences, listNotifications, publishNotification, updateNotificationPreferences, withdrawNotification } from "../services/notifications.ts";
import { getUpgradeNotificationRelease, getUpgradeNotificationSettings, publishUpgradeNotification, updateUpgradeNotificationSettings } from "../services/upgrade-notifications.ts";

async function authenticated(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticateRequest(env.DB, request, context.startedAt);
  await enforcePrincipalRateLimit(env, auth);
  return auth;
}

export function registerNotificationRoutes(router: Router): void {
  router.get("/api/v1/admin/upgrade-notification-settings", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await getUpgradeNotificationSettings(env.DB, auth), context.requestId);
  }).patch("/api/v1/admin/upgrade-notification-settings", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["enabled", "expected_version"], requiredKeys: ["enabled", "expected_version"] });
    return jsonResponse(await updateUpgradeNotificationSettings(env.DB, request, auth, body.enabled ?? null, requireVersion(body.expected_version ?? null), context.startedAt), context.requestId);
  }).get("/api/v1/admin/notifications/upgrade-releases/{release_version}", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await getUpgradeNotificationRelease(env.DB, auth, context.params.release_version ?? ""), context.requestId);
  }).post("/api/v1/admin/notifications/commands/publish-upgrade", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["previous_release_version", "release_version", "deployment_id", "worker_version_id"], requiredKeys: ["previous_release_version", "release_version", "deployment_id", "worker_version_id"] });
    body.deployment_id = requireUuid(body.deployment_id ?? null, "deployment_id");
    body.worker_version_id = requireUuid(body.worker_version_id ?? null, "worker_version_id");
    return jsonResponse(await publishUpgradeNotification(env.DB, request, auth, body, context.startedAt), context.requestId);
  }).get("/api/v1/me/notification-preferences", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await getNotificationPreferences(env.DB, auth), context.requestId);
  }).patch("/api/v1/me/notification-preferences", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["enabled", "expected_version"], requiredKeys: ["enabled", "expected_version"] });
    return jsonResponse(await updateNotificationPreferences(env.DB, request, auth, body.enabled ?? null, requireVersion(body.expected_version ?? null), context.startedAt), context.requestId);
  }).get("/api/v1/me/notifications", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await listNotifications(env.DB, auth, context.url, context.startedAt), context.requestId);
  }).post("/api/v1/me/notifications/{notification_id}/commands/acknowledge", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    enforceCookieWriteProtection(request, auth);
    validateJsonObject(await readJsonBody(request), { allowedKeys: [] });
    return jsonResponse(await acknowledgeNotification(env.DB, request, auth, requireUuid(context.params.notification_id ?? null, "notification_id"), context.startedAt), context.requestId);
  }).get("/api/v1/admin/notifications", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await listNotifications(env.DB, auth, context.url, context.startedAt, true), context.requestId);
  }).post("/api/v1/admin/notifications", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["title", "body", "expires_at"], requiredKeys: ["title", "body"] });
    return jsonResponse(await publishNotification(env.DB, request, auth, body, context.startedAt), context.requestId);
  }).post("/api/v1/admin/notifications/{notification_id}/commands/withdraw", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["expected_version"], requiredKeys: ["expected_version"] });
    return jsonResponse(await withdrawNotification(env.DB, request, auth, requireUuid(context.params.notification_id ?? null, "notification_id"), requireVersion(body.expected_version ?? null), context.startedAt), context.requestId);
  });
}
