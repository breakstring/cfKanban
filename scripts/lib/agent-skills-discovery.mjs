import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractTarGzip, readTarGzipEntries, writeDeterministicTarGzip } from "./deterministic-tar.mjs";

// Cloudflare Draft v0.2.0 的标识是 opaque URI，生成时不从网络获取 schema。
export const AGENT_SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const AGENT_SKILL_NAMES = ["cfkanban", "cfkanban-admin", "cfkanban-deploy", "cfkanban-howto"];
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name.replace(/^node:/u, "")}`]));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const validVersion = version => typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version);
const run = promisify(execFile);

async function treeFiles(root, relative = "") {
  const info = await lstat(path.join(root, relative));
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "Skill archive source must be a regular directory");
  const files = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    assert.ok(!/[\\\x00-\x1f]/u.test(file), "Unsafe Skill archive source path");
    const stats = await lstat(path.join(root, file));
    assert.ok(!stats.isSymbolicLink(), "Skill archive rejects symbolic links");
    if (stats.isDirectory()) files.push(...await treeFiles(root, file));
    else {
      assert.ok(stats.isFile() && stats.nlink === 1, "Skill archive rejects links and special files");
      files.push(file);
    }
  }
  return files;
}

function metadata(markdown) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)?.[1];
  assert.ok(frontmatter, "Skill requires YAML frontmatter");
  function field(name) {
    const value = new RegExp(`^${name}: ([^\\r\\n]+)$`, "mu").exec(frontmatter)?.[1];
    assert.ok(value && !/^[>|]/u.test(value), `Skill ${name} must be a single-line scalar`);
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith("'")) { assert.ok(value.endsWith("'")); return value.slice(1, -1).replaceAll("''", "'"); }
    return value.trim();
  }
  const name = field("name");
  const description = field("description");
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64, "Invalid Skill name");
  assert.ok(typeof description === "string" && description.length > 0 && [...description].length <= 1024, "Invalid Skill description");
  return { name, description };
}

export function validateAgentSkillsIndex(index, { version } = {}) {
  assert.ok(validVersion(version), "Skill discovery requires an exact release version");
  assert.equal(index?.$schema, AGENT_SKILLS_SCHEMA, "Unknown Skill discovery schema");
  assert.ok(Array.isArray(index.skills) && index.skills.length === AGENT_SKILL_NAMES.length, "Skill discovery requires four entries");
  const names = new Set();
  for (const entry of index.skills) {
    assert.ok(AGENT_SKILL_NAMES.includes(entry?.name) && !names.has(entry.name), "Unexpected or duplicate Skill");
    names.add(entry.name);
    assert.equal(entry.type, "archive", "cfKanban Skills require full archives");
    assert.ok(typeof entry.description === "string" && entry.description.length > 0 && [...entry.description].length <= 1024, "Invalid Skill description");
    assert.equal(entry.url, `/agent-skills/${version}/${entry.name}.tar.gz`, "Skill archive URL must bind the current exact release");
    assert.ok(/^sha256:[a-f0-9]{64}$/u.test(entry.digest), "Invalid Skill artifact digest");
  }
  return index;
}

export async function verifySkillRuntimeClosure({ skillBundleRoot }) {
  const root = path.join(skillBundleRoot, "packages/skill-runtime");
  const files = await treeFiles(root);
  const sources = files.filter(file => file.endsWith(".mjs"));
  assert.ok(sources.length > 0, "Missing shared Skill runtime");
  let imports = 0;
  for (const file of sources) {
    const source = await readFile(path.join(root, file), "utf8");
    const pattern = /\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2];
      imports += 1;
      if (builtins.has(specifier)) continue;
      assert.ok(specifier.startsWith("."), "Skill runtime has an unpackaged external dependency");
      const resolved = path.resolve(root, path.dirname(file), specifier);
      const relative = path.relative(root, resolved);
      assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "Skill runtime dependency escapes its package");
      const info = await lstat(resolved);
      assert.ok(info.isFile() && !info.isSymbolicLink(), "Skill runtime dependency must be a packaged file");
    }
  }
  return { source_files: sources.length, literal_imports: imports };
}

function projectMarkdown(source, { name, file }) {
  const originalFile = path.posix.join("skills", name, file);
  const originalRoot = `skills/${name}/`;
  let projected = source.replace(/\]\(([^\s)]+)\)/gu, (match, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)) return match;
    const [filePart, ...fragment] = target.split("#");
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(originalFile), filePart));
    assert.ok(!resolved.startsWith("../"), "Skill reference escapes the canonical bundle");
    if (resolved.startsWith(originalRoot)) return match;
    const innerTarget = `assets/runtime/${resolved}`;
    const relative = path.posix.relative(path.posix.dirname(file), innerTarget);
    return `](${relative}${fragment.length ? `#${fragment.join("#")}` : ""})`;
  });
  // 这些命令示例明确以 Skill 根目录为工作目录。
  projected = projected.replaceAll("../../cli/cfkanban.mjs", "assets/runtime/cli/cfkanban.mjs");
  return projected;
}

async function verifyArchive(bytes, { name, skillBundleRoot, originalFiles }) {
  const entries = readTarGzipEntries(bytes);
  const files = new Map(entries.filter(entry => entry.type === "file").map(entry => [entry.path, entry.data]));
  const info = metadata(files.get("SKILL.md")?.toString("utf8") ?? "");
  assert.equal(info.name, name, "Archive root must describe exactly its indexed Skill");
  const innerFiles = [...files.keys()].filter(file => file.startsWith("assets/runtime/"));
  assert.deepEqual(innerFiles.map(file => file.slice("assets/runtime/".length)).sort(), [...originalFiles].sort(), "Archive must retain the complete canonical runtime tree");
  for (const file of originalFiles) {
    assert.deepEqual(files.get(`assets/runtime/${file}`), await readFile(path.join(skillBundleRoot, file)), "Archive changed an inner canonical file");
  }
  for (const [file, content] of files) {
    if (!file.endsWith(".md") || file.startsWith("assets/runtime/")) continue;
    for (const match of content.toString("utf8").matchAll(/\]\(([^\s)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target.split("#")[0]));
      assert.ok(!resolved.startsWith("../") && files.has(resolved), "Projected Skill reference is not packaged");
    }
  }
  if (name !== "cfkanban-howto") {
    assert.equal(files.get("scripts/cfkanban-tool.mjs")?.toString("utf8"), `#!/usr/bin/env node\nimport "../assets/runtime/skills/${name}/scripts/cfkanban-tool.mjs";\n`);
  }
  return { info, file_count: files.size };
}

async function verifyHelperSmoke({ bytes, name, directory }) {
  await extractTarGzip({ bytes, directory });
  if (name === "cfkanban-howto") return null;
  const surface = name === "cfkanban" ? "daily" : name === "cfkanban-admin" ? "admin" : "deploy";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^SystemRoot$/iu.test(key)));
  try {
    const { stdout } = await run(process.execPath, [path.join(directory, "scripts/cfkanban-tool.mjs"), "help"], {
      cwd: directory, env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true,
    });
    const response = JSON.parse(stdout);
    assert.ok(response.ok === true && response.result?.schema_version === 1 && response.result.surface === surface
      && Array.isArray(response.result.commands) && response.result.commands.length > 0);
    return { surface, command_count: response.result.commands.length };
  } catch { throw new Error(`Skill archive helper smoke failed: ${name}`); }
}

export async function buildAgentSkillsDiscovery({ skillBundleRoot, outputDirectory, version }) {
  assert.ok(validVersion(version), "Skill discovery requires an exact release version");
  const originalFiles = await treeFiles(skillBundleRoot);
  const closure = await verifySkillRuntimeClosure({ skillBundleRoot });
  const required = ["packages/skill-runtime/package.json", "mcp/server.mjs", "cli/cfkanban.mjs", "web-embedded/embedded.html",
    ...["server.mjs", "launcher.mjs", "browser.mjs", "workbench.mjs", "THIRD_PARTY_NOTICES.txt", "embedded/embedded.html", "embedded/embedded-build.json", "build-metadata.json"].map(file => `local-runtime/${file}`)];
  for (const file of required) assert.ok(originalFiles.includes(file), `Incomplete canonical Skill bundle: ${file}`);
  const declaration = JSON.parse(await readFile(path.join(skillBundleRoot, "release/version.json"), "utf8"));
  assert.equal(declaration.version, version, "Canonical Skill declaration must match discovery release");
  const root = path.join(outputDirectory, "agent-skills", version);
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cfkanban-skill-archives-"));
  const index = { $schema: AGENT_SKILLS_SCHEMA, skills: [] };
  const artifacts = [];
  try {
    for (const name of AGENT_SKILL_NAMES) {
      const skillFiles = originalFiles.filter(file => file.startsWith(`skills/${name}/`));
      assert.ok(skillFiles.includes(`skills/${name}/SKILL.md`), "Missing canonical Skill");
      const archiveRoot = path.join(temporary, name);
      await cp(path.join(skillBundleRoot, "skills", name), archiveRoot, { recursive: true, dereference: false });
      for (const original of skillFiles.filter(file => file.endsWith(".md"))) {
        const file = original.slice(`skills/${name}/`.length);
        const source = await readFile(path.join(skillBundleRoot, original), "utf8");
        await writeFile(path.join(archiveRoot, file), projectMarkdown(source, { name, file }), "utf8");
      }
      await mkdir(path.join(archiveRoot, "assets"), { recursive: true });
      await cp(skillBundleRoot, path.join(archiveRoot, "assets/runtime"), { recursive: true, dereference: false });
      if (name !== "cfkanban-howto") {
        await mkdir(path.join(archiveRoot, "scripts"), { recursive: true });
        await rm(path.join(archiveRoot, "scripts/cfkanban-tool.mjs"));
        await writeFile(path.join(archiveRoot, "scripts/cfkanban-tool.mjs"), `#!/usr/bin/env node\nimport "../assets/runtime/skills/${name}/scripts/cfkanban-tool.mjs";\n`, { mode: 0o755 });
      }
      const temporaryArchive = path.join(temporary, `${name}.tar.gz`);
      const artifact = await writeDeterministicTarGzip({ root: archiveRoot, outputPath: temporaryArchive });
      const bytes = await readFile(temporaryArchive);
      const repeatedPath = path.join(temporary, `${name}-repeat.tar.gz`);
      await writeDeterministicTarGzip({ root: archiveRoot, outputPath: repeatedPath });
      assert.deepEqual(bytes, await readFile(repeatedPath), "Skill archive packaging is not reproducible");
      const verified = await verifyArchive(bytes, { name, skillBundleRoot, originalFiles });
      await mkdir(path.join(temporary, "verified"), { recursive: true });
      const helperSmoke = await verifyHelperSmoke({ bytes, name, directory: path.join(temporary, "verified", name) });
      assert.equal(artifact.sha256, digest(bytes));
      const target = path.join(root, `${name}.tar.gz`);
      try { await writeFile(target, bytes, { flag: "wx", mode: 0o644 }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        assert.deepEqual(await readFile(target), bytes, "Versioned Skill archive cannot be replaced with different bytes");
      }
      index.skills.push({ name, type: "archive", description: verified.info.description, url: `/agent-skills/${version}/${name}.tar.gz`, digest: `sha256:${artifact.sha256}` });
      artifacts.push({ name, sha256: artifact.sha256, size_bytes: artifact.size_bytes, file_count: artifact.file_count,
        directory_count: artifact.directory_count, uncompressed_size_bytes: artifact.uncompressed_size_bytes,
        file: `agent-skills/${version}/${name}.tar.gz`, reproducible: true, helper_smoke: helperSmoke });
    }
    validateAgentSkillsIndex(index, { version });
    const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
    const indexPath = path.join(root, "index.json");
    try { await writeFile(indexPath, indexBytes, { flag: "wx", mode: 0o644 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.deepEqual(await readFile(indexPath), indexBytes, "Versioned Skill index cannot be replaced with different bytes");
    }
    await verifyAgentSkillsDiscovery({ outputDirectory, version, skillBundleRoot });
    return { index, artifacts, closure };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyAgentSkillsDiscovery({ outputDirectory, version, skillBundleRoot }) {
  assert.ok(validVersion(version), "Skill discovery requires an exact release version");
  const root = path.join(outputDirectory, "agent-skills", version);
  const index = validateAgentSkillsIndex(JSON.parse(await readFile(path.join(root, "index.json"), "utf8")), { version });
  assert.deepEqual((await treeFiles(root)).sort(), ["index.json", ...AGENT_SKILL_NAMES.map(name => `${name}.tar.gz`)].sort(), "Unexpected discovery payload");
  const originalFiles = skillBundleRoot ? await treeFiles(skillBundleRoot) : null;
  for (const entry of index.skills) {
    const bytes = await readFile(path.join(root, `${entry.name}.tar.gz`));
    assert.equal(`sha256:${digest(bytes)}`, entry.digest, "Skill archive digest drift");
    if (originalFiles) await verifyArchive(bytes, { name: entry.name, skillBundleRoot, originalFiles });
    else {
      const files = readTarGzipEntries(bytes).filter(file => file.type === "file");
      assert.equal(metadata(files.find(file => file.path === "SKILL.md")?.data.toString("utf8") ?? "").name, entry.name);
    }
  }
  return index;
}
