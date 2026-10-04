import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseArguments } from '../src/parser.mjs';
import { createToolRuntimePlan } from '../../skill-runtime/src/tool-runtime.mjs';

const runtimeWords = ['deploy','runtime','plan'];
const runtimeInput = {taskId:'parser-version-fixture',npmExecutable:path.join(path.dirname(process.execPath),process.platform==='win32'?'npm.cmd':'npm')};
const runtimeFlags = ['--task-id',runtimeInput.taskId,'--npm-executable',runtimeInput.npmExecutable];
const parseJson = (words,input) => parseArguments([...words,'--input-stdin'],{stdin:Readable.from([JSON.stringify(input)])});

test('runtime plan preserves exact Wrangler versions through flags, JSON stdin and JSON files',async t=> {
  const directory=await mkdtemp(path.join(os.tmpdir(),'cfkanban-parser-version-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'input.json');
  for(const version of ['4.127.1','4.128.0-rc.1']) {
    const input={...runtimeInput,wranglerVersion:version};await writeFile(file,JSON.stringify(input));
    const parsed=[
      await parseArguments([...runtimeWords,...runtimeFlags,'--wrangler-version',version]),
      await parseJson(runtimeWords,input),
      await parseArguments([...runtimeWords,'--input-file',file]),
    ];
    for(const result of parsed) {
      assert.equal(result.input.wranglerVersion,version);assert.equal(typeof result.input.wranglerVersion,'string');
      const {plan}=createToolRuntimePlan({...result.input,runtimeRoot:path.join(directory,'tool-runtime')});assert.equal(plan.version,version);
    }
  }
});

test('runtime plan rejects floating ranges, malformed or oversized versions and JSON nonstrings',async()=> {
  const invalidStrings=['','4','4.127','4.x','latest','v4.127.1','^4.127.1','~4.127.1','4.127.1+build','4.127.1-',' 4.127.1',`1.2.3-${'a'.repeat(59)}`];
  for(const version of invalidStrings) {
    await assert.rejects(parseArguments([...runtimeWords,...runtimeFlags,'--wrangler-version',version]),{code:'CLI_INVALID_ARGUMENT'});
    await assert.rejects(parseJson(runtimeWords,{...runtimeInput,wranglerVersion:version}),{code:'CLI_INVALID_ARGUMENT'});
  }
  for(const version of [4,null,true,[],{}])await assert.rejects(parseJson(runtimeWords,{...runtimeInput,wranglerVersion:version}),{code:'CLI_INVALID_ARGUMENT'});
});

test('CAS and instance origin versions retain safe integer parsing and JSON types',async()=> {
  const instanceId=randomUUID();
  const cases=[
    {words:['issue','reopen'],flags:['--instance',instanceId,'--identifier','CFK-1','--status-key','todo'],input:{instanceId,identifier:'CFK-1',statusKey:'todo'},flag:'--expected-version',field:'expectedVersion'},
    {words:['connection','add'],flags:['--instance',instanceId,'--trusted-api-origin','https://parser-fixture.invalid','--persistence-confirmed','true'],input:{instanceId,trustedApiOrigin:'https://parser-fixture.invalid',persistenceConfirmed:true},flag:'--origin-version',field:'originVersion'},
  ];
  for(const {words,flags,input,flag,field} of cases) {
    assert.equal((await parseArguments([...words,...flags,flag,'7'])).input[field],7);
    assert.equal((await parseJson(words,{...input,[field]:7})).input[field],7);
    for(const version of ['4.127.1','1.5','-1','9007199254740992'])await assert.rejects(parseArguments([...words,...flags,flag,version]),{code:'CLI_INVALID_ARGUMENT'});
    for(const version of ['7',1.5,-1,Number.MAX_SAFE_INTEGER+1])await assert.rejects(parseJson(words,{...input,[field]:version}),{code:'CLI_INVALID_ARGUMENT'});
  }
});
