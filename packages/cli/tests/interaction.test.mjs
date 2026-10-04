import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { COMMANDS } from '../src/catalog.mjs';
import { commandFields, parseArguments, validateCommandInput } from '../src/parser.mjs';
import { candidateLabel, createTerminalSelector } from '../src/interaction.mjs';
import { helpDocument, main, renderHelp } from '../src/main.mjs';
import { toolError } from '../../skill-runtime/src/errors.mjs';

const instance='11111111-1111-4111-8111-111111111111';
const workspace='22222222-2222-4222-8222-222222222222';
const project='33333333-3333-4333-8333-333333333333';
const command=name=>COMMANDS.find(entry=>entry.name===name);
function output(tty=false) {
  let text='';const stream=new Writable({write(chunk,encoding,callback){text+=chunk.toString();callback();}});
  stream.isTTY=tty;
  return {stream,text:()=>text};
}
async function invoke(argv,{tty=false,stdin=Readable.from([]),runtime={execute:async()=>({ok:true,data:{}})}}={}) {
  stdin.isTTY=tty;const stdout=output(tty),stderr=output(tty);
  const code=await main(argv,{stdin,stdout:stdout.stream,stderr:stderr.stream,runtime});
  return {code,stdout:stdout.text(),stderr:stderr.text()};
}

test('contextual IDs defer missing checks, while supplied IDs and business fields stay strict',async()=> {
  const parsed=await parseArguments(['issue','create','--title','Review release']);
  assert.deepEqual(parsed.input,{title:'Review release'});
  for(const name of ['instance','workspace-id','project-id'])assert.equal(commandFields(parsed.command)[name].contextual,true);
  assert.throws(()=>validateCommandInput(parsed.command,parsed.input),{code:'CLI_MISSING_ARGUMENT'});
  const filled={...parsed.input,instanceId:instance,workspace_id:workspace,project_id:project};
  assert.equal(validateCommandInput(parsed.command,filled),filled);
  await assert.rejects(parseArguments(['issue','create']),{code:'CLI_MISSING_ARGUMENT'});
  await assert.rejects(parseArguments(['issue','create','--title','x','--project-id','not-a-uuid']),{code:'CLI_INVALID_ARGUMENT'});
  await assert.rejects(parseArguments(['issue','create','--title','x','--instance','not-a-uuid']),{code:'CLI_INVALID_ARGUMENT'});
  await assert.rejects(parseArguments(['comment','create','--identifier','CFK-1','--body',`cfi_v1_abcdefgh_${'A'.repeat(43)}`]),{code:'CLI_SECRET_INPUT_REJECTED'});
  const json=await parseArguments(['issue','create','--input-stdin'],{stdin:Readable.from([JSON.stringify({title:'JSON issue'})])});
  assert.equal(json.stdinConsumed,true);assert.deepEqual(json.input,{title:'JSON issue'});
});

test('purge targets and identity, deployment and recovery inputs remain explicit',async()=> {
  const purge=command('project purge'),fields=commandFields(purge);
  assert.equal(fields.instance.contextual,true);
  assert.equal(fields['workspace-id'].contextual,undefined);assert.equal(fields['project-id'].contextual,undefined);
  await assert.rejects(parseArguments(['project','purge','--confirm-name','project','--preview-digest','a'.repeat(64)]),{code:'CLI_MISSING_ARGUMENT'});
  const parsed=await parseArguments(['project','purge','--workspace-id',workspace,'--project-id',project,'--confirm-name','project','--preview-digest','a'.repeat(64)]);
  assert.equal(parsed.input.instanceId,undefined);
  for(const name of ['owner device list','identity pending','operation recover','connection add','deploy upgrade plan']) {
    const field=commandFields(command(name))['instance-id'];
    assert.equal(field.contextual,undefined,name);
    assert.throws(()=>validateCommandInput(command(name),{},{allowContext:true}),{code:'CLI_MISSING_ARGUMENT'},name);
  }
  assert.equal(commandFields(command('attachment upload'))['instance-id'].contextual,true);
  assert.equal((await parseArguments(['scope','inspect'])).input.directory,undefined);
});

test('ID aliases work both ways without turning project list filters into single targets',async()=> {
  const parsed=await parseArguments(['issue','create','--instance-id',instance,'--workspace',workspace,'--project',project,'--title','x']);
  assert.deepEqual(parsed.input,{instanceId:instance,workspace_id:workspace,project_id:project,title:'x'});
  const helper=await parseArguments(['attachment','download','--instance',instance,'--attachment-id',project,'--output-path','./file.txt']);
  assert.equal(helper.input.instanceId,instance);
  const listed=await parseArguments(['issue','list','--project',project,'--project',workspace]);
  assert.deepEqual(listed.input.project,[project,workspace]);assert.equal(listed.input.project_id,undefined);
  await assert.rejects(parseArguments(['issue','list','--project-id',project]),{code:'CLI_UNKNOWN_OPTION'});
  await assert.rejects(parseArguments(['issue','show','--identifier','CFK-1','--instance',instance,'--instance-id',instance]),{code:'CLI_DUPLICATE_OPTION'});
  await assert.rejects(parseArguments(['issue','create','--title','x','--project',project,'--project-id',project]),{code:'CLI_DUPLICATE_OPTION'});
});

test('interaction globals are exclusive and stdin transports are reported',async()=> {
  assert.equal((await parseArguments(['issue','list'])).interactive,null);
  assert.equal((await parseArguments(['issue','list','--interactive'])).interactive,true);
  assert.equal((await parseArguments(['--no-interactive','issue','list'])).interactive,false);
  for(const flags of [['--interactive','--no-interactive'],['--interactive','--interactive'],['--no-interactive','--no-interactive']])await assert.rejects(parseArguments(['issue','list',...flags]),error=>['CLI_CONFLICTING_INPUT','CLI_DUPLICATE_OPTION'].includes(error.code));
  const comment=await parseArguments(['comment','create','--identifier','CFK-1','--body-stdin'],{stdin:Readable.from(['Markdown'])});
  assert.equal(comment.stdinConsumed,true);
  const invitation=await parseArguments(['join','invite','--redeem-as','new_principal','--capability-stdin'],{stdin:Readable.from(['https://fixture.invalid/invite?code=opaque'])});
  assert.equal(invitation.stdinConsumed,true);
  const file=await parseArguments(['comment','create','--identifier','CFK-1','--body-file','comment.md'],{fileRead:async()=> 'Markdown'});
  assert.equal(file.stdinConsumed,false);
  const global=await parseArguments(['context','use','--global','true','--project',project]);
  assert.equal(global.input.global,true);assert.equal(global.input.project_id,project);
  await assert.rejects(parseArguments(['context','use','--global','maybe']),{code:'CLI_INVALID_ARGUMENT'});
});

test('main offers selection only to TTY humans without JSON or stdin input',async()=> {
  for(const {argv,tty} of [
    {argv:['issue','list'],tty:false},
    {argv:['issue','list','--interactive'],tty:false},
    {argv:['issue','list','--json','--interactive'],tty:true},
    {argv:['issue','list','--no-interactive'],tty:true},
    {argv:['comment','create','--identifier','CFK-1','--body-stdin','--interactive'],tty:true},
    {argv:['issue','create','--input-stdin'],tty:true},
  ]) {
    const stdin=Readable.from(argv.includes('--input-stdin')?[JSON.stringify({title:'x'})]:['Markdown']);let calls=0;
    const result=await invoke(argv,{tty,stdin,runtime:{execute:async(selected,input,options)=>{calls++;assert.equal(options.select,null);return {ok:true,data:{}};}}});
    assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(calls,1);
  }
  const stdin=new PassThrough();stdin.isTTY=true;const stdout=output(false),stderr=output(true);
  const code=await main(['issue','list'],{stdin,stdout:stdout.stream,stderr:stderr.stream,runtime:{execute:async(selected,input,options)=>{assert.equal(options.select,null);return {ok:true,data:{}};}}});
  assert.equal(code,0);stdin.end();
});

test('TTY selection displays safe names, origins and IDs and returns the original object',async()=> {
  const stdin=new PassThrough(),candidate={display_name:'Project A',trusted_api_origin:'https://kanban.example.com',instance_id:instance,workspace_id:workspace,project_id:project};
  const candidates=[candidate,{...candidate,display_name:'Project B'}];
  const result=await invoke(['issue','create','--title','x'],{tty:true,stdin,runtime:{execute:async(selected,input,{select})=> {
    assert.equal(typeof select,'function');const choice=select({kind:'project',candidates});setImmediate(()=>stdin.write('2\n'));
    assert.equal(await choice,candidates[1]);return {ok:true,data:{title:'x'}};
  }}});
  stdin.end();assert.equal(result.code,0);assert.match(result.stderr,/Project A/);assert.match(result.stderr,/https:\/\/kanban.example.com/);assert.match(result.stderr,new RegExp(project));assert.doesNotMatch(result.stdout,/Select|Enter a number/);
  const secret=`cfi_v1_abcdefgh_${'A'.repeat(43)}`;
  assert.equal(candidateLabel({display_name:secret,origin:'https://fixture.invalid/?token=opaque',project_id:'bad'}),'[redacted]');
  assert.doesNotMatch(candidateLabel({display_name:'\u001b[31mProject\nname',project_id:project}),/[\u001b\n]/);
});

test('selection cancellation and EOF return a nonzero stable error without requesting a write',async()=> {
  for(const answer of ['q\n',null]) {
    const stdin=new PassThrough();let writes=0;
    const result=await invoke(['issue','create','--title','x','--locale','zh-CN'],{tty:true,stdin,runtime:{execute:async(selected,input,{select})=> {
      const promise=select({kind:'project',candidates:[{display_name:'Project A',project_id:project}]});setImmediate(()=>answer===null?stdin.end():stdin.write(answer));await promise;writes++;return {ok:true};
    }}});
    stdin.end();assert.equal(result.code,2);assert.equal(writes,0);assert.match(result.stderr,/CLI_SELECTION_CANCELLED: 已取消选择/);
  }
});

test('selection observes AbortSignal and closes the prompt',async()=> {
  const stdin=new PassThrough(),stderr=output(),abort=new AbortController();
  const select=createTerminalSelector({stdin,stderr:stderr.stream,signal:abort.signal});
  const promise=select({kind:'instance',candidates:[{instance_id:instance}]});abort.abort();
  await assert.rejects(promise,{code:'CLI_SELECTION_CANCELLED'});select.close();stdin.end();
});

test('safe parser hints survive parse failure and respect Chinese locale',async()=> {
  const missing=await invoke(['issue','create','--locale','zh-CN']);
  assert.equal(missing.code,2);assert.match(missing.stderr,/缺少 --title/);assert.match(missing.stderr,/issue create --help/);
  const typo=await invoke(['issue','list','--local','zh-CN','--locale','zh-CN']);
  assert.equal(typo.code,2);assert.match(typo.stderr,/未知选项 --local；请使用 --locale en\|zh-CN/);
  const json=await invoke(['issue','list','--wat','value','--locale=zh-CN','--json']);
  assert.equal(json.code,2);assert.match(JSON.parse(json.stderr).result.error.message,/未知选项 --wat/);
  const secret=`cfi_v1_abcdefgh_${'A'.repeat(43)}`;
  const unsafe=await invoke(['issue','list',`--${secret}`,'value']);assert.doesNotMatch(unsafe.stderr,new RegExp(secret));
  const conflicting=await invoke(['issue','list','--interactive','--no-interactive']);assert.equal(conflicting.code,2);
});

test('runtime exceptions remain generic, while controlled context candidates stay actionable',async()=> {
  const secret='private unstructured exception';
  const generic=await invoke(['issue','list','--json'],{runtime:{execute:async()=>{throw new Error(secret);}}});
  assert.equal(generic.code,7);assert.doesNotMatch(generic.stderr,new RegExp(secret));
  const result=await invoke(['issue','list','--locale','zh-CN'],{runtime:{execute:async()=>{throw toolError('CLI_CONTEXT_SELECTION_REQUIRED',secret,{kind:'project',candidates:[{display_name:'Project A',project_id:project}],next_commands:[`cfkanban issue list --project ${project}`]});}}});
  assert.equal(result.code,2);assert.doesNotMatch(result.stderr,new RegExp(secret));assert.match(result.stderr,/匹配到多个目标/);assert.match(result.stderr,/Project A/);assert.match(result.stderr,/下一步: cfkanban issue list/);
});

test('resolved context is concise in human output and retained in JSON',async()=> {
  const resolved_context={instance_id:instance,workspace_id:workspace,project_id:project,source:'repository'};
  const runtime={execute:async()=>({ok:true,resolved_context,data:{items:[{identifier:'CFK-1',title:'Issue'}]}})};
  const human=await invoke(['issue','list','--locale','zh-CN'],{runtime});
  assert.match(human.stdout,/范围:/);assert.match(human.stdout,/repository/);assert.match(human.stdout,new RegExp(project));assert.match(human.stdout,/CFK-1/);assert.doesNotMatch(human.stdout,/"resolved_context"/);
  const json=await invoke(['issue','list','--json'],{runtime});assert.deepEqual(JSON.parse(json.stdout).result.resolved_context,resolved_context);
  const shown=await invoke(['context','show'],{runtime:{execute:async()=>({ok:true,resolved_context,data:{resolved_context,status:'resolved',repo_targets:[{instance_id:instance,workspace_id:workspace,project_id:project}],scope_file:'/fixture/.cfkanban-scope.json'}})}});
  assert.match(shown.stdout,/Directory scope: \/fixture/);assert.doesNotMatch(shown.stdout,/"source"|"resolved_context"|"sources"/);
});

test('help stays offline, marks contextual fields and gives command examples without repeated deployment notes',async()=> {
  for(const locale of ['en','zh-CN']) {
    const document=helpDocument('issue create',locale);
    const field=document.commands[0].options.find(option=>option.field==='instanceId');
    assert.equal(field.required,true);assert.equal(field.contextual,true);assert.match(document.commands[0].examples[0],/cfkanban issue create --title/);
    const rendered=renderHelp(document);assert.match(rendered,locale==='zh-CN'?/可从上下文自动解析/:/can resolve from context/);assert.doesNotMatch(rendered,/Deployment:|部署:|CAS-only recovery/);
    const unread={async *[Symbol.asyncIterator](){assert.fail('Help consumed stdin');}};
    const result=await invoke(['context','--help','--locale',locale],{stdin:unread,runtime:{execute:()=>assert.fail('Help reached runtime')}});
    assert.equal(result.code,0);assert.match(result.stdout,/context use/);
  }
  for(const entry of helpDocument().commands)assert.ok(entry.examples?.some(example=>example.startsWith(`cfkanban ${entry.name}`)),entry.name);
});

test('default help prioritizes business workflows while advanced and JSON keep the full catalog',async()=> {
  const document=helpDocument(),usual=renderHelp(document),advanced=renderHelp(document,{advanced:true});
  assert.match(usual,/Daily workflow: issue list → issue show/);assert.match(usual,/web open opens the current Project/);
  for(const group of ['context','issue','project','workspace','join','connection'])assert.match(usual,new RegExp(`^  ${group}\\s`,'m'));
  for(const group of ['scope','identity','owner','cli','deploy','operation']) {assert.doesNotMatch(usual,new RegExp(`^  ${group}\\s`,'m'));assert.match(advanced,new RegExp(`^  ${group}\\s`,'m'));}
  assert.match(usual,/cfkanban help --advanced/);assert.match(advanced,/Worker rollback does not roll back D1/);
  assert.ok(usual.indexOf('  context ')<usual.indexOf('  issue '));
  const projects=renderHelp(helpDocument('project'));assert.match(projects,/project restore/);assert.doesNotMatch(projects,/^  project purge\s/m);
  const cli=renderHelp(helpDocument('cli'));assert.match(cli,/follows the Skills version/);assert.match(cli,/cli status/);assert.doesNotMatch(cli,/^  cli install\s/m);
  const fullCli=renderHelp(helpDocument('cli'),{advanced:true});assert.match(fullCli,/^  cli install\s/m);assert.match(fullCli,/^  cli uninstall\s/m);
  const direct=renderHelp(helpDocument('owner device prepare'));assert.match(direct,/cfkanban owner device prepare \[options\]/);
  const result=await invoke(['help','--json']);assert.equal(JSON.parse(result.stdout).result.commands.length,COMMANDS.length);
  const group=await invoke(['cli','--help','--json']);assert.equal(JSON.parse(group.stdout).result.commands.length,COMMANDS.filter(command=>command.name.startsWith('cli ')).length);
  assert.equal((await parseArguments(['help','--advanced'])).advanced,true);
  assert.equal((await parseArguments(['owner','--advanced'])).help,true);
  await assert.rejects(parseArguments(['issue','list','--advanced']),{code:'CLI_INVALID_ARGUMENT'});
  await assert.rejects(parseArguments(['help','--advanced','--advanced']),{code:'CLI_DUPLICATE_OPTION'});
});

test('web open can defer its Project target and accepts ordinary single target options',async()=> {
  const parsed=await parseArguments(['web','open']);
  const target=commandFields(parsed.command).target;assert.equal(target.required,true);assert.equal(target.contextual,true);
  assert.throws(()=>validateCommandInput(parsed.command,{instanceId:instance}),{code:'CLI_MISSING_ARGUMENT'});
  validateCommandInput(parsed.command,{instanceId:instance,target:{kind:'project',workspace_id:workspace,project_id:project}});
  const explicit=await parseArguments(['web','open','--workspace',workspace,'--project',project]);
  assert.equal(explicit.input.workspace_id,workspace);assert.equal(explicit.input.project_id,project);
  assert.equal(helpDocument('web open').commands[0].examples[0],'cfkanban web open');
  assert.match(renderHelp(helpDocument('web open','zh-CN')),/打开当前项目看板/);
});

test('exact help shows relevant human options and keeps machine inputs in advanced help',async()=> {
  for(const locale of ['en','zh-CN']) {
    const instanceHelp=await invoke(['instance','info','--help','--locale',locale],{runtime:{execute:()=>assert.fail('Help reached runtime')}});
    assert.equal(instanceHelp.code,0);
    assert.match(instanceHelp.stdout,/--instance/);
    assert.doesNotMatch(instanceHelp.stdout,/Service write contract|服务写合同|--operation-id|--allow-unfiltered|--body-file|--body-stdin|--input-file|--input-stdin/);
    assert.match(instanceHelp.stdout,/cfkanban instance info --help --advanced/);
    const advanced=renderHelp(helpDocument('instance info',locale),{advanced:true});
    assert.match(advanced,/--input-file PATH \| --input-stdin/);
    assert.doesNotMatch(advanced,/Service write contract|服务写合同|--operation-id|--allow-unfiltered|--body-file|--body-stdin/);
    const context=renderHelp(helpDocument('context use',locale));
    assert.doesNotMatch(context,/--body-file|--body-stdin|--input-file|--input-stdin|11111111/);
    assert.match(context,/--project-id/);assert.match(context,/--global/);assert.match(context,/--interactive/);
    assert.match(context,locale==='zh-CN'?/示例: cfkanban context use\n/:/Example: cfkanban context use\n/);
    assert.match(context,/cfkanban context use --help --advanced/);
    assert.match(context,locale==='zh-CN'?/终端遇到多个候选时可选择/:/select among candidates in a terminal/);
  }
  for(const name of ['issue list','issue candidates'])assert.match(renderHelp(helpDocument(name)),/--allow-unfiltered/);
  for(const name of ['issue counts','project list','profile show','workspace show'])assert.doesNotMatch(renderHelp(helpDocument(name)),/--allow-unfiltered|--body-file|--operation-id/);
  for(const name of ['issue create','comment create','issue complete','project update'])assert.match(renderHelp(helpDocument(name)),/--body-file PATH \| --body-stdin/);
  assert.doesNotMatch(renderHelp(helpDocument('invite create')),/--body-file|--body-stdin/);
  const write=renderHelp(helpDocument('issue create'));assert.doesNotMatch(write,/--operation-id|--idempotency-key/);
  const advancedWrite=renderHelp(helpDocument('issue create'),{advanced:true});assert.match(advancedWrite,/--operation-id/);assert.match(advancedWrite,/--idempotency-key/);
  assert.match(renderHelp(helpDocument('operation show')),/--operation-id \*/);
  const json=await invoke(['instance','info','--help','--json']);
  const metadata=JSON.parse(json.stdout).result.commands[0];
  assert.equal(metadata.write_contract,'read');assert.ok(metadata.options.some(option=>option.flag==='--operation-id'));assert.ok(metadata.options.some(option=>option.flag==='--allow-unfiltered'));
  assert.equal(helpDocument('context use').commands[0].examples[0],'cfkanban context use');
});
