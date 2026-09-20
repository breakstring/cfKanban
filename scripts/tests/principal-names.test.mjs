import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { requirePrincipalDisplayName, principalDisplayNameKey, requireDisplayName } from '../../apps/worker/src/domain/model.ts';
import { principalDisplayNameProblem } from '../../apps/web/src/lib/principal-display-name.ts';

import { normalizePrincipalDisplayName as runtimeName } from '../../packages/skill-runtime/src/principal-name.mjs';
import { presentApiProblem } from '../../apps/web/src/lib/error-presentation.ts';

const migration = await readFile(new URL('../../migrations/0008_principal_names.sql', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../../migrations/manifest.json', import.meta.url), 'utf8'));
async function fixture(names) {
  const db = new DatabaseSync(':memory:');
  for (const entry of manifest.migrations.filter(entry => entry.sequence < 8)) db.exec(await readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), 'utf8'));
  names.forEach((name, index) => db.prepare('INSERT INTO principals(id,display_name,created_at,updated_at) VALUES(?,?,1,1)').run(`p${index}`, name));
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','p0','test',7,1)");
  return db;
}
function apply(db) {
  db.exec('BEGIN');
  try { db.exec(migration); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('Principal rules normalize names without changing container names', () => {
  for (const [input, expected] of [[' Ｋｅｎｎ ', 'Kenn'], ['张三-研发', '张三-研发'], ['Kenn_01', 'Kenn_01'], ['Jose\u0301', 'José'], ['阿·里', '阿·里'], ['𠮷'.repeat(128), '𠮷'.repeat(128)]]) {
    assert.equal(requirePrincipalDisplayName(input), expected);
    assert.equal(principalDisplayNameProblem(input), null);
    assert.equal(runtimeName(input), expected);
  }
  assert.equal(principalDisplayNameKey('Ｋｅｎｎ'), 'kenn');
  for (const input of ['', ' ', 'a b', 'a\tb', 'a\nb', 'a\u3000b', 'a\u200bb', 'a\u202eb', 'a\ufe0fb', '@Kenn', '#Kenn', 'Kenn!', 'Kenn😀', 'ＡＤＭＩＮ', 'Owner', '系统', 'a'.repeat(129), 'İ'.repeat(65)]) {
    assert.notEqual(principalDisplayNameProblem(input), null);
    assert.throws(() => runtimeName(input), error => error.code === "VALIDATION_ERROR");
    assert.throws(() => requirePrincipalDisplayName(input), error => error.code === 'VALIDATION_ERROR' && error.details.reason === 'principal_display_name_invalid', input);
  }
  assert.equal(requireDisplayName(' My Project '), 'My Project');
});

test('schema 8 converts only legacy spaces, preserves identity references and enforces unique keys', async () => {
  const db = await fixture(['Kenn','Skill Invite Writer','陈']);
  try {
    db.exec("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES('credential','p1','test','" + 'a'.repeat(64) + "',1,'op')");
    apply(db);
    assert.deepEqual(db.prepare('SELECT display_name,display_name_key,version FROM principals ORDER BY id').all().map(row => ({...row})), [
      {display_name:'Kenn',display_name_key:'kenn',version:1},
      {display_name:'Skill_Invite_Writer',display_name_key:'skill_invite_writer',version:2},
      {display_name:'陈',display_name_key:'陈',version:1},
    ]);
    assert.equal(db.prepare('SELECT principal_id FROM credentials').get().principal_id,'p1');
    assert.equal(db.prepare('SELECT schema_version FROM instance_meta').get().schema_version,8);
    assert.throws(() => db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('collision','KENN','kenn',1,1)"), /UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO principals(id,display_name,created_at,updated_at) VALUES('missing','Missing',1,1)"), /principal_name_key_required/);
    assert.throws(() => db.exec("UPDATE principals SET display_name_key='' WHERE id='p1'"), /principal_name_key_required/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { db.close(); }
});

for (const names of [['A B','A_B'],['Kenn','KENN'],['Owner'],['José'],['a\tb'],['a\0b']]) {
  test(`schema 8 rejects unsafe baseline atomically: ${JSON.stringify(names)}`, async () => {
    const db = await fixture(names);
    try {
      const before = db.prepare('SELECT * FROM principals').all();
      assert.throws(() => apply(db), /constraint/i);
      assert.deepEqual(db.prepare('SELECT * FROM principals').all(),before);
      assert.equal(db.prepare('SELECT schema_version FROM instance_meta').get().schema_version,7);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='principal_name_migration_guard'").get(),undefined);
    } finally { db.close(); }
  });
}

test('name conflict has a localized actionable recovery without exposing machine-only instructions', () => {
  const error = {body: {category:'conflict', code:'PRINCIPAL_DISPLAY_NAME_CONFLICT', recovery:'choose_another_display_name', request_id:'test', retryable:false, source:'service'}, status:409, retryAfter:null};
  const result = presentApiProblem(error, 'zh-CN', key => key);
  assert.match(result, /更换显示名称后重新保存/);
  assert.doesNotMatch(result, /按恢复代码处理/);
});
