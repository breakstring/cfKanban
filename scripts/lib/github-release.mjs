import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAndVerifyRelease } from "../../packages/skill-runtime/src/release.mjs";
import { digest } from "./release-publication.mjs";

const exec = promisify(execFile);

export function githubClient({ executable = "gh", timeout = 60_000, run = exec } = {}) {
  const environment = { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" };
  // gh owns GitHub authentication; unrelated Cloudflare/Alibaba credentials are not needed.
  for (const name of ["ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_EMAIL", "GH_DEBUG"]) delete environment[name];
  async function api(endpoint, { method = "GET", body, file } = {}) {
    const args = ["api", endpoint, "--hostname", "github.com", "--method", method, "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (body) for (const [key, value] of Object.entries(body)) args.push(typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`);
    if (file) args.push("-H", "Content-Type: application/octet-stream", "--input", file);
    let response;
    try {
      response = await run(executable, args, { env: environment, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true });
    } catch {
      // gh stderr may contain supplier bodies or credentials. Never forward it.
      throw new Error(`GitHub ${method} failed or timed out; re-inspect the same plan before retrying any write`);
    }
    try { return JSON.parse(response.stdout); } catch { throw new Error("GitHub returned invalid JSON; re-inspect remote state"); }
  }
  async function pages(endpoint) {
    const result = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await api(`${endpoint}?per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error("Expected a paginated GitHub array");
      result.push(...data);
      if (data.length < 100) return result;
    }
    throw new Error("GitHub listing exceeded bounded pagination");
  }
  return {
    async tagCommit(plan) {
      const root = `repos/${plan.repository}`;
      let ref = (await api(`${root}/git/ref/tags/${plan.version}`)).object;
      for (let depth = 0; depth < 8; depth += 1) {
        if (ref?.type === "commit" && /^[0-9a-f]{40}$/.test(ref.sha)) return ref.sha;
        if (ref?.type !== "tag" || !/^[0-9a-f]{40}$/.test(ref.sha)) throw new Error("Remote tag does not resolve to a commit");
        ref = (await api(`${root}/git/tags/${ref.sha}`)).object;
      }
      throw new Error("Annotated tag chain exceeded the safety bound");
    },
    async findRelease(plan) {
      // List drafts as well as published releases. A failed GET is never treated as absence.
      const matches = (await pages(`repos/${plan.repository}/releases`)).filter((release) => release.tag_name === plan.version);
      if (matches.length > 1) throw new Error("Multiple releases match this tag; stop for reconciliation");
      return matches[0] ?? null;
    },
    readRelease: (plan, id) => api(`repos/${plan.repository}/releases/${id}`),
    listAssets: (plan, id) => pages(`repos/${plan.repository}/releases/${id}/assets`),
    createDraft: (plan) => api(`repos/${plan.repository}/releases`, { method: "POST", body: { tag_name: plan.version, target_commitish: plan.commit, name: plan.version, body: plan.notes, draft: true, prerelease: plan.prerelease } }),
    upload: (plan, id, asset) => api(`https://uploads.github.com/repos/${plan.repository}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`, { method: "POST", file: asset.file }),
    publish: (plan, id) => api(`repos/${plan.repository}/releases/${id}`, { method: "PATCH", body: { draft: false, make_latest: "false" } }),
  };
}

export async function verifyPublicDownload(plan, { fetchImpl = fetch } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cfkanban-public-release-"));
  try {
    for (const asset of plan.assets) {
      // Credential-free fetch. Only GitHub's documented asset redirect host is accepted.
      let url = `https://github.com/${plan.repository}/releases/download/${plan.version}/${asset.name}`;
      let bytes = null;
      for (let hops = 0; hops < 5; hops += 1) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || !["github.com", "release-assets.githubusercontent.com"].includes(parsed.hostname) || parsed.port) throw new Error("Public asset redirect origin rejected");
        const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new Error("Public redirect has no Location");
          url = new URL(location, url).href;
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`Public asset download failed: ${asset.name} HTTP ${response.status}`);
        }
        const chunks = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > asset.size) throw new Error(`Public asset exceeds expected size: ${asset.name}`);
            chunks.push(value);
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        bytes = Buffer.concat(chunks);
        break;
      }
      if (!bytes || bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error(`Public asset digest/size mismatch: ${asset.name}`);
      await writeFile(path.join(root, asset.name), bytes, { flag: "wx" });
    }
    const checked = await loadAndVerifyRelease({
      releasePointerPath: path.join(root, plan.assets[0].name),
      manifestPath: path.join(root, plan.assets[1].name),
      artifactFiles: { skill_bundle: path.join(root, plan.assets[2].name), service_deployment_bundle: path.join(root, plan.assets[3].name) },
    });
    if (!checked.verified) throw new Error("Public release verification failed");
    return { verified: true, assets: plan.assets.length, version: checked.manifest.release.version };
  } finally {
    // Only this invocation's generated, non-secret download directory is removed.
    await rm(root, { recursive: true, force: true });
  }
}
