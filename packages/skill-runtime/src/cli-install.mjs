import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSkillReleaseRoot, resolveStateRoot } from "./paths.mjs";
import { atomicWriteJson, ensurePrivateDirectory, readJson, sha256Bytes } from "./utils.mjs";
import { treeDigest, withSkillReleaseLock } from "./skill-update.mjs";
import { toolError } from "./errors.mjs";
import { validatePrivatePath } from "./state.mjs";

const executeFile = promisify(execFile);
const launcherNames = (platform) => platform === "win32" ? ["cfkanban.cmd", "cfkanban.ps1", "cfkanban-launcher.mjs"] : ["cfkanban", "cfkanban-launcher.mjs"];

function locations({ releaseRoot = resolveSkillReleaseRoot(), commandDirectory, platform = process.platform } = {}) {
  const directory = commandDirectory ?? (platform === "win32" ? path.join(resolveStateRoot(), "bin") : path.join(os.homedir(), ".local", "bin"));
  if (!path.isAbsolute(directory) || !path.isAbsolute(releaseRoot)) throw toolError("INVALID_INPUT", "CLI installation paths must be absolute");
  return { releaseRoot, commandDirectory: directory, platform, receiptPath: path.join(releaseRoot, "cli-launcher.json") };
}

async function rejectSymlinkPath(directory) {
  let current = directory;
  while (true) {
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw toolError("CLI_UNSAFE_PATH", "CLI command directory must not traverse a symbolic link");
    if (info && !info.isDirectory()) throw toolError("CLI_UNSAFE_PATH", "CLI command path must be a directory");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function verifyCommandDirectory(directory) {
  if (process.platform === "win32") return validatePrivatePath(directory, "directory");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw toolError("STATE_PERMISSION_DRIFT", "CLI command directory must only be writable by its owner");
}

export async function verifyActiveCliRelease(releaseRoot = resolveSkillReleaseRoot()) {
  await rejectSymlinkPath(releaseRoot);
  const activePath = path.join(releaseRoot, "active.json");
  if (!await lstat(activePath).catch((error) => { if (error.code === "ENOENT") return null; throw error; })) throw toolError("CLI_RELEASE_NOT_INSTALLED", "Install a verified complete Skills bundle before registering the CLI");
  await validatePrivatePath(releaseRoot, "directory");
  await validatePrivatePath(activePath, "file");
  const active = await readJson(activePath);
  if (!active || active.schema_version !== 1 || typeof active.path !== "string" || typeof active.release_path !== "string" || typeof active.tree_digest !== "string") {
    throw toolError("CLI_RELEASE_NOT_INSTALLED", "Install a verified complete Skills bundle before registering the CLI");
  }
  const versionsRoot = path.join(releaseRoot, "versions");
  const relativeRelease = path.relative(versionsRoot, active.release_path);
  const relativeBundle = path.relative(active.release_path, active.path);
  if (!relativeRelease || relativeRelease.startsWith("..") || path.isAbsolute(relativeRelease) || relativeBundle.startsWith("..") || path.isAbsolute(relativeBundle)) {
    throw toolError("CLI_RECEIPT_INVALID", "Active CLI release is outside the canonical installation");
  }
  await rejectSymlinkPath(active.release_path);
  await rejectSymlinkPath(active.path);
  await validatePrivatePath(active.release_path, "directory");
  await validatePrivatePath(path.join(active.release_path, ".cfkanban-release.json"), "file");
  const receipt = await readJson(path.join(active.release_path, ".cfkanban-release.json"));
  if (receipt.kind !== "skill_bundle" || receipt.version !== active.version || receipt.artifact_sha256 !== active.artifact_sha256 || await treeDigest(active.release_path) !== active.tree_digest) {
    throw toolError("LOCAL_SKILL_MODIFIED", "Canonical Skills receipt or payload changed; restore the verified release before running CLI");
  }
  const entry = path.join(active.path, "cli", "cfkanban.mjs");
  const info = await lstat(entry).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw toolError("CLI_RELEASE_UNSUPPORTED", "This Skills release does not contain the public CLI");
  const metadata = await readJson(path.join(active.path, "cli", "build-metadata.json"));
  if (metadata.schema_version !== 1 || metadata.name !== "cfkanban-cli" || metadata.release_version !== active.version || metadata.node_range !== ">=22.12.0") throw toolError("CLI_RECEIPT_INVALID", "CLI metadata does not match the active Skills release");
  return { active, entry };
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function launcherSource(releaseRoot) {
  // Built-ins verify the complete active tree before importing release code.
  return `import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = ${JSON.stringify(releaseRoot)};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) { if(Array.isArray(value))return value.map(canonical); if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])); return value; }
async function directoryChain(directory) { let checked=directory; while(true) { if((await lstat(checked)).isSymbolicLink())throw Error(); const parent=path.dirname(checked); if(parent===checked)break; checked=parent; } }
async function privatePath(file,kind) {
 const stat=await lstat(file); if(stat.isSymbolicLink()||(kind==='directory'?!stat.isDirectory():!stat.isFile()))throw Error();
 if(process.platform!=='win32'){if((stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw Error();return;}
 const script="$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath $env:CFKANBAN_ACL_PATH;$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$owner=([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value;$access=@($acl.Access|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=$_.AccessControlType.ToString()}});[pscustomobject]@{current=$current;owner=$owner;access=$access}|ConvertTo-Json -Depth 5 -Compress";
 const probe=spawnSync(path.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',env:{SystemRoot:process.env.SystemRoot,CFKANBAN_ACL_PATH:file},shell:false,windowsHide:true,timeout:10000,maxBuffer:65536});if(probe.error||probe.status!==0)throw Error();const acl=JSON.parse(probe.stdout);const allowed=new Set([acl.current,'S-1-5-18','S-1-5-32-544']);const access=Array.isArray(acl.access)?acl.access:acl.access?[acl.access]:[];if(acl.owner!==acl.current||access.some(entry=>entry.type==='Allow'&&!allowed.has(entry.sid)))throw Error();
}
async function collect(directory,relative='') { const files=[]; for(const name of (await readdir(path.join(directory,relative))).sort()) { const child=relative?path.join(relative,name):name; const stat=await lstat(path.join(directory,child)); if(stat.isSymbolicLink())throw Error(); if(stat.isDirectory())files.push(...await collect(directory,child)); else if(stat.isFile())files.push({path:child.split(path.sep).join('/'),sha256:digest(await readFile(path.join(directory,child)))}); else throw Error(); } return files; }
try {
 const [major,minor] = process.versions.node.split('.').map(Number); if(major<22||(major===22&&minor<12)) { process.stderr.write('cfKanban requires Node >=22.12.0\\n'); process.exit(2); }
 await privatePath(fileURLToPath(import.meta.url),'file');
 const commandDirectory=path.dirname(fileURLToPath(import.meta.url));
 if(process.platform==='win32')await privatePath(commandDirectory,'directory'); else {const stat=await lstat(commandDirectory);if((stat.mode&0o022)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error();}
 await directoryChain(root);
 await privatePath(root,'directory'); await privatePath(path.join(root,'active.json'),'file');
 const active=JSON.parse(await readFile(path.join(root,'active.json'),'utf8'));
 const relative=path.relative(path.join(root,'versions'),active.release_path); const bundle=path.relative(active.release_path,active.path);
 if(active.schema_version!==1||!relative||relative.startsWith('..')||path.isAbsolute(relative)||bundle.startsWith('..')||path.isAbsolute(bundle))throw Error();
 await directoryChain(active.release_path); await directoryChain(active.path);
 await privatePath(active.release_path,'directory'); await privatePath(path.join(active.release_path,'.cfkanban-release.json'),'file');
 const receipt=JSON.parse(await readFile(path.join(active.release_path,'.cfkanban-release.json'),'utf8'));
 if(receipt.kind!=='skill_bundle'||receipt.version!==active.version||receipt.artifact_sha256!==active.artifact_sha256||digest(JSON.stringify(canonical(await collect(active.release_path))))!==active.tree_digest)throw Error();
 const entry=path.join(active.path,'cli','cfkanban.mjs'); const entryStat=await lstat(entry); if(!entryStat.isFile()||entryStat.isSymbolicLink())throw Error();
 const metadata=JSON.parse(await readFile(path.join(active.path,'cli','build-metadata.json'),'utf8')); if(metadata.schema_version!==1||metadata.name!=='cfkanban-cli'||metadata.release_version!==active.version||metadata.node_range!=='>=22.12.0')throw Error();
 const cli=await import(pathToFileURL(entry).href); if(typeof cli.main==='function')process.exitCode=await cli.main(process.argv.slice(2));
} catch { process.stderr.write('cfKanban CLI installation cannot be verified. Reinstall the verified Skills bundle or inspect the active receipt.\\n'); process.exitCode=2; }
`;
}

function launcherFiles({ platform, releaseRoot, nodePath }) {
  const js = launcherSource(releaseRoot);
  if (platform === "win32") {
    if (/[\r\n%!"]/u.test(nodePath)) throw toolError("CLI_UNSAFE_NODE_PATH", "Node executable path cannot be represented safely by the Windows launcher");
    return {
      "cfkanban.cmd": `@echo off\r\n"${nodePath}" "%~dp0cfkanban-launcher.mjs" %*\r\nexit /b %errorlevel%\r\n`,
      "cfkanban.ps1": `& '${nodePath.replaceAll("'", "''")}' (Join-Path $PSScriptRoot 'cfkanban-launcher.mjs') @args\nexit $LASTEXITCODE\n`,
      "cfkanban-launcher.mjs": js,
    };
  }
  return { "cfkanban-launcher.mjs": js };
}

function onPath(directory, platform) {
  const separator = platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "").split(separator).some((entry) => platform === "win32" ? entry.toLowerCase() === directory.toLowerCase() : entry === directory);
}

async function verifyOwnedLaunchers(location, receipt) {
  await verifyCommandDirectory(location.commandDirectory);
  if (!receipt || receipt.schema_version !== 1 || receipt.command_directory !== location.commandDirectory || receipt.platform !== location.platform || !receipt.files) throw toolError("CLI_COMMAND_CONFLICT", "The command name is not owned by this cfKanban installation");
  if (JSON.stringify(Object.keys(receipt.files).sort()) !== JSON.stringify(launcherNames(location.platform).sort())) throw toolError("CLI_RECEIPT_INVALID", "CLI launcher receipt is incomplete");
  for (const [name, digest] of Object.entries(receipt.files)) {
    const file = path.join(location.commandDirectory, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || sha256Bytes(await readFile(file)) !== digest) throw toolError("CLI_LAUNCHER_MODIFIED", "Existing CLI launcher changed; it will not be overwritten or removed");
    if (location.platform === "win32" || name.endsWith(".mjs")) await validatePrivatePath(file, "file");
    else if ((info.mode & 0o022) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw toolError("STATE_PERMISSION_DRIFT", "CLI executable is writable outside its owner");
  }
}

async function readLauncherReceipt(location) {
  const info = await lstat(location.receiptPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  await validatePrivatePath(location.receiptPath, "file");
  return readJson(location.receiptPath);
}

export async function inspectCliInstallation(options = {}) {
  const location = locations(options);
  await rejectSymlinkPath(location.commandDirectory);
  const receipt = await readLauncherReceipt(location);
  if (receipt) await verifyOwnedLaunchers(location, receipt);
  const { active, entry } = await verifyActiveCliRelease(location.releaseRoot);
  return { installed: Boolean(receipt), version: active.version, entry, command_directory: location.commandDirectory, path_present: onPath(location.commandDirectory, location.platform), node_path: receipt?.node_path ?? null, running_mcp_updated: false };
}

export async function installCliLauncher(options = {}) {
  const location = locations(options);
  return withSkillReleaseLock(location.releaseRoot, () => registerCliLauncher(options));
}

async function registerCliLauncher(options) {
  const location = locations(options);
  await rejectSymlinkPath(location.commandDirectory);
  const { active } = await verifyActiveCliRelease(location.releaseRoot);
  const nodePath = await realpath(options.nodePath ?? process.execPath);
  if (!path.isAbsolute(nodePath)) throw toolError("CLI_UNSAFE_NODE_PATH", "CLI requires an absolute verified Node executable");
  let stdout;
  try { ({ stdout } = await executeFile(nodePath, ["--version"], { timeout: 5000, maxBuffer: 256, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^SystemRoot$/iu.test(key))), windowsHide: true })); }
  catch { throw toolError("CLI_NODE_UNAVAILABLE", "The selected Node executable could not be verified"); }
  const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/u.exec(stdout);
  if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 12)) throw toolError("NODE_VERSION_UNSUPPORTED", "CLI requires Node >=22.12.0");
  await ensurePrivateDirectory(location.releaseRoot);
  const receipt = await readLauncherReceipt(location);
  if (receipt) {
    await verifyOwnedLaunchers(location, receipt);
    if (receipt.node_path !== nodePath) throw toolError("CLI_NODE_PATH_CHANGED", "The registered Node path differs; remove the verified owned launchers before registering another executable");
  } else {
    for (const name of launcherNames(location.platform)) {
      if (await lstat(path.join(location.commandDirectory, name)).catch(() => null)) throw toolError("CLI_COMMAND_CONFLICT", "An existing command would be overwritten; select another directory");
    }
  }
  await mkdir(location.commandDirectory, { recursive: true, mode: 0o700 });
  await verifyCommandDirectory(location.commandDirectory);
  const files = launcherFiles({ ...location, nodePath });
  if (location.platform !== "win32") files.cfkanban = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(path.join(location.commandDirectory, "cfkanban-launcher.mjs"))} "$@"\n`;
  const installed = [];
  try {
    for (const [name, source] of Object.entries(files)) {
      // Idempotent registration never rewrites launchers; updating active is enough.
      if (!receipt) { await writeFile(path.join(location.commandDirectory, name), source, { flag: "wx", mode: name === "cfkanban" ? 0o755 : 0o600 }); installed.push(name); }
    }
    if (!receipt) await atomicWriteJson(location.receiptPath, { schema_version: 1, command_directory: location.commandDirectory, platform: location.platform, node_path: nodePath, files: Object.fromEntries(Object.entries(files).map(([name, source]) => [name, sha256Bytes(source)])) });
  } catch (error) {
    for (const name of installed) await rm(path.join(location.commandDirectory, name));
    throw error;
  }
  return { installed: true, version: active.version, command_directory: location.commandDirectory, path_present: onPath(location.commandDirectory, location.platform), path_change_required: !onPath(location.commandDirectory, location.platform), running_mcp_updated: false };
}

export async function uninstallCliLauncher(options = {}) {
  const location = locations(options);
  return withSkillReleaseLock(location.releaseRoot, () => removeCliLauncher(options));
}

async function removeCliLauncher(options) {
  const location = locations(options);
  await rejectSymlinkPath(location.commandDirectory);
  const receipt = await readLauncherReceipt(location);
  if (!receipt) return { removed: false, identity_preserved: true, deployment_records_preserved: true };
  await verifyOwnedLaunchers(location, receipt);
  for (const name of launcherNames(location.platform)) await rm(path.join(location.commandDirectory, name));
  await rm(location.receiptPath);
  return { removed: true, identity_preserved: true, deployment_records_preserved: true };
}

export async function rollbackCliRelease({ releaseRoot = resolveSkillReleaseRoot() } = {}) {
  return withSkillReleaseLock(releaseRoot, () => rollbackRelease(releaseRoot));
}

async function rollbackRelease(releaseRoot) {
  const { active } = await verifyActiveCliRelease(releaseRoot);
  const previous = active.previous;
  if (!previous) throw toolError("CLI_ROLLBACK_UNAVAILABLE", "No previous verified Skills release is recorded");
  const relative = path.relative(path.join(releaseRoot, "versions"), previous.release_path);
  const bundleRelative = path.relative(previous.release_path, previous.path);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || bundleRelative.startsWith("..") || path.isAbsolute(bundleRelative)) throw toolError("CLI_RECEIPT_INVALID", "Previous Skills release is outside the canonical installation");
  await rejectSymlinkPath(previous.release_path);
  await rejectSymlinkPath(previous.path);
  await validatePrivatePath(previous.release_path, "directory");
  await validatePrivatePath(path.join(previous.release_path, ".cfkanban-release.json"), "file");
  if (await treeDigest(previous.release_path) !== previous.tree_digest) throw toolError("LOCAL_SKILL_MODIFIED", "Previous Skills release cannot be verified");
  const receipt = await readJson(path.join(previous.release_path, ".cfkanban-release.json"));
  if (receipt.kind !== "skill_bundle" || receipt.version !== previous.version || !/^[0-9a-f]{64}$/u.test(receipt.artifact_sha256 ?? "")) throw toolError("CLI_RECEIPT_INVALID", "Previous Skills receipt does not match the rollback target");
  const entry = path.join(previous.path, "cli", "cfkanban.mjs");
  if (!(await lstat(entry).catch(() => null))?.isFile()) throw toolError("CLI_RELEASE_UNSUPPORTED", "Previous release does not contain the public CLI");
  const metadata = await readJson(path.join(previous.path, "cli", "build-metadata.json"));
  if (metadata.schema_version !== 1 || metadata.name !== "cfkanban-cli" || metadata.release_version !== previous.version || metadata.node_range !== ">=22.12.0") throw toolError("CLI_RECEIPT_INVALID", "Previous CLI metadata does not match the rollback target");
  await atomicWriteJson(path.join(releaseRoot, "active.json"), { ...active, ...previous, artifact_sha256: receipt.artifact_sha256, previous: { version: active.version, path: active.path, release_path: active.release_path, tree_digest: active.tree_digest }, switched_at: new Date().toISOString() });
  return { rolled_back: true, version: previous.version, identity_preserved: true, instance_upgraded: false, running_mcp_updated: false };
}
