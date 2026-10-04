import { COMMANDS } from './catalog.mjs';
import { argumentDiagnostic, commandFields, parseArguments } from './parser.mjs';
import { createCliRuntime, redactOutput } from './runtime.mjs';
import { canSelect, candidateLabel, createTerminalSelector, safeLabel } from './interaction.mjs';

export const VERSION=typeof __CFKANBAN_CLI_VERSION__==='undefined'?'source':__CFKANBAN_CLI_VERSION__;
export const EXIT_CODES=Object.freeze({success:0,validation:2,authentication:3,authorization:4,conflict:5,outcome_unknown:6,platform_failure:7,not_found:8});
const zh={instance:'实例',profile:'个人资料',notification:'通知',admin:'管理',event:'事件',workspace:'工作区',project:'项目',issue:'Issue',attachment:'附件',comment:'评论',label:'标签',relation:'关系',invite:'邀请',owner:'Owner',grant:'授权',passkey:'通行密钥',join:'加入',connection:'连接',scope:'目录关联',identity:'身份',board:'看板',deploy:'部署',operation:'操作恢复',cli:'CLI安装',list:'列表',show:'查看',create:'创建',update:'修改',delete:'删除',restore:'恢复',archive:'归档',purge:'永久清除',complete:'完成',reopen:'重开',block:'标记阻塞',unblock:'解除阻塞',candidates:'候选项',counts:'统计',context:'上下文',preferences:'偏好',configure:'设置',acknowledge:'确认收到',publish:'发布',withdraw:'撤回',administrator:'管理员',member:'成员',add:'添加',remove:'移除',rename:'改名',revoke:'撤销',upload:'上传',download:'下载',device:'设备',prepare:'准备',verify:'核验',request:'请求',rotate:'轮换',origin:'来源',limits:'限额',homepage:'首页',usage:'用量',snapshot:'快照',plan:'计划',apply:'执行',resume:'继续',recover:'恢复',pending:'待验证',inspect:'检查',associate:'关联',resolve:'解析',install:'安装',status:'状态',rollback:'回退',uninstall:'卸载'};
function description(command,locale) {
  if(command.name==='web open')return locale==='zh-CN'?'打开当前项目看板':'Open the current Project board';
  return locale==='zh-CN'?command.name.split(' ').map(word=>({use:'使用',clear:'清除',web:'看板',open:'打开'}[word]??zh[word]??word)).join(' / '):command.description??command.name;
}
function commandExample(command) {
  const common={'issue list':'cfkanban issue list --limit 20','issue candidates':'cfkanban issue candidates --limit 20','issue create':"cfkanban issue create --title 'Review release'",'issue show':'cfkanban issue show --identifier CFK-1','issue update':"cfkanban issue update --identifier CFK-1 --title 'Updated title'",'issue complete':"cfkanban issue complete --identifier CFK-1 --summary 'Implemented and verified'",'comment create':"cfkanban comment create --identifier CFK-1 --body-file comment.md",'context show':'cfkanban context show','context clear':'cfkanban context clear','context use':'cfkanban context use','scope inspect':'cfkanban scope inspect','connection list':'cfkanban connection list','web open':'cfkanban web open'};
  if(common[command.name])return common[command.name];
  const fields=Object.entries(commandFields(command)).filter(([,field])=>field.required&&!field.contextual);
  if(fields.some(([,field])=>Array.isArray(field.schema?.type)||field.schema?.type==='object'))return `cfkanban ${command.name} --input-file ${command.name.replaceAll(' ','-')}.json${command.sensitiveStdin?' --capability-stdin':''}`;
  const exampleValue=([flag,field])=> {
    if(field.schema?.enum)return field.schema.enum[0];
    if(field.schema?.format==='uuid')return '11111111-1111-4111-8111-111111111111';
    if(field.schema?.pattern==='^[a-f0-9]{64}$')return 'a'.repeat(64);
    if(field.schema?.type==='boolean')return 'true';
    if(field.schema?.type==='integer'||field.schema?.type==='number')return String(Math.max(1,field.schema.minimum??0));
    if(field.name==='wranglerVersion')return '4.0.0';
    if(/identifier$/.test(field.name))return 'CFK-1';
    if(/(?:Path|Root|Directory)$/.test(field.name)||field.name==='directory')return './';
    if(/(?:Origin|origin)$/.test(field.name))return 'https://kanban.example.com';
    if(/(?:display_name|Name|title|body|summary)$/.test(field.name))return "'Example text'";
    return flag.toUpperCase().replaceAll('-','_');
  };
  return `cfkanban ${command.name}${fields.map(field=>` --${field[0]} ${exampleValue(field)}`).join('')}${command.sensitiveStdin?' --capability-stdin':''}`;
}
export function helpDocument(prefix='',locale='en',version=VERSION) {
  const commands=COMMANDS.filter(command=>!prefix||command.name===prefix||command.name.startsWith(`${prefix} `));
  const exact=commands.find(command=>command.name===prefix);
  return {schema_version:1,name:'cfkanban',version,locale,offline:true,prefix,documentation_url:`https://github.com/breakstring/cfKanban/blob/${version==='source'?'feat/v1.9':version}/apps/docs/${locale==='zh-CN'?'zh-CN':'en'}/cli/index.md`,description:locale==='zh-CN'?'面向人类与Agent的cfKanban公共命令；服务端权限为准':'Public cfKanban commands for people and Agents; Service permissions remain authoritative',exit_codes:EXIT_CODES,commands:commands.map(command=>({name:command.name,description:description(command,locale),effect:command.effect,...(command.write_contract?{write_contract:command.write_contract}:{}),options:Object.entries(commandFields(command)).map(([flag,field])=>({flag:`--${flag}`,field:field.name,required:field.required===true,contextual:field.contextual===true,schema:field.schema??null})),examples:[commandExample(command)],...(command.sensitiveStdin?{sensitive_input:'--capability-stdin'}:{})})),exact:exact?.name??null};
}
const usualGroups=new Set(['context','issue','project','workspace','join','connection','comment','profile','notification','attachment','label','relation','grant','invite','web','admin']);
function commonHelpCommand(command,prefix) {
  if(!prefix)return usualGroups.has(command.name.split(' ')[0]);
  if(command.name.includes('purge'))return false;
  if(command.name.startsWith('connection '))return ['connection list','connection add','connection discover'].includes(command.name);
  if(command.name.startsWith('scope '))return command.name!=='scope resolve';
  if(command.name.startsWith('identity '))return false;
  if(command.name.startsWith('owner device '))return ['owner device list','owner device revoke','owner device rename'].includes(command.name);
  if(command.name.startsWith('cli '))return command.name==='cli status';
  if(command.name.startsWith('deploy '))return ['deploy plan','deploy apply','deploy resume','deploy upgrade plan','deploy upgrade apply','deploy upgrade resume','deploy attach plan','deploy attach apply','deploy recovery plan','deploy recovery apply'].includes(command.name);
  if(command.name==='web preflight')return false;
  return true;
}
function exactHelpSemantics(command) {
  const source=COMMANDS.find(entry=>entry.name===command.name);
  const fields=commandFields(source);
  const body=fields.body??fields.summary??fields.context;
  const acceptsText=schema=>schema?.type==='string'||Array.isArray(schema?.type)&&schema.type.includes('string')||schema?.anyOf?.some(acceptsText)||schema?.oneOf?.some(acceptsText);
  return {
    readOnly:source.effect==='read',
    api:!!source.apiPath,
    textBody:acceptsText(body?.schema)===true,
    unfiltered:source.operation==='listIssues'||source.operation==='listIssueCandidates'||source.helper==='scope resolve',
    selectable:source.workflow==='context-use'||Object.values(fields).some(field=>field.required&&field.contextual),
  };
}
function visibleExactOption(option,semantics,advanced) {
  if(option.field==='allowUnfiltered')return semantics.unfiltered;
  if(option.field==='operationId'&&semantics.api&&semantics.readOnly)return false;
  if(!advanced&&!option.required&&['operationId','idempotencyKey'].includes(option.field))return false;
  return true;
}
export function renderHelp(document,{advanced=false}={}) {
  const chinese=document.locale==='zh-CN';
  const lines=[`cfkanban ${document.version}`,document.description,''];
  if(!document.prefix) {
    lines.push(chinese?'上手: context show查看范围 → profile show核验身份 → issue list开始工作；多候选时用 context use选择默认范围':'Start: context show inspects scope → profile show verifies identity → issue list starts work; use context use to select defaults',chinese?'日常流程: issue list查待办 → issue show看详情 → issue create新建 → comment create留记录 → issue complete完成':'Daily workflow: issue list → issue show → issue create → comment create → issue complete',chinese?'看板: web open打开当前项目。范围管理: workspace / project / grant / invite / admin':'Board: web open opens the current Project. Scope management: workspace / project / grant / invite / admin');
    if(advanced)lines.push(chinese?'高级: 身份恢复、Owner设备、部署计划与本机注册诊断':'Advanced: identity recovery, Owner devices, deployment plans and local registration diagnostics');
    lines.push(`Docs: ${document.documentation_url}`,'');
  }
  if(!document.prefix||document.prefix==='context')lines.push(chinese?'上下文: 显式参数优先；唯一实例和目录范围可自动解析。实例/工作区可确定时无需选择项目。':'Context: explicit options take precedence; a unique instance and directory scope can resolve automatically. Instance or Workspace commands do not require a Project choice.',chinese?'多候选: 人类TTY可选择；--json、非TTY、stdin输入或 --no-interactive 返回候选与下一步，不提示。':'Multiple candidates: terminal users can select; --json, non-TTY, stdin input or --no-interactive return candidates and next steps without prompting.',chinese?'默认范围: context use；查看 context show；清除 context clear；--global true明确保存全局默认。':'Defaults: context use; inspect with context show; remove with context clear; --global true explicitly saves a global default.','');
  if(document.prefix==='cli'||document.prefix.startsWith('cli '))lines.push(chinese?'CLI随Skills版本更新。此兼容命令组用于查看状态或修复PATH注册；通常无需单独安装、卸载或升级CLI。':'The CLI follows the Skills version. This compatibility group inspects status or repairs PATH registration; routine use does not require separate CLI installation, removal or upgrades.','');
  if(document.prefix==='deploy upgrade'||document.prefix.startsWith('deploy upgrade '))lines.push(chinese?'升级沿用当前可信实例地址，支持自定义域名；执行前核对冻结计划、域名与身份，完成后读回版本和资源。':'Upgrade uses the current trusted Instance address, including custom domains; verify the frozen plan, origin and identity before applying, then read back versions and resources.','');
  if(document.exact) {
    const command=document.commands.find(command=>command.name===document.exact);
    const semantics=exactHelpSemantics(command);
    lines.push(`cfkanban ${command.name} [options]`,command.description,`${chinese?'影响':'Effect'}: ${command.effect}`,'');
    if(command.write_contract&&!semantics.readOnly)lines.push(`${chinese?'服务写合同':'Service write contract'}: ${command.write_contract}`,'');
    for(const option of command.options.filter(option=>visibleExactOption(option,semantics,advanced))) lines.push(`  ${option.flag}${option.required&&!option.contextual?' *':''} ${option.schema?.enum?option.schema.enum.join('|'):option.schema?.type??'value'}${option.contextual?chinese?'（可从上下文自动解析）':' (can resolve from context)':''}`);
    if(command.sensitive_input) lines.push('  --capability-stdin');
    if(advanced)lines.push('  --input-file PATH | --input-stdin');
    if(semantics.textBody)lines.push('  --body-file PATH | --body-stdin');
    lines.push('  --json --locale en|zh-CN');
    if(semantics.selectable)lines.push('  --interactive | --no-interactive');
    if(command.name==='context use')lines.push('',chinese?'省略ID时自动解析唯一范围；终端遇到多个候选时可选择。默认仅保存当前目录；--global true保存全局默认。':'Omit IDs to resolve a unique scope or select among candidates in a terminal. Saves a directory default; --global true saves a global default.');
    lines.push('',`${chinese?'示例':'Example'}: ${command.examples[0]}`);
    if(command.sensitive_input)lines.push(chinese?'邀请链接仅通过安全stdin；不放入参数、普通JSON或文件。':'Invite URLs use secure stdin only; keep them out of arguments, ordinary JSON and files.');
    if(command.name.startsWith('deploy '))lines.push(chinese?'云端写入需完整计划绑定授权；没有 --yes。':'Cloud writes require full plan-bound authorization; there is no --yes.');
    if(command.name.startsWith('operation '))lines.push(chinese?'恢复沿原身份/目标/请求；CAS-only冲突不能证明原写未提交，需要准确审计。':'Recovery retains the original identity, targets and request; CAS-only conflicts do not prove rejection and require exact audit.');
  } else {
    const depth=document.prefix?document.prefix.split(' ').length:0;
    const entries=new Map();
    const displayed=document.commands.filter(command=>advanced||commonHelpCommand(command,document.prefix));
    if(!document.prefix&&!advanced)displayed.sort((left,right)=>[...usualGroups].indexOf(left.name.split(' ')[0])-[...usualGroups].indexOf(right.name.split(' ')[0]));
    for(const command of displayed) { const words=command.name.split(' '); const name=words.slice(0,depth+1).join(' '); if(!entries.has(name))entries.set(name,command); }
    for(const [name,command]of entries) lines.push(`  ${name.padEnd(30)} ${description({name,description:command.description},document.locale)}`);
    if(!entries.size) lines.push(document.commands.length?chinese?'此组为高级操作；使用 --advanced 查看完整帮助。':'This group contains advanced operations; use --advanced for full help.':chinese?'没有匹配的命令':'No matching command');
  }
  if(!document.exact) {
    const example=document.commands.find(command=>advanced||commonHelpCommand(command,document.prefix))?.examples[0];
    lines.push('',chinese?'逐级帮助: cfkanban issue --help → cfkanban issue create --help':'Progressive help: cfkanban issue --help → cfkanban issue create --help');
    if(example)lines.push(`${chinese?'示例':'Example'}: ${example}`);
  }
  if(!advanced) {
    const help=document.exact?`cfkanban ${document.exact} --help --advanced`:document.prefix?`cfkanban ${document.prefix} --help --advanced`:'cfkanban help --advanced';
    lines.push('',`${chinese?'高级选项':'Advanced options'}: ${help}`,`${chinese?'完整机器目录':'Full machine catalog'}: cfkanban help --json`);
  } else {
    if(!document.exact||exactHelpSemantics(document.commands.find(command=>command.name===document.exact)).textBody)lines.push('',chinese?'正文支持 --body-file 或 --body-stdin；一次性链接仅经专用安全输入/交付。':'Bodies use --body-file or --body-stdin; one-time links use dedicated secure input and delivery.');
    lines.push(chinese?'未知写结果沿原身份/目标/请求恢复；CAS-only冲突仍需准确审计，cache-refresh未知时不自动重复。':'Recover unknown writes with the original identity, targets and request; CAS-only conflicts still require exact audit, and unknown cache refreshes are not replayed.',chinese?'部署写入需先查看完整计划/费用并提供绑定授权；Worker回退不回退D1，不自动恢复数据库。':'Deployment writes require a reviewed plan, costs and bound authorization; Worker rollback does not roll back D1, and database restore is never automatic.');
  }
  return `${lines.join('\n')}\n`;
}
export function exitCode(result) {
  if(result.outcome_unknown||result.committed_unverified)return EXIT_CODES.outcome_unknown;
  if(result.ok===false)return EXIT_CODES[result.error?.category]??EXIT_CODES.platform_failure;
  if(result.operation?.ok===false)return exitCode(result.operation);
  if(result.verification?.ok===false)return exitCode(result.verification);
  return EXIT_CODES.success;
}
function renderResult(result,locale) {
  const chinese=locale==='zh-CN';
  if(result.ok===false) return `${chinese?'操作未完成':'Operation failed'}: ${result.error?.code??'ERROR'}\n${chinese?'恢复':'Recovery'}: ${result.error?.recovery??'inspect retained operation'}${result.recovery?`\n${JSON.stringify(result.recovery)}`:''}\n`;
  if(result.outcome_unknown||result.committed_unverified) return `${chinese?'写入结果待核实':'Write result needs verification'}\n${JSON.stringify(result.recovery??{},null,2)}\n`;
  const data=result.data??result;
  if(data.resolved_context) {
    const lines=[`${chinese?'状态':'Status'}: ${safeLabel(data.status??'resolved')}`];
    if(data.resolved_context.source==='explicit')lines.push(`${chinese?'范围':'Scope'}: ${candidateLabel(data.resolved_context)} (explicit)`);
    if(data.scope_file)lines.push(`${chinese?'目录关联':'Directory scope'}: ${safeLabel(data.scope_file)}`);
    for(const target of data.repo_targets??[])lines.push(`  ${candidateLabel(target)}`);
    if(data.saved_context)lines.push(`${chinese?'目录默认':'Directory default'}: ${candidateLabel(data.saved_context.target??data.saved_context)}`);
    if(data.global_context)lines.push(`${chinese?'全局默认':'Global default'}: ${candidateLabel(data.global_context.target??data.global_context)}`);
    for(const candidate of data.candidates??[])lines.push(`  ${candidateLabel(candidate)}`);
    return `${lines.join('\n')}\n`;
  }
  if(data.items) return `${data.items.map(item=>[item.identifier??item.id,item.title??item.display_name??item.name??'',item.status_key??''].filter(Boolean).join('  ')).join('\n')}\n${data.next_cursor?`${chinese?'下一页游标':'Next cursor'}: ${data.next_cursor}\n`:''}`;
  return `${JSON.stringify(data,null,2)}\n`;
}
function renderContext(context,locale) {
  if(!context||typeof context!=='object')return '';
  const sources=typeof context.source==='string'?[safeLabel(context.source)]:Object.values(context.sources??context.source??{}).filter(value=>typeof value==='string').map(safeLabel);
  if(!sources.some(source=>source&&source!=='explicit'))return '';
  const targets=Array.isArray(context.targets)?context.targets:Array.isArray(context.resolved_scope)?context.resolved_scope:[context];
  const labels=[candidateLabel(context),...targets.map(candidateLabel),...(context.project_ids??[]).map(project_id=>candidateLabel({project_id}))].filter(Boolean);
  return `${locale==='zh-CN'?'范围':'Scope'}: ${[...new Set(labels)].join('; ')} (${[...new Set(sources)].join(', ')})\n`;
}
const contextErrors={
  CLI_CONTEXT_SELECTION_REQUIRED:['Several targets match; pass exact IDs or use cfkanban context use.','匹配到多个目标；请提供准确ID，或用 cfkanban context use 选择默认范围。'],
  CLI_CONTEXT_CONFLICT:['Context conflicts with the selected target; inspect cfkanban context show or clear the saved default.','上下文与所选目标冲突；请查看 cfkanban context show，或清除已保存的默认范围。'],
  CLI_CONTEXT_STALE:['The saved target is no longer available; inspect cfkanban context show and select an available target.','已保存的目标不可用；请查看 cfkanban context show 并选择可用目标。'],
  CLI_CONTEXT_UNAVAILABLE:['Context could not be resolved; pass exact IDs or inspect cfkanban context show.','无法解析上下文；请提供准确ID，或查看 cfkanban context show。'],
  CLI_CONTEXT_CANDIDATE_LIMIT:['Too many targets match; pass an exact Workspace or Project ID.','匹配目标过多；请提供准确的工作区或项目ID。'],
  CLI_SELECTION_CANCELLED:['Selection cancelled.','已取消选择。'],
  CLI_CONTEXT_SELECTION_CANCELLED:['Selection cancelled.','已取消选择。'],
};
const errorCode=error=>typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)?error.code:'CLI_RUNTIME_FAILED';
function safeContextDetails(details) {
  if(!details||typeof details!=='object')return {};
  const result={};
  if(['instance','workspace','project'].includes(details.kind))result.kind=details.kind;
  if(Array.isArray(details.candidates))result.candidates=details.candidates.map(candidate=>({label:candidateLabel(candidate),...Object.fromEntries(['instance_id','workspace_id','project_id'].filter(key=>typeof candidate?.[key]==='string'&&/^[0-9a-f-]{36}$/i.test(candidate[key])).map(key=>[key,candidate[key]]))}));
  if(Array.isArray(details.next_commands))result.next_commands=details.next_commands.map(safeLabel).filter(command=>command.startsWith('cfkanban ')&&command!=='[redacted]');
  return result;
}
function requestedLocale(argv) {
  let locale='en';
  for(let index=0;index<argv.length;index++) {
    const value=argv[index]==='--locale'?argv[index+1]:argv[index].startsWith('--locale=')?argv[index].slice(9):null;
    if(value==='en'||value==='zh-CN')locale=value;
  }
  return locale;
}
export async function main(argv=process.argv.slice(2),{stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,runtime=null}={}) {
  const abortController=new AbortController();
  const cancel=()=>abortController.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  runtime??=createCliRuntime({signal:abortController.signal});
  let parsed,select=null;
  try {
    parsed=await parseArguments(argv,{stdin});
    if(parsed.version) { stdout.write(parsed.json?`${JSON.stringify({schema_version:1,ok:true,result:{name:'cfkanban',version:VERSION,node_range:'>=22.12.0'}})}\n`:`cfkanban ${VERSION}\n`); return 0; }
    if(parsed.help) { const document=helpDocument(parsed.prefix==='howto'?'':parsed.prefix,parsed.locale); stdout.write(parsed.json?`${JSON.stringify({schema_version:1,ok:true,result:document})}\n`:renderHelp(document,{advanced:parsed.advanced})); return document.commands.length?0:2; }
    if(canSelect(parsed,{stdin,stdout,stderr}))select=createTerminalSelector({stdin,stderr,locale:parsed.locale,signal:abortController.signal});
    parsed.input.onRelayReady=event=>stdout.write(`${JSON.stringify(event)}\n`);
    const rawResult=await runtime.execute(parsed.command,parsed.input,{select});const result=redactOutput(rawResult);
    const code=exitCode(result);
    stdout.write(parsed.json?`${JSON.stringify({schema_version:1,ok:code===0,result})}\n`:`${renderContext(result.resolved_context??result.data?.resolved_context,parsed.locale)}${renderResult(result,parsed.locale)}`);
    if(rawResult?.closed instanceof Promise)await rawResult.closed;
    return code;
  } catch(error) {
    const locale=parsed?.locale??requestedLocale(argv);const name=errorCode(error);
    const fallback=locale==='zh-CN'?'操作被拒绝；请核对命令、连接与私有状态':'Operation refused; verify command, connection and private state';
    const message=argumentDiagnostic(error,locale)??contextErrors[name]?.[locale==='zh-CN'?1:0]??fallback;
    const details=contextErrors[name]?safeContextDetails(error.details):{};
    const result=redactOutput(error.result?{...error.result,...(error.result.error?{error:{...error.result.error,message,details}}:{})}:{ok:false,error:{code:name,message,details}});
    const code=error.result?exitCode(error.result):/^(?:CLI_(?:INVALID|UNKNOWN|MISSING|DUPLICATE|CONFLICTING|INPUT|SECRET|CAPABILITY|SELECTION_CANCELLED|CONTEXT_SELECTION)|INVALID_|ABSOLUTE_)/.test(name)?2:/AUTHORIZATION|NOT_AUTHORIZED/.test(name)?4:/CONFLICT|DRIFT|CHANGED|LOCKED/.test(name)?5:7;
    const json=parsed?.json??argv.includes('--json');
    stderr.write(json?`${JSON.stringify({schema_version:1,ok:false,result,error_code:name})}\n`:`${name}: ${message}\n${(details.candidates??[]).map(candidate=>`  ${candidate.label}\n`).join('')}${(details.next_commands??[]).map(command=>`  ${locale==='zh-CN'?'下一步':'Next'}: ${command}\n`).join('')}`);
    return code;
  } finally {
    select?.close();
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  }
}
