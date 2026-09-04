import os from "node:os";
import path from "node:path";

export function classifyExecutionEnvironment({ platform = process.platform, release = os.release(), env = process.env } = {}) {
  if (platform === "win32") return "windows-native";
  if (platform === "linux" && (/microsoft/i.test(release) || env.WSL_DISTRO_NAME || env.WSL_INTEROP)) return "wsl2";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unsupported";
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveStateRoot({ platform = process.platform, home = os.homedir() } = {}) {
  return pathApi(platform).join(home, ".cfkanban");
}

export function resolveToolRuntimeRoot({ platform = process.platform, home = os.homedir() } = {}) {
  return pathApi(platform).join(resolveStateRoot({ platform, home }), "tool-runtime");
}

export function resolveSkillReleaseRoot({ platform = process.platform, home = os.homedir() } = {}) {
  return pathApi(platform).join(resolveStateRoot({ platform, home }), "skill-releases");
}

export function resolveServiceReleaseRoot({ platform = process.platform, home = os.homedir() } = {}) {
  return pathApi(platform).join(resolveStateRoot({ platform, home }), "service-releases");
}
