import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { validatePrivatePath } from '../../skill-runtime/src/state.mjs';
import { assertNoSymlinkPath, requireUuid } from '../../skill-runtime/src/utils.mjs';

let database;
let databasePath;
let databaseIdentity;
let recovery;
const maxDocuments = Math.min(workerData.maxDocuments ?? 200_000, 200_000);
const maxIndexBytes = Math.min(workerData.maxIndexBytes ?? 100 * 1024 * 1024, 100 * 1024 * 1024);

async function statOrMissing(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkFiles() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = `${databasePath}${suffix}`;
    await assertNoSymlinkPath(file, path.parse(file).root);
    const stat = await statOrMissing(file);
    if (!stat) continue;
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe search index file');
    if (!suffix && stat.size > maxIndexBytes) throw new Error('MCP_SEARCH_INDEX_CAPACITY_EXCEEDED');
    await validatePrivatePath(file, 'file');
    if (!suffix && databaseIdentity && (stat.dev !== databaseIdentity.dev || stat.ino !== databaseIdentity.ino)) throw new Error('Search index file changed');
  }
}

async function openDatabase(DatabaseSync) {
  database = new DatabaseSync(databasePath);
  try { database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;'); }
  catch (error) {
    database.close();
    database = null;
    if (![11, 26].includes(error.errcode)) throw error;
    await checkFiles();
    const lockPath = `${databasePath}.recovery-lock`;
    await assertNoSymlinkPath(lockPath, path.parse(lockPath).root);
    const lock = await recoveryLock(lockPath);
    recovery = { lock, lockPath, backups: [] };
    try {
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
      await validatePrivatePath(lockPath, 'file');
      await checkFiles();
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const file = `${databasePath}${suffix}`;
        if (!await statOrMissing(file)) continue;
        const backup = `${databasePath}.corrupt-${randomUUID()}${suffix}`;
        await rename(file, backup);
        recovery.backups.push(backup);
      }
      const handle = await open(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.close();
      databaseIdentity = await lstat(databasePath);
      database = new DatabaseSync(databasePath);
      database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
    } catch (failure) {
      await lock.close();
      await rm(lockPath);
      recovery = null;
      throw failure;
    }
  }
}

async function recoveryLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      await assertNoSymlinkPath(file, path.parse(file).root);
      const before = await lstat(file);
      if (!before.isFile() || before.nlink !== 1 || before.size > 32) throw new Error('Unsafe recovery lock');
      await validatePrivatePath(file, 'file');
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let pid;
      try {
        const stat = await handle.stat();
        if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 32) throw new Error('Recovery lock changed');
        pid = Number((await handle.readFile('utf8')).trim());
      } finally { await handle.close(); }
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Unverified recovery owner');
      try { process.kill(pid, 0); throw new Error('Search index recovery is running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      const after = await lstat(file);
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) throw new Error('Recovery lock changed');
      await rm(file);
    }
  }
}

async function initialize() {
  const { stateRoot, homeDirectory, identity } = workerData;
  const home = path.resolve(homeDirectory);
  const root = path.resolve(stateRoot);
  const relative = path.relative(home, root);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || /\/(?:Dropbox|OneDrive|Google Drive|Library\/Mobile Documents)(?:\/|$)/i.test(root.replaceAll('\\', '/'))) throw new Error('Unsafe search index root');
  requireUuid(identity.instance_id, 'instance_id');
  requireUuid(identity.principal_id, 'principal_id');
  const directory = path.join(root, 'search-index', identity.instance_id, identity.principal_id);
  databasePath = path.join(directory, 'index.sqlite3');
  await assertNoSymlinkPath(databasePath, path.parse(home).root);
  const homeStat = await lstat(home);
  if (!homeStat.isDirectory()) throw new Error('Invalid search index home');
  let current = home;
  for (const segment of path.relative(home, directory).split(path.sep)) {
    current = path.join(current, segment);
    if (await statOrMissing(path.join(current, '.git'))) throw new Error('Search index cannot be stored in a repository');
    if (!await statOrMissing(current)) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await assertNoSymlinkPath(current, path.parse(home).root);
    await validatePrivatePath(current, 'directory');
  }
  if (!await statOrMissing(databasePath)) {
    let handle;
    try { handle = await open(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await handle?.close(); }
  }
  await checkFiles();
  databaseIdentity = await lstat(databasePath);
  const { DatabaseSync } = await import('node:sqlite');
  await openDatabase(DatabaseSync);
  const pageSize = database.prepare('PRAGMA page_size').get().page_size;
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || !Number.isSafeInteger(maxIndexBytes) || maxIndexBytes < pageSize * 16) throw new Error('Invalid search index capacity');
  database.exec(`PRAGMA max_page_count=${Math.floor(maxIndexBytes / pageSize)}`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, fence INTEGER NOT NULL, expires INTEGER NOT NULL);
    INSERT OR IGNORE INTO lease VALUES(1,NULL,0,0);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL,
      active_generation INTEGER, active_cursor TEXT, active_revision INTEGER NOT NULL DEFAULT 0,
      pending_generation INTEGER, pending_cursor TEXT, pending_phase TEXT
    );
    CREATE TABLE IF NOT EXISTS documents (
      project_id TEXT NOT NULL, generation INTEGER NOT NULL, id TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, title_search TEXT NOT NULL, revision INTEGER NOT NULL, removed INTEGER NOT NULL,
      PRIMARY KEY(project_id,generation,id)
    );
    CREATE INDEX IF NOT EXISTS document_number ON documents(number);
  `);
  transaction(() => {
    const stored = database.prepare('SELECT value FROM metadata WHERE key=?').get('identity')?.value;
    const binding = JSON.stringify(identity);
    if (stored && stored !== binding) {
      database.exec('DELETE FROM projects; DELETE FROM documents; DELETE FROM metadata; UPDATE lease SET owner=NULL,fence=fence+1,expires=0;');
    }
    database.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('identity', binding);
  });
  await checkFiles();
  if (recovery) {
    for (const backup of recovery.backups) {
      const stat = await lstat(backup);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe recovered search index');
      await validatePrivatePath(backup, 'file');
      await rm(backup);
    }
    await recovery.lock.close();
    await rm(recovery.lockPath);
    recovery = null;
  }
}

function transaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try { const value = callback(); database.exec('COMMIT'); return value; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}

function assertLease(token, now) {
  const lease = database.prepare('SELECT * FROM lease WHERE id=1').get();
  if (lease.owner !== token.owner || lease.fence !== token.fence || lease.expires <= now) throw new Error('SEARCH_LEASE_LOST');
}

function leased(token, now, callback) {
  return transaction(() => {
    assertLease(token, now);
    database.prepare('UPDATE lease SET expires=? WHERE id=1').run(now + token.duration);
    return callback();
  });
}

const setMeta = (key, value) => database.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key, String(value));
const getMeta = key => database.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;

function applyDocuments(projectId, generation, items) {
  const statement = database.prepare(`INSERT INTO documents(project_id,generation,id,number,title,title_search,revision,removed)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,generation,id) DO UPDATE SET
    number=excluded.number,title=excluded.title,title_search=excluded.title_search,revision=excluded.revision,removed=excluded.removed
    WHERE excluded.revision >= documents.revision`);
  for (const item of items) {
    requireUuid(item.id, 'issue_id');
    if (item.project_id !== projectId || !Number.isSafeInteger(item.number) || item.number < 1
      || !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.title !== 'string' || item.title.length > 10000
      || (item.kind !== undefined && !['upsert', 'remove'].includes(item.kind))) throw new Error('Invalid search index document');
    const removed = item.kind === 'remove';
    statement.run(projectId, generation, item.id, item.number, removed ? '' : item.title,
      removed ? '' : item.title.normalize('NFKC').toLocaleLowerCase('en-US'), item.revision, removed ? 1 : 0);
  }
}

function configure({ status, token, now }) {
  return leased(token, now, () => {
    if (status.projection_version !== 1 || typeof status.epoch !== 'string' || typeof status.scope_key !== 'string' || !Array.isArray(status.projects)) throw new Error('Invalid search index status');
    const scopeChanged = getMeta('scope_key') !== status.scope_key;
    if (getMeta('epoch') !== status.epoch || getMeta('projection_version') !== '1') database.exec('DELETE FROM projects; DELETE FROM documents;');
    setMeta('epoch', status.epoch);
    setMeta('projection_version', 1);
    setMeta('scope_key', status.scope_key);
    setMeta('configured', 1);
    const ids = new Set(status.projects.map(project => requireUuid(project.id, 'project_id')));
    for (const old of database.prepare('SELECT id FROM projects').all()) {
      if (!ids.has(old.id)) {
        database.prepare('DELETE FROM documents WHERE project_id=?').run(old.id);
        database.prepare('DELETE FROM projects WHERE id=?').run(old.id);
      }
    }
    for (const project of status.projects) {
      requireUuid(project.workspace?.id, 'workspace_id');
      if (typeof project.display_name !== 'string' || typeof project.workspace.display_name !== 'string') throw new Error('Invalid search index container');
      database.prepare(`INSERT INTO projects(id,display_name,workspace_id,workspace_name) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,workspace_id=excluded.workspace_id,workspace_name=excluded.workspace_name`)
        .run(project.id, project.display_name, project.workspace.id, project.workspace.display_name);
    }
    return status.projects.map(project => ({ ...project, scope_changed: scopeChanged,
      ...database.prepare('SELECT active_cursor,active_revision,pending_cursor,pending_phase FROM projects WHERE id=?').get(project.id) }));
  });
}

function begin({ project_id, cursor, reset, token, now }) {
  return leased(token, now, () => {
    const project = database.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    if (!project) throw new Error('Unknown search index project');
    if (project.pending_generation !== null && !reset) return { phase: project.pending_phase, cursor: project.pending_cursor };
    if (project.active_generation !== null && !reset) return { phase: 'changes', cursor: project.active_cursor };
    const generation = Math.max(project.active_generation ?? 0, project.pending_generation ?? 0) + 1;
    database.prepare('DELETE FROM documents WHERE project_id=? AND generation<>?').run(project_id, project.active_generation ?? -1);
    database.prepare('UPDATE projects SET pending_generation=?,pending_cursor=?,pending_phase=? WHERE id=?').run(generation, cursor, 'snapshot', project_id);
    return { phase: 'snapshot', cursor };
  });
}

function apply({ project_id, phase, expected_cursor, page, token, now }) {
  return leased(token, now, () => {
    const project = database.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
    const pending = project?.pending_generation !== null;
    const cursor = pending ? project.pending_cursor : project?.active_cursor;
    if (!project || cursor !== expected_cursor || (pending ? project.pending_phase : 'changes') !== phase
      || typeof page.next_cursor !== 'string' || !page.next_cursor || typeof page.has_more !== 'boolean'
      || !Array.isArray(page.items) || page.items.length > 100) throw new Error('SEARCH_CURSOR_CONFLICT');
    const generation = pending ? project.pending_generation : project.active_generation;
    applyDocuments(project_id, generation, page.items);
    if (pending) {
      if (phase === 'snapshot' || page.has_more) {
        database.prepare('UPDATE projects SET pending_cursor=?,pending_phase=? WHERE id=?')
          .run(page.next_cursor, phase === 'snapshot' && !page.has_more ? 'changes' : phase, project_id);
      } else {
        if (!Number.isSafeInteger(page.revision) || page.revision < 0) throw new Error('Invalid search index revision');
        database.prepare(`UPDATE projects SET active_generation=pending_generation,active_cursor=?,active_revision=?,
          pending_generation=NULL,pending_cursor=NULL,pending_phase=NULL WHERE id=?`).run(page.next_cursor, page.revision, project_id);
        database.prepare('DELETE FROM documents WHERE project_id=? AND generation<>?').run(project_id, generation);
      }
    } else {
      if (!Number.isSafeInteger(page.revision) || page.revision < project.active_revision) throw new Error('Invalid search index revision');
      // 响应 revision 是服务端 head；分页尚未追平时不能据此跳过下一轮剩余增量。
      const confirmedRevision = page.has_more ? project.active_revision : page.revision;
      database.prepare('UPDATE projects SET active_cursor=?,active_revision=? WHERE id=?').run(page.next_cursor, confirmedRevision, project_id);
    }
    if (phase === 'changes' && !page.has_more) database.prepare('DELETE FROM documents WHERE project_id=? AND generation=? AND removed=1').run(project_id, generation);
    if (database.prepare('SELECT count(*) AS total FROM documents').get().total > maxDocuments) throw new Error('MCP_SEARCH_INDEX_CAPACITY_EXCEEDED');
    return { phase: phase === 'snapshot' && !page.has_more ? 'changes' : phase, cursor: page.next_cursor, complete: phase === 'changes' && !page.has_more };
  });
}

function search({ query }) {
  if (getMeta('configured') !== '1' || database.prepare('SELECT 1 FROM projects WHERE active_generation IS NULL LIMIT 1').get()) return { warming: true };
  let predicate, values, exact = 0;
  if (query.kind === 'identifier') {
    const match = /^CFK-([1-9]\d*)$/.exec(query.identifier ?? '');
    if (!match) throw new Error('Invalid identifier');
    exact = Number(match[1]);
    const prefix = match[1].length >= 2 && !query.exactOnly;
    predicate = prefix ? '(d.number=? OR CAST(d.number AS TEXT) LIKE ?)' : 'd.number=?';
    values = prefix ? [exact, `${match[1]}%`] : [exact];
  } else if (query.kind === 'prefix') {
    if (!/^\d{2,16}$/.test(query.prefix ?? '')) throw new Error('Invalid identifier prefix');
    predicate = 'CAST(d.number AS TEXT) LIKE ?'; values = [`${query.prefix}%`];
  } else if (query.kind === 'title') {
    if (typeof query.text !== 'string' || query.text.length < 2 || query.text.length > 512) throw new Error('Invalid title query');
    const text = query.text.normalize('NFKC').toLocaleLowerCase('en-US').replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    predicate = "d.title_search LIKE ? ESCAPE '\\'"; values = [`%${text}%`];
  } else throw new Error('Invalid search query');
  const items = database.prepare(`SELECT d.id,d.number,d.title,p.id AS project_id,p.display_name,p.workspace_id,p.workspace_name
    FROM documents d JOIN projects p ON p.id=d.project_id AND p.active_generation=d.generation
    WHERE d.removed=0 AND ${predicate} ORDER BY CASE WHEN d.number=? THEN 0 ELSE 1 END,d.number,d.id LIMIT 10`).all(...values, exact)
    .map(item => ({ id: item.id, number: item.number, identifier: `CFK-${item.number}`, title: item.title,
      project: { id: item.project_id, display_name: item.display_name }, workspace: { id: item.workspace_id, display_name: item.workspace_name } }));
  return { warming: false, items };
}

async function command(message) {
  await checkFiles();
  if (getMeta('identity') !== JSON.stringify(workerData.identity)) throw new Error('Search index identity changed');
  if (message.command === 'search') return search(message);
  if (message.command === 'acquire') return transaction(() => {
    const lease = database.prepare('SELECT * FROM lease WHERE id=1').get();
    if (lease.owner && lease.expires > message.now) return null;
    const token = { owner: message.owner, fence: lease.fence + 1, duration: message.duration };
    database.prepare('UPDATE lease SET owner=?,fence=?,expires=? WHERE id=1').run(token.owner, token.fence, message.now + token.duration);
    return token;
  });
  if (message.command === 'release') return transaction(() => {
    database.prepare('UPDATE lease SET owner=NULL,expires=0 WHERE id=1 AND owner=? AND fence=?').run(message.token.owner, message.token.fence);
    return true;
  });
  if (message.command === 'configure') return configure(message);
  if (message.command === 'begin') return begin(message);
  if (message.command === 'apply') return apply(message);
  if (message.command === 'clear') return leased(message.token, message.now, () => database.exec('DELETE FROM documents; DELETE FROM projects; DELETE FROM metadata WHERE key<>\'identity\';'));
  throw new Error('Unknown search index command');
}

let pending = initialize().catch(async error => {
  if (recovery) {
    await recovery.lock.close().catch(() => undefined);
    await rm(recovery.lockPath).catch(() => undefined);
    recovery = null;
  }
  throw error;
});
pending.then(() => parentPort.postMessage({ ready: true }), error => parentPort.postMessage({ ready: false,
  error: error.message === 'MCP_SEARCH_INDEX_CAPACITY_EXCEEDED' ? error.message : 'MCP_SEARCH_INDEX_UNAVAILABLE' }));
parentPort.on('message', message => {
  pending = pending.then(async () => {
    try { const result = await command(message); await checkFiles(); parentPort.postMessage({ id: message.id, result }); }
    catch (error) {
      const code = error.errcode === 13 ? 'MCP_SEARCH_INDEX_CAPACITY_EXCEEDED'
        : ['SEARCH_LEASE_LOST', 'SEARCH_CURSOR_CONFLICT', 'MCP_SEARCH_INDEX_CAPACITY_EXCEEDED'].includes(error.message) ? error.message : 'MCP_SEARCH_INDEX_UNAVAILABLE';
      parentPort.postMessage({ id: message.id, error: code });
    }
  });
});
