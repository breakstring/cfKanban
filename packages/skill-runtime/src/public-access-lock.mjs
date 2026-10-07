import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import { assertNoSymlinkPath, ensurePrivateDirectory } from "./utils.mjs";
import { validatePrivatePath } from "./state.mjs";
import { toolError } from "./errors.mjs";

export async function acquirePublicAccessLock({ stateRoot, journalsRoot, operationId, processAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
} }) {
  const directory = path.join(journalsRoot, "public-access-locks");
  await assertNoSymlinkPath(directory, stateRoot); await ensurePrivateDirectory(directory); await validatePrivatePath(directory, "directory");
  // 每次调用使用不同文件，回收死进程的旧文件不会误删另一调用刚获得的新锁。
  const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  const handle = await open(file, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, operation_id: operationId })); } finally { await handle.close(); }
    const entries = await readdir(directory);
    if (entries.length > 64) throw toolError("PUBLIC_ACCESS_LOCKED", "The local lock inventory exceeds its bound; inspect private state before continuing");
    for (const name of entries) {
      if (path.join(directory, name) === file) continue;
      if (!/^[1-9][0-9]*-[a-f0-9-]{36}\.json$/u.test(name)) throw toolError("PUBLIC_ACCESS_LOCKED", "Another public-access operation is initializing or has unverified local lock state");
      const other = path.join(directory, name);
      await assertNoSymlinkPath(other, stateRoot);
      try { await validatePrivatePath(other, "file"); }
      catch (error) { if (error.code === "ENOENT" || error.code === "STATE_PATH_INVALID" && error.details?.actualKind === "missing") continue; throw error; }
      const pid = Number(name.slice(0, name.indexOf("-")));
      if (!Number.isSafeInteger(pid) || pid < 1) throw toolError("PUBLIC_ACCESS_LOCKED", "A private lock's process identity is unverified");
      let alive;
      try { alive = processAlive(pid); } catch { throw toolError("PUBLIC_ACCESS_LOCKED", "The other public-access process could not be proven stopped"); }
      if (alive) throw toolError("PUBLIC_ACCESS_LOCKED", "Another public-access operation is active; resume after it stops");
      await rm(other, { force: true });
    }
    return () => rm(file, { force: true });
  } catch (error) { await rm(file, { force: true }); throw error; }
}
