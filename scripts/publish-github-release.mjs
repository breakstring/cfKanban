import { readFile } from "node:fs/promises";
import { publicationPlan, publishRelease } from "./lib/release-publication.mjs";
import { githubClient, verifyPublicDownload } from "./lib/github-release.mjs";

const [mode = "inspect", configPath, extra] = process.argv.slice(2);
try {
  if (!configPath || extra || !["inspect", "stage", "publish"].includes(mode)) throw new Error("Usage: node scripts/publish-github-release.mjs <inspect|stage|publish> <config.json>");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const plan = await publicationPlan(config);
  console.log(JSON.stringify({ mode, repository: plan.repository, version: plan.version, commit: plan.commit, plan_digest: plan.digest, assets: plan.assets.map(({ file, ...asset }) => asset) }));
  if (mode !== "inspect" && config.approvedPlanDigest !== plan.digest) throw new Error("Run inspect and explicitly approve that exact plan digest before a remote write");
  const result = await publishRelease({ plan, mode, github: githubClient(), verifyPublic: verifyPublicDownload, onEvent: (event) => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify(result));
} catch (error) {
  // Do not serialize arbitrary exception objects, gh stderr, command arguments or remote bodies.
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "Release publication failed" }));
  process.exitCode = 1;
}
