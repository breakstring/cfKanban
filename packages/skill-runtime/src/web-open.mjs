import { access } from "node:fs/promises";
import { createBrowserLaunchAndDeliver } from "./capability-delivery.mjs";
import { toolError } from "./errors.mjs";
import { isPlainObject, requireString } from "./utils.mjs";

const FIELDS = ["mode", "directory", "instanceId", "target", "delivery", "idempotencyKey", "sensitiveOutputAcknowledgement", "onRelayReady"];
async function loadLocalLauncher() {
  // 只接受源码预构建和安装工件的固定布局，不接受调用方指定的入口。
  for (const url of [new URL("../../local-runtime/dist/launcher.mjs", import.meta.url), new URL("../../../local-runtime/launcher.mjs", import.meta.url)]) {
    try { await access(url); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    return import(url.href);
  }
  throw toolError("LOCAL_RUNTIME_NOT_INSTALLED", "Install a verified Skill bundle with the local Web runtime, or explicitly choose online mode");
}

export async function openWeb(input, { localLauncher = loadLocalLauncher, onlineLauncher = createBrowserLaunchAndDeliver } = {}) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !FIELDS.includes(key))) throw toolError("INVALID_WEB_OPEN_INPUT", "Web open accepts only its documented fields");
  const { mode = "local", directory, instanceId, target, delivery, idempotencyKey, sensitiveOutputAcknowledgement, onRelayReady } = input;
  if (mode !== "local" && mode !== "online") throw toolError("INVALID_WEB_MODE", "Choose local or online Web mode");
  if (mode === "online") {
    if (directory !== undefined) throw toolError("INVALID_WEB_OPEN_INPUT", "Directory applies only to local mode");
    return onlineLauncher({ instanceId, target, delivery, idempotencyKey: requireString(idempotencyKey, "idempotency_key", { max: 128 }), sensitiveOutputAcknowledgement, onRelayReady });
  }
  if (idempotencyKey !== undefined || sensitiveOutputAcknowledgement !== undefined) throw toolError("INVALID_WEB_OPEN_INPUT", "Browser Launch options apply only to online mode");
  if (target !== undefined && !["project", "issue"].includes(target?.kind)) throw toolError("LOCAL_TARGET_UNSUPPORTED", "Management requires explicitly selected online mode");
  const launcher = await localLauncher();
  return launcher.openLocalWorkbench({ directory: requireString(directory, "directory"), instanceId, target, delivery, onRelayReady });
}
