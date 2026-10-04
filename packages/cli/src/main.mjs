import { serializeError } from '../../skill-runtime/src/errors.mjs';
import { COMMANDS } from './catalog.mjs';
import { commandFields, parseArguments } from './parser.mjs';
import { createCliRuntime, redactOutput } from './runtime.mjs';

export const VERSION=typeof __CFKANBAN_CLI_VERSION__==='undefined'?'source':__CFKANBAN_CLI_VERSION__;
export const EXIT_CODES=Object.freeze({success:0,validation:2,authentication:3,authorization:4,conflict:5,outcome_unknown:6,platform_failure:7,not_found:8});
const zh={instance:'实例',profile:'个人资料',notification:'通知',admin:'管理',event:'事件',workspace:'工作区',project:'项目',issue:'Issue',attachment:'附件',comment:'评论',label:'标签',relation:'关系',invite:'邀请',owner:'Owner',grant:'授权',passkey:'通行密钥',join:'加入',connection:'连接',scope:'目录关联',identity:'身份',board:'看板',deploy:'部署',operation:'操作恢复',cli:'CLI安装',list:'列表',show:'查看',create:'创建',update:'修改',delete:'删除',restore:'恢复',archive:'归档',purge:'永久清除',complete:'完成',reopen:'重开',block:'标记阻塞',unblock:'解除阻塞',candidates:'候选项',counts:'统计',context:'上下文',preferences:'偏好',configure:'设置',acknowledge:'确认收到',publish:'发布',withdraw:'撤回',administrator:'管理员',member:'成员',add:'添加',remove:'移除',rename:'改名',revoke:'撤销',upload:'上传',download:'下载',device:'设备',prepare:'准备',verify:'核验',request:'请求',rotate:'轮换',origin:'来源',limits:'限额',homepage:'首页',usage:'用量',snapshot:'快照',plan:'计划',apply:'执行',resume:'继续',recover:'恢复',pending:'待验证',inspect:'检查',associate:'关联',resolve:'解析',install:'安装',status:'状态',rollback:'回退',uninstall:'卸载'};
function description(command,locale) { return locale==='zh-CN'?command.name.split(' ').map(word=>zh[word]??word).join(' / '):command.description??command.name; }
export function helpDocument(prefix='',locale='en',version=VERSION) {
  const commands=COMMANDS.filter(command=>!prefix||command.name===prefix||command.name.startsWith(`${prefix} `));
  const exact=commands.find(command=>command.name===prefix);
  return {schema_version:1,name:'cfkanban',version,locale,offline:true,prefix,documentation_url:`https://github.com/breakstring/cfKanban/blob/${version==='source'?'feat/v1.9':version}/apps/docs/${locale==='zh-CN'?'zh-CN':'en'}/cli/index.md`,description:locale==='zh-CN'?'面向人类与Agent的cfKanban公共命令；服务端权限为准':'Public cfKanban commands for people and Agents; Service permissions remain authoritative',exit_codes:EXIT_CODES,commands:commands.map(command=>({name:command.name,description:description(command,locale),effect:command.effect,...(command.write_contract?{write_contract:command.write_contract}:{}),options:Object.entries(commandFields(command)).map(([flag,field])=>({flag:`--${flag}`,field:field.name,required:field.required===true,schema:field.schema??null})),...(command.sensitiveStdin?{sensitive_input:'--capability-stdin'}:{})})),exact:exact?.name??null};
}
export function renderHelp(document) {
  const chinese=document.locale==='zh-CN';
  const lines=[`cfkanban ${document.version}`,document.description,''];
  if(!document.prefix)lines.push(chinese?'上手: 1. connection list选择准确实例  2. profile show核验身份  3. 用project show确认范围  4. issue list开始工作':'Start: 1. connection list selects the exact instance  2. profile show verifies identity  3. project show verifies scope  4. issue list starts daily work',chinese?'日常: issue / comment / label / relation / attachment / join / profile / web':'Daily: issue / comment / label / relation / attachment / join / profile / web',chinese?'管理: workspace / project / grant / invite / owner / admin':'Management: workspace / project / grant / invite / owner / admin',chinese?'部署与本机安装: deploy / cli；Cloudflare写入需要完整计划绑定授权':'Deployment and local installation: deploy / cli; Cloudflare writes require full plan-bound authorization',`Docs: ${document.documentation_url}`,'');
  if(document.exact) {
    const command=document.commands.find(command=>command.name===document.exact);
    lines.push(`cfkanban ${command.name} [options]`,command.description,`${chinese?'影响':'Effect'}: ${command.effect}`,'');
    if(command.write_contract)lines.push(`${chinese?'服务写合同':'Service write contract'}: ${command.write_contract}`,'');
    for(const option of command.options) lines.push(`  ${option.flag}${option.required?' *':''} ${option.schema?.enum?option.schema.enum.join('|'):option.schema?.type??'value'}`);
    if(command.sensitive_input) lines.push('  --capability-stdin');
    lines.push('  --input-file PATH | --input-stdin','  --body-file PATH | --body-stdin','  --json --locale en|zh-CN');
  } else {
    const depth=document.prefix?document.prefix.split(' ').length:0;
    const entries=new Map();
    for(const command of document.commands) { const words=command.name.split(' '); const name=words.slice(0,depth+1).join(' '); if(!entries.has(name))entries.set(name,command); }
    for(const [name,command]of entries) lines.push(`  ${name.padEnd(30)} ${description({name,description:command.description},document.locale)}`);
    if(!entries.size) lines.push(chinese?'没有匹配的命令':'No matching command');
  }
  lines.push('',chinese?'逐级帮助: cfkanban issue --help → cfkanban issue create --help':'Progressive help: cfkanban issue --help → cfkanban issue create --help',chinese?'示例: cfkanban issue list --instance UUID --project UUID --json':'Example: cfkanban issue list --instance UUID --project UUID --json',chinese?'Markdown正文从 --body-file 或 --body-stdin 输入；服务幂等命令保留原key，CAS写保留原version并读回':'Markdown bodies: --body-file or --body-stdin. Idempotent commands retain their key; CAS writes retain the original version and read back.',chinese?'未知写结果: cfkanban operation recover --instance UUID --operation-id UUID':'Unknown write: cfkanban operation recover --instance UUID --operation-id UUID',chinese?'CAS-only恢复遇冲突/权限拒绝仍未知，需要精确审计或人工核验；cache-refresh未知只读、不自动重复':'CAS-only recovery conflicts or permission denials remain unknown and require exact audit or manual verification; unknown cache refreshes are read back without replay.',chinese?'部署: 先 deploy plan，查看完整目标/费用，再传入绑定授权执行；没有 --yes':'Deployment: inspect deploy plan targets/costs, then apply with plan-bound authorization; no --yes',chinese?'凭据仅从私有状态读取；邀请链接只经安全stdin或专用交付':'Credentials are read only from private state; Invite URLs use secure stdin or dedicated delivery.');
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
  if(data.items) return `${data.items.map(item=>[item.identifier??item.id,item.title??item.display_name??item.name??'',item.status_key??''].filter(Boolean).join('  ')).join('\n')}\n${data.next_cursor?`${chinese?'下一页游标':'Next cursor'}: ${data.next_cursor}\n`:''}`;
  return `${JSON.stringify(data,null,2)}\n`;
}
export async function main(argv=process.argv.slice(2),{stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,runtime=null}={}) {
  const abortController=new AbortController();
  const cancel=()=>abortController.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  runtime??=createCliRuntime({signal:abortController.signal});
  let parsed;
  try {
    parsed=await parseArguments(argv,{stdin});
    if(parsed.version) { stdout.write(parsed.json?`${JSON.stringify({schema_version:1,ok:true,result:{name:'cfkanban',version:VERSION,node_range:'>=22.12.0'}})}\n`:`cfkanban ${VERSION}\n`); return 0; }
    if(parsed.help) { const document=helpDocument(parsed.prefix==='howto'?'':parsed.prefix,parsed.locale); stdout.write(parsed.json?`${JSON.stringify({schema_version:1,ok:true,result:document})}\n`:renderHelp(document)); return document.commands.length?0:2; }
    parsed.input.onRelayReady=event=>stdout.write(`${JSON.stringify(event)}\n`);
    const rawResult=await runtime.execute(parsed.command,parsed.input);const result=redactOutput(rawResult);
    const code=exitCode(result);
    stdout.write(parsed.json?`${JSON.stringify({schema_version:1,ok:code===0,result})}\n`:renderResult(result,parsed.locale));
    if(rawResult?.closed instanceof Promise)await rawResult.closed;
    return code;
  } catch(error) {
    const result=redactOutput(error.result??serializeError(error));
    const code=error.result?exitCode(error.result):/^(?:CLI_(?:INVALID|UNKNOWN|MISSING|DUPLICATE|CONFLICTING|INPUT|SECRET|CAPABILITY)|INVALID_|ABSOLUTE_)/.test(error.code??'')?2:/AUTHORIZATION|NOT_AUTHORIZED/.test(error.code??'')?4:/CONFLICT|DRIFT|CHANGED|LOCKED/.test(error.code??'')?5:7;
    const json=parsed?.json??argv.includes('--json');
    stderr.write(json?`${JSON.stringify({schema_version:1,ok:false,result,error_code:error.code??'CLI_RUNTIME_FAILED'})}\n`:`${error.code??'CLI_RUNTIME_FAILED'}: ${parsed?.locale==='zh-CN'?'操作被拒绝；请核对命令、连接与私有状态':'Operation refused; verify command, connection and private state'}\n`);
    return code;
  } finally {
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  }
}
