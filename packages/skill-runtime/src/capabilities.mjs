import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { classifyExecutionEnvironment, resolveServiceReleaseRoot, resolveSkillReleaseRoot, resolveStateRoot, resolveToolRuntimeRoot } from "./paths.mjs";

function probe(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env, shell: false, windowsHide: true, timeout: 5_000 });
  if (result.error) {
    return { status: result.error.code === "ENOENT" ? "unavailable" : "unknown", error_code: result.error.code || "SPAWN_FAILED" };
  }
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return {
    status: result.status === 0 ? "available" : "unknown",
    exit_code: result.status,
    summary: text.split(/\r?\n/, 1)[0].slice(0, 256),
  };
}

function presentEnvironmentManagers(env) {
  return [
    ["nvm", "NVM_DIR"],
    ["mise", "MISE_DATA_DIR"],
    ["asdf", "ASDF_DIR"],
    ["volta", "VOLTA_HOME"],
    ["fnm", "FNM_DIR"],
  ].filter(([, key]) => Boolean(env[key])).map(([name]) => name);
}

export function buildCapabilityReport({
  platform = process.platform,
  arch = process.arch,
  release = os.release(),
  home = os.homedir(),
  env = process.env,
  cwd = process.cwd(),
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  probes = true,
} = {}) {
  const executionEnvironment = classifyExecutionEnvironment({ platform, release, env });
  const result = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    execution_environment: executionEnvironment,
    platform,
    architecture: arch,
    shell: env.SHELL || env.ComSpec || null,
    interactive,
    boundaries: {
      windows_wsl_mixed_toolchain: false,
      mutates_path: false,
      installs_dependencies: false,
    },
    interaction: {
      browser_callback: "unknown",
      device_login: interactive ? "potentially_available" : "unknown",
      network: "not_probed",
      cloudflare_auth: "not_probed",
    },
    paths: {
      state_root: resolveStateRoot({ platform, home }),
      tool_runtime_root: resolveToolRuntimeRoot({ platform, home, env }),
      skill_release_root: resolveSkillReleaseRoot({ platform, home, env }),
      service_release_root: resolveServiceReleaseRoot({ platform, home, env }),
      current_directory: cwd,
    },
    environment: {
      path_entry_count: (env.PATH || "").split(platform === "win32" ? ";" : ":").filter(Boolean).length,
      detected_version_managers: presentEnvironmentManagers(env),
    },
    tools: {
      node: { status: "available", executable: process.execPath, version: process.version },
    },
  };
  try {
    const stats = lstatSync(result.paths.state_root);
    result.state = {
      status: stats.isSymbolicLink() ? "unsafe_symlink" : stats.isDirectory() ? "present" : "unsupported_type",
      permissions: platform === "win32" ? "requires_acl_probe_before_use" : (stats.mode & 0o077) === 0 ? "private" : "permission_drift",
    };
  } catch (error) {
    result.state = { status: error?.code === "ENOENT" ? "unavailable" : "unknown", permissions: "unknown" };
  }
  try {
    result.installed_skill_bundle = JSON.parse(readFileSync(path.join(result.paths.skill_release_root, "active.json"), "utf8"));
  } catch {
    result.installed_skill_bundle = { status: "unavailable" };
  }
  try {
    const activeToolRuntime = JSON.parse(readFileSync(path.join(result.paths.tool_runtime_root, "active.json"), "utf8"));
    const version = typeof activeToolRuntime?.version === "string" && activeToolRuntime.version.length <= 64
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(activeToolRuntime.version)
      ? activeToolRuntime.version
      : null;
    result.installed_tool_runtime = version !== null
      ? {
          status: "recorded_unverified",
          version,
          resolver_required: true,
        }
      : { status: "invalid_receipt", resolver_required: true };
  } catch {
    result.installed_tool_runtime = { status: "unavailable", resolver_required: true };
  }
  if (probes) {
    result.tools.npm = probe(platform === "win32" ? "npm.cmd" : "npm", ["--version"], { env });
    result.tools.git = probe("git", ["--version"], { env });
    result.tools.wrangler = probe(platform === "win32" ? "wrangler.cmd" : "wrangler", ["--version"], { env });
    const gitRoot = probe("git", ["rev-parse", "--show-toplevel"], { env });
    const gitStatus = probe("git", ["status", "--porcelain"], { env });
    result.repository = {
      status: gitRoot.status === "available" ? "clone" : "not_a_clone_or_unknown",
      root: gitRoot.status === "available" ? gitRoot.summary : null,
      dirty: gitStatus.status === "available" ? gitStatus.summary.length > 0 : null,
    };
  } else {
    result.tools.npm = { status: "unknown" };
    result.tools.git = { status: "unknown" };
    result.tools.wrangler = { status: "unknown" };
    result.repository = { status: "not_probed", root: null, dirty: null };
  }
  result.tools.wrangler.discovery_scope = "path_only";
  result.tools.wrangler.release_compatibility = "not_determined";
  result.required_next_checks = [{
    command: "runtime resolve-wrangler",
    required_input: "verified release compatibility.wrangler range",
    searches: ["explicit_path", "path", "cfkanban_tool_runtime"],
    purpose: "decide whether a compatible Wrangler can be reused before planning any installation",
  }];
  return result;
}
