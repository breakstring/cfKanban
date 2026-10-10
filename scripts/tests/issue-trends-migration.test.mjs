import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { backfillIssueTrends, replayTrendHistory } from "../../apps/worker/src/services/issue-trend-projection.ts";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const sql = await readFile(new URL("../../migrations/0029_issue_trends.sql", import.meta.url), "utf8");
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 29)
  .map(entry => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
const day = value => Date.parse(`2026-01-${String(value).padStart(2,"0")}T12:00:00Z`);
function fixture() {
  const db = new DatabaseSync(":memory:"); for (const part of previous) db.exec(part);
  db.exec(`INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','TrendOwner','trendowner',1,1);
    INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',28,1);
    INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('w','Trends',1,1,'owner','owner','w');
    INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('p','w','Trends',1,1,'owner','owner','p');`);
  return db;
}
function issue(db, id, status='todo', timestamp=day(1)) {
  db.prepare(`INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?,'p',?,'trend',?,?,?,'owner','owner',?)`).run(id,id,status,timestamp,timestamp,id);
}
function event(db, id, type, payload, timestamp) {
  db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
    VALUES(?,'domain',?,?,0,'deployment_owner','w','p','issue',?,?,?)`).run(randomUUID(),type,randomUUID(),id,JSON.stringify(payload),timestamp);
}
function adapter(sqlite, hook=()=>{}) {
  const database={ prepare(sql) {
    let values=[];
    return { bind(...args){ values=args; return this; }, async all(){ return { results:sqlite.prepare(sql).all(...values), meta:{} }; },
      async first(){ return sqlite.prepare(sql).get(...values)??null; },
      execute(){ hook(sql); return { results:[], meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)} }; } };
  }, async batch(statements){ sqlite.exec('BEGIN'); try { const result=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return result; }
    catch(error){sqlite.exec('ROLLBACK');throw error;} } }; return database;
}
const totals=db=>({...db.prepare("SELECT total,done,canceled FROM issue_trend_totals WHERE project_id='p' AND milestone_key=''").get()});
test('migration captures old current state and replays exact history once without changing current totals',async()=>{
  const db=fixture();try{
    issue(db,'i','done');event(db,'i','issue.created',{status_key:'todo',milestone_id:null},day(1));
    event(db,'i','issue.completed',{old_status_key:'todo',new_status_key:'done'},day(3));
    db.exec(sql);assert.deepEqual(totals(db),{total:1,done:1,canceled:0});
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version,29);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM issue_trend_backfill").get().n,1);
    const database=adapter(db);await backfillIssueTrends(database);
    assert.deepEqual(totals(db),{total:1,done:1,canceled:0});
    const days=db.prepare("SELECT date,total_delta,done_delta,created,completed FROM issue_trend_days ORDER BY date").all().map(row=>({...row}));
    assert.deepEqual(days,[{date:'2026-01-01',total_delta:1,done_delta:0,created:1,completed:0},{date:'2026-01-03',total_delta:0,done_delta:1,created:0,completed:1}]);
    assert.equal(db.prepare("SELECT partial,pending_jobs FROM issue_trend_projects").get().partial,0);
    assert.equal(db.prepare("SELECT stock_from FROM issue_trend_projects").get().stock_from,'1970-01-01');
    assert.deepEqual(await backfillIssueTrends(database),{processed:0,finished:0});
    assert.deepEqual(db.prepare("SELECT date,total_delta,done_delta,created,completed FROM issue_trend_days ORDER BY date").all().map(row=>({...row})),days);
  }finally{db.close();}
});
test('future writes use cache while frozen old job remains independent, and title events write no projection',async()=>{
  const db=fixture();try{
    issue(db,'i');event(db,'i','issue.created',{status_key:'todo',milestone_id:null},day(1));db.exec(sql);
    db.exec("UPDATE issues SET status_key='done' WHERE id='i'");event(db,'i','issue.completed',{old_status_key:'todo',new_status_key:'done'},day(5));
    assert.deepEqual(totals(db),{total:1,done:1,canceled:0});
    assert.equal(db.prepare("SELECT status_key FROM issue_trend_backfill").get().status_key,'todo');
    const before=db.prepare('SELECT total_changes() n').get().n;event(db,'i','issue.updated',{status_changed:false},day(6));
    assert.equal(db.prepare('SELECT total_changes() n').get().n-before,1);
    await backfillIssueTrends(adapter(db));
    assert.equal(db.prepare("SELECT SUM(completed) n FROM issue_trend_days WHERE milestone_key=''").get().n,1);
    assert.equal(db.prepare("SELECT SUM(created) n FROM issue_trend_days WHERE milestone_key=''").get().n,1);
    assert.deepEqual(totals(db),{total:1,done:1,canceled:0});
    db.exec("BEGIN; UPDATE issues SET status_key='todo' WHERE id='i';");event(db,'i','issue.updated',{status_changed:true,old_status_key:'done',new_status_key:'todo'},day(7));db.exec('ROLLBACK');
    assert.deepEqual(totals(db),{total:1,done:1,canceled:0});
  }finally{db.close();}
});
test('missing created and inconsistent histories mark conservative partial boundaries',async()=>{
  for(const mode of ['missing','status']){
    const db=fixture();try{
      issue(db,'i','done');if(mode!=='missing')event(db,'i','issue.created',mode==='initial'?{}:{status_key:'todo'},day(1));
      event(db,'i','issue.completed',mode==='status'?{old_status_key:'todo',new_status_key:'canceled'}:{old_status_key:'todo',new_status_key:'done'},day(3));
      db.exec(sql);await backfillIssueTrends(adapter(db));
      const row=db.prepare('SELECT * FROM issue_trend_projects').get();assert.equal(row.partial,1);assert.equal(row.pending_jobs,0);
      assert.equal(row.stock_from,'2026-01-03');assert.equal(row.flow_from,'2026-01-04');
    }finally{db.close();}
  }
});
test('legacy created payload may omit initial status when the complete state chain proves it',async()=>{
  const db=fixture();try{
    issue(db,'i','done');event(db,'i','issue.created',{},day(1));
    event(db,'i','issue.completed',{old_status_key:'todo',new_status_key:'done'},day(3));
    db.exec(sql);await backfillIssueTrends(adapter(db));
    assert.equal(db.prepare('SELECT partial FROM issue_trend_projects').get().partial,0);
    assert.equal(db.prepare("SELECT SUM(created) n FROM issue_trend_days WHERE milestone_key=''").get().n,1);
    assert.equal(db.prepare("SELECT SUM(completed) n FROM issue_trend_days WHERE milestone_key=''").get().n,1);
  }finally{db.close();}
});
test('backfill batches page by sequence and losing CAS competitors cannot double count',async()=>{
  const db=fixture();try{
    issue(db,'i');event(db,'i','issue.created',{status_key:'todo',milestone_id:null},day(1));
    for(let n=0;n<105;n++)event(db,'i','issue.updated',{status_changed:false},day(2));
    db.exec(sql);const database=adapter(db);
    assert.deepEqual(await backfillIssueTrends(database),{processed:1,finished:0});
    assert.deepEqual(await Promise.all([backfillIssueTrends(database),backfillIssueTrends(database)]),[{processed:1,finished:1},{processed:0,finished:0}]);
    assert.equal(db.prepare("SELECT SUM(created) n FROM issue_trend_days WHERE milestone_key=''").get().n,1);
  }finally{db.close();}
});
test('sequence and event time inversion creates a gap rather than fabricating chronological stock',()=>{
  const job={issue_id:'i',project_id:'p',cursor:10,status_key:'done',milestone_id:null,active:1,created_at:day(1),last_date:'2026-01-10',oldest_date:'2026-01-10',ceiling_date:'2026-01-10',version:1};
  const result=replayTrendHistory(job,[{sequence:9,type:'issue.completed',created_at:day(3),payload_json:JSON.stringify({old_status_key:'todo',new_status_key:'done'})},
    {sequence:8,type:'issue.created',created_at:day(5),payload_json:JSON.stringify({status_key:'todo',milestone_id:null})}]);
  assert.equal(result.partial,true);assert.equal(result.stockFrom,'2026-01-05');assert.equal(result.flowFrom,'2026-01-06');
});
test('unknown prefixes retain proven suffixes and gather their actual latest timestamp across bounded pages',async()=>{
  for(const inverted of[false,true]){
    const db=fixture();try{
      issue(db,'i','done');event(db,'i','issue.created',{status_key:'todo'},day(1));
      if(inverted)event(db,'i','issue.updated',{},day(5));
      for(let index=0;index<150;index++)event(db,'i','issue.updated',{},day(2));
      event(db,'i','issue.completed',{old_status_key:'todo',new_status_key:'done'},day(3));db.exec(sql);
      const database=adapter(db);assert.equal((await backfillIssueTrends(database)).finished,0);
      const pending=db.prepare('SELECT uncertain,unknown_latest_date FROM issue_trend_backfill').get();
      assert.equal(pending.uncertain,1);assert.equal(pending.unknown_latest_date,'2026-01-02');
      assert.equal((await backfillIssueTrends(database)).finished,1);
      const coverage=db.prepare('SELECT stock_from,flow_from,partial FROM issue_trend_projects').get();
      assert.deepEqual({...coverage},{stock_from:inverted?'2026-01-05':'2026-01-02',flow_from:inverted?'2026-01-06':'2026-01-03',partial:1});
      assert.equal(db.prepare("SELECT completed FROM issue_trend_days WHERE date='2026-01-03' AND milestone_key=''").get().completed,1);
    }finally{db.close();}
  }
});
test('deadlines stop starting work without leaving background writes or advancing job watermarks',async()=>{
  assert.deepEqual(await backfillIssueTrends({prepare(){throw new Error('should not query');}},8,{deadline:Date.now()-1}),{processed:0,finished:0});
  const db=fixture();try{
    issue(db,'i');event(db,'i','issue.created',{status_key:'todo'},day(1));db.exec(sql);
    const options={deadline:Date.now()+60000},base=adapter(db);
    const observed=new Proxy(base,{get(target,key){if(key==='prepare')return sql=>{
      const statement=target.prepare(sql);
      if(sql.includes('idx_events_issue_trend_history'))return new Proxy(statement,{get(value,name){
        if(name==='bind')return(...args)=>{statement.bind(...args);return new Proxy(statement,{get(inner,item){if(item==='all')return async()=>{const result=await inner.all();options.deadline=Date.now()-1;return result;};return inner[item];}});};return value[name];}});
      return statement;
    };return target[key];}});
    const before=db.prepare('SELECT cursor,version FROM issue_trend_backfill').get();
    assert.deepEqual(await backfillIssueTrends(observed,8,options),{processed:0,finished:0});
    assert.deepEqual(db.prepare('SELECT cursor,version FROM issue_trend_backfill').get(),before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_trend_days').get().n,0);
  }finally{db.close();}
});
test('non-decreasing history cursors terminate conservatively instead of retrying the same page forever',()=>{
  const job={issue_id:'i',project_id:'p',cursor:10,status_key:'todo',milestone_id:null,active:1,created_at:day(1),last_date:'2026-01-10',oldest_date:'2026-01-10',ceiling_date:'2026-01-10',version:1};
  const result=replayTrendHistory(job,[{sequence:10,type:'issue.updated',created_at:day(2),payload_json:'{}'}]);
  assert.equal(result.finished,true);assert.equal(result.partial,true);assert.equal(result.stockFrom,'2026-01-10');
});
