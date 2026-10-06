import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { notifyVerifiedUpgrade } from "../../packages/skill-runtime/src/upgrade-notification.mjs";
import { compareReleaseVersions, isUpgradeAnnouncementRelease, parseReleaseVersion } from "../../packages/skill-runtime/src/release-versions.mjs";

test("严格SemVer排序保护RC、numeric prerelease、大整数和build metadata", () => {
  for (const [a, b, sign] of [["1.10.0", "1.9.99", 1], ["1.0.0-rc.10", "1.0.0-rc.9", 1], ["1.0.0", "1.0.0-rc.99", 1], ["1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740992", 1], ["9007199254740993.0.0", "9007199254740992.0.0", 1], ["1.0.0+one", "1.0.0+two", 0], ["1.0.0-1", "1.0.0-alpha", -1], ["1.0.0-alpha", "1.0.0-alpha.1", -1]]) assert.equal(compareReleaseVersions(a, b), sign);
  for (const invalid of ["1.0", "v1.0.0", "01.0.0", "1.0.0-01", "1.0.0-rc..1", "1.0.0+"]) assert.equal(parseReleaseVersion(invalid), null);
  for (const accepted of ["1.0.0", "1.10.0-rc.1", "1.10.0-rc.9007199254740993"]) assert.equal(isUpgradeAnnouncementRelease(accepted), true);
  for (const excluded of ["1.10.0-alpha.1", "1.10.0-beta.2", "1.10.0-rc", "1.10.0-rc.next", "1.10.0-rc.1.2"]) assert.equal(isUpgradeAnnouncementRelease(excluded), false);
});

function fixture() {
  const journal = { events: [] }, calls = [];
  const options = { stateRoot: "/synthetic-private", instanceId: randomUUID(), operationId: randomUUID(), journal, origin: "https://upgrade.example.test", owner: { principal_id: randomUUID(), credential_id: randomUUID() }, previousVersion: "1.9.0", releaseVersion: "1.10.0-rc.1", schemaVersion: 21, deploymentId: randomUUID(), workerVersionId: randomUUID(), token: "synthetic-token", appendImpl: async ({ event }) => journal.events.push({ ...event, at: new Date().toISOString() }) };
  options.requestImpl = async request => { calls.push(request); return { ok: true, data: { resource: { status: "published", ...request.body, notification_id: randomUUID() } } }; };
  return { options, calls, journal };
}

test("成功升级单独返回通知结果；保存原request/key/caller后发送，成功resume不重复调用", async () => {
  const { options, calls, journal } = fixture();
  const first = await notifyVerifiedUpgrade(options); assert.equal(first.status, "published"); assert.equal(calls.length, 1); assert.equal(journal.events[0].type, "upgrade_notification_requested"); assert.equal(journal.events[0].credential_id, options.owner.credential_id); assert.equal(JSON.stringify(journal).includes(options.token), false);
  const resume = await notifyVerifiedUpgrade(options); assert.equal(resume.resumed, true); assert.equal(resume.notification_id, first.notification_id); assert.equal(calls.length, 1);
  journal.events[1].result = { ok: true }; assert.equal((await notifyVerifiedUpgrade(options)).status, "recovery_required"); assert.equal(calls.length, 1);
});

test("响应丢失保持原key恢复；同版本、回滚、旧schema与身份漂移不发送", async () => {
  const { options, calls, journal } = fixture();
  let first = true;
  const successful = options.requestImpl; options.requestImpl = async request => { if (first) { calls.push(request); first = false; throw Error("lost response"); } return successful(request); };
  assert.equal((await notifyVerifiedUpgrade(options)).status, "recovery_required"); assert.equal(journal.events.length, 1);
  assert.equal((await notifyVerifiedUpgrade(options)).status, "published"); assert.equal(calls.length, 2); assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey); assert.deepEqual(calls[0].body, calls[1].body);
  const drift = await notifyVerifiedUpgrade({ ...options, owner: { ...options.owner, credential_id: randomUUID() } }); assert.equal(drift.status, "recovery_required"); assert.equal(calls.length, 2);
  for (const extra of [{ releaseVersion: "1.9.0" }, { releaseVersion: "1.8.0" }, { schemaVersion: 20 }, { previousVersion: null }]) { const isolated = fixture(); assert.equal((await notifyVerifiedUpgrade({ ...isolated.options, ...extra })).attempted, false); assert.equal(isolated.calls.length, 0); }
  for (const releaseVersion of ["1.10.0-alpha.1", "1.10.0-beta.1"]) { const isolated = fixture(); const result = await notifyVerifiedUpgrade({ ...isolated.options, releaseVersion }); assert.equal(result.status, "unsupported_channel"); assert.equal(result.attempted, false); assert.equal(isolated.calls.length, 0); }
});

test("关闭结果与错误分别报告；写前journal故障不发送通知，未知response不宣称成功", async () => {
  const disabled = fixture(); disabled.options.requestImpl = async request => ({ ok: true, data: { resource: { ...request.body, status: "disabled", notification_id: null } } }); assert.equal((await notifyVerifiedUpgrade(disabled.options)).status, "disabled");
  const failed = fixture(); failed.options.requestImpl = async () => ({ ok: false, status: 503, error: { code: "PLATFORM_UNAVAILABLE" } }); const error = await notifyVerifiedUpgrade(failed.options); assert.equal(error.status, "recovery_required"); assert.equal(error.code, "PLATFORM_UNAVAILABLE");
  const journalFailure = fixture(); journalFailure.options.appendImpl = async () => { throw Error("disk failure"); }; assert.equal((await notifyVerifiedUpgrade(journalFailure.options)).status, "recovery_required"); assert.equal(journalFailure.calls.length, 0);
  const wrong = fixture(); wrong.options.requestImpl = async request => ({ ok: true, data: { resource: { ...request.body, release_version: "other", status: "published", notification_id: randomUUID() } } }); assert.equal((await notifyVerifiedUpgrade(wrong.options)).status, "recovery_required");
  const expired = fixture(); expired.options.requestImpl = async () => { throw Error("lost response"); }; await notifyVerifiedUpgrade(expired.options); expired.journal.events[0].at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); const stopped = await notifyVerifiedUpgrade(expired.options); assert.equal(stopped.recovery, "inspect_original_notification_audit_replay_window_expired"); assert.equal(stopped.attempted, false);
});
