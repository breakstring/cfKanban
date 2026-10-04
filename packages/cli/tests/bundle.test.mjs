import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';
import { installVerifiedSkillBundle } from '../../skill-runtime/src/skill-update.mjs';
import { sha256Bytes } from '../../skill-runtime/src/utils.mjs';
import { writeDeterministicZip } from '../../../scripts/lib/deterministic-zip.mjs';
import { buildEmbeddedDocument } from '../../../apps/web/scripts/build-embedded.mjs';
import { buildLocalRuntime } from '../../local-runtime/scripts/build.mjs';
const execute=promisify(execFile);
const root=fileURLToPath(new URL('../../../',import.meta.url));
test('clean canonical bundle runs public help/version and opens its verified local Web runtime',async t=> {
  const fixture=await createMcpStateFixture(t);
  // 避免 macOS 的 /tmp 别名掩盖打包后 import.meta.url 与入口路径相同的行为。
  const f={...fixture,home:await realpath(fixture.home),stateRoot:await realpath(fixture.stateRoot)};
  const source=path.join(f.home,'source');
  const version=JSON.parse(await readFile(path.join(root,'release/version.json'),'utf8')).version;
  await execute(process.execPath,[path.join(root,'packages/cli/scripts/build.mjs')],{cwd:root,timeout:30000});
  await buildEmbeddedDocument();
  const localBuild=await buildLocalRuntime({outputDirectory:path.join(f.home,'fresh-local-runtime'),version});
  for(const entry of ['packages/skill-runtime','skills','.codex-plugin']) {await mkdir(path.dirname(path.join(source,entry)),{recursive:true});await cp(path.join(root,entry),path.join(source,entry),{recursive:true});}
  await mkdir(path.join(source,'release'),{recursive:true});await writeFile(path.join(source,'release/version.json'),JSON.stringify({version}));
  await cp(path.join(root,'packages/cli/dist'),path.join(source,'cli'),{recursive:true});
  await cp(localBuild.outputDirectory,path.join(source,'local-runtime'),{recursive:true});
  const zip=path.join(f.home,'bundle.zip');await writeDeterministicZip({root:source,outputPath:zip,prefix:`cfkanban-skills-${version}/`});
  const installed=await installVerifiedSkillBundle({bundlePath:zip,version,expectedSha256:sha256Bytes(await readFile(zip)),publisher:'https://github.com',source:`https://github.com/breakstring/cfKanban/releases/download/${version}/cfkanban-skills-${version}.zip`,releaseRoot:path.join(f.stateRoot,'skill-releases')});
  const binary=path.join(installed.path,'cli/cfkanban.mjs');
  const environment={HOME:f.home,USERPROFILE:f.home,...Object.fromEntries(Object.entries(process.env).filter(([key])=>/^SystemRoot$/i.test(key)))};
  for(const args of [[],['help','cli','--json'],['--version','--json']]) {const output=await execute(process.execPath,[binary,...args],{env:environment,timeout:15000,maxBuffer:1024*1024});assert.match(output.stdout,/cfkanban/);assert.equal(output.stderr,'');if(args.includes('--json'))assert.equal(JSON.parse(output.stdout).schema_version,1);}
  const target={kind:'project',workspace_id:f.workspaceId,project_id:f.projectId};
  const script=path.join(f.home,'isolated-runner.mjs');
  await writeFile(script,`const nativeFetch=globalThis.fetch;\nglobalThis.fetch=async(url,options={})=>{const parsed=new URL(url);if(parsed.hostname==='127.0.0.1')return nativeFetch(url,options);if(parsed.origin!==${JSON.stringify(f.origin)})throw Error('Network outside fixture');if(parsed.pathname==='/.well-known/cfkanban-instance.json')return Response.json(${JSON.stringify(f.discovery)});if(parsed.pathname==='/api/v1/me')return Response.json(${JSON.stringify(f.me(f.credential))});if(parsed.pathname.endsWith('/projects/${f.projectId}'))return Response.json({id:${JSON.stringify(f.projectId)},workspace_id:${JSON.stringify(f.workspaceId)},version:1,allowed_actions:['read']});throw Error('Unexpected fixture read');};\nprocess.argv=[process.execPath,${JSON.stringify(binary)},'web','open','--instance',${JSON.stringify(f.instanceId)},'--directory',${JSON.stringify(f.home)},'--target',${JSON.stringify(JSON.stringify(target))},'--delivery','host_browser','--json'];\nawait import(${JSON.stringify(binary)});\n`);
  const child=spawn(process.execPath,[script],{env:environment,stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
  const events=[];let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);let pending='';let resolveEvent;const eventPromise=new Promise(resolve=>resolveEvent=resolve);
  child.stdout.on('data',chunk=>{pending+=chunk.toString();for(;;){const index=pending.indexOf('\n');if(index<0)break;const line=pending.slice(0,index);pending=pending.slice(index+1);const event=JSON.parse(line);events.push(event);if(event.event==='browser_relay_ready')resolveEvent(event);}});
  const deadline=setTimeout(()=>resolveEvent(null),15000);const relay=await eventPromise;clearTimeout(deadline);assert.ok(relay,`Public CLI failed before local delivery: ${stderr}`);
  // This is an isolated HTTP navigation fixture; it does not claim visual browser verification.
  const delivered=await fetch(relay.local_url,{redirect:'manual',headers:{'sec-fetch-site':'none','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});assert.equal(delivered.status,303);
  const cookie=delivered.headers.get('set-cookie').split(';')[0];const page=await fetch(new URL(delivered.headers.get('location'),relay.local_url),{headers:{cookie}});assert.equal(page.status,200);assert.match(await page.text(),/<html/i);
  await new Promise(resolve=>{const poll=()=>events.some(event=>event.schema_version===1)?resolve():setTimeout(poll,10);poll();});
  const result=events.find(event=>event.schema_version===1);assert.equal(result.ok,true);assert.equal(result.result.mode,'local');assert.equal(result.result.release_version,version);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));child.kill('SIGTERM');await closed;assert.equal(stderr,'');
});
