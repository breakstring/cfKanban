import { open } from 'node:fs/promises';
import { toolError } from '../../skill-runtime/src/errors.mjs';
import { COMMANDS } from './catalog.mjs';

export const flagName = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_','-').toLowerCase();
export const supportsServiceIdempotency = command => command.write_contract?.includes('idempotent') === true;
const wranglerVersionSchema = {type:'string',minLength:1,maxLength:64,pattern:'^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$'};
const diagnostics=new WeakMap();
const safeOption=name=>/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)&&!/^cf[ikl]_v1_/i.test(name)?name:'option';
function argumentError(code,message,chinese,details={}) {
  const error=toolError(code,message,details);
  diagnostics.set(error,{en:message,'zh-CN':chinese??'参数无效；请查看此命令的 --help'});
  return error;
}
export const argumentDiagnostic=(error,locale='en')=>diagnostics.get(error)?.[locale]??null;
const contextualInstance=command=>! /^(?:deploy|operation|identity|owner)(?: |$)/.test(command.name)&&command.name!=='connection add';
export function commandFields(command) {
  if (!command.apiPath) return Object.fromEntries((command.fields ?? []).map(name => [flagName(name), { name, required: (command.required ?? []).includes(name)&&!(name==='directory'&&/^(?:scope|context) /.test(command.name)), ...(name==='instanceId'&&contextualInstance(command)||command.name==='web open'&&name==='target'?{contextual:true}:{}), schema: name === 'conflictChoice' ? {type:'string',enum:['preserve_exemptions','before_conflicts']} : name === 'wranglerVersion' ? wranglerVersionSchema : ['instanceId','operationId','workspace_id','project_id'].includes(name) || /(?:Principal|Credential)Id$/.test(name) ? {type:'string',format:'uuid'} : /(?:Version|Bytes|Seconds)$/.test(name) ? {type:'integer',minimum:0} : ['global','includeWaf','passkeyRecoveryReady'].includes(name)||/^(?:allow|replace|persistence|committed)/.test(name) ? {type:'boolean'} : ['plan','authorization','request','target','targets','artifactFiles','repoTargets','validTargets','release','current','cloudflare','resources','bindings','owner','migrations','restorePoint','attachments','usageAnalytics','workerLimits','publicAccessReceipt','body'].includes(name) ? {type:['object','array','null']} : undefined }]));
  const contextual=name=>['workspace_id','project_id'].includes(name)&&!command.name.includes('purge')?{contextual:true}:{};
  return Object.fromEntries([
    ['instance', { name: 'instanceId', schema: { type: 'string', format: 'uuid' }, required: true,contextual:true }],
    ['operation-id', { name: 'operationId', schema: { type: 'string', format: 'uuid' } }],
    ...(supportsServiceIdempotency(command)?[['idempotency-key', { name: 'idempotencyKey', schema: { type: 'string', minLength: 1, maxLength: 128, ...(command.operation==='applyCloudflareWaf'?{format:'uuid'}:{}) } }]]:[]),
    ['directory', { name: 'directory', schema: {type:'string'} }],
    ['allow-unfiltered', { name: 'allowUnfiltered', schema: {type:'boolean'} }],
    ...(['revokeCredential','revokePrincipalPasskey'].includes(command.operation)?[['principal-id',{name:'principal_id',schema:{type:'string',format:'uuid'},required:true}]]:[]),
    ...command.parameters.filter(parameter => parameter.in !== 'header').map(parameter => [flagName(parameter.name), { name: parameter.name === 'allow_unfiltered' ? 'allowUnfiltered' : parameter.name, schema: parameter.schema, required: parameter.required && !parameter.name.endsWith('expected_version'),...contextual(parameter.name) }]),
    ...Object.entries(command.body?.properties ?? {}).map(([name,schema]) => [name==='locale'?'preference-locale':flagName(name), { name, schema, body: true, required: command.body.required?.includes(name) && !name.endsWith('expected_version'),...contextual(name) }]),
  ]);
}
export function validateCommandInput(command,input,{allowContext=false}={}) {
  const {capabilityInput,onRelayReady,...ordinary}=input;
  assertNoSecrets(ordinary);
  for(const [flag,field] of Object.entries(commandFields(command))) {
    if(field.required&&!Object.hasOwn(input,field.name)&&!(allowContext&&field.contextual))throw argumentError('CLI_MISSING_ARGUMENT',`Missing --${flag}; use cfkanban ${command.name} --help`,`缺少 --${flag}；请查看 cfkanban ${command.name} --help`,{option:`--${flag}`});
    if(Object.hasOwn(input,field.name)&&!matches(field.schema,input[field.name]))throw argumentError('CLI_INVALID_ARGUMENT',`Invalid --${flag}; use cfkanban ${command.name} --help`,`--${flag} 的值无效；请查看 cfkanban ${command.name} --help`,{option:`--${flag}`});
  }
  return input;
}
export function matches(schema, value) {
  if (!schema) return true;
  if(schema['x-cfkanban-max-utf8-bytes']&&Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value))>schema['x-cfkanban-max-utf8-bytes'])return false;
  if (schema.anyOf) return schema.anyOf.some(entry => matches(entry,value));
  if (schema.oneOf) return schema.oneOf.filter(entry => matches(entry,value)).length === 1;
  if (schema.allOf && !schema.allOf.every(entry => matches(entry,value))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (value === null) return schema.nullable === true || schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null');
  if (schema.type === 'null') return false;
  if (Array.isArray(schema.type)) return schema.type.some(type => matches({...schema,type},value));
  if (schema.type === 'string') return typeof value === 'string' && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (schema.format !== 'uuid' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  if (schema.type === 'integer' || schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && (!schema.uniqueItems || new Set(value.map(entry => JSON.stringify(entry))).size === value.length) && value.every(entry => matches(schema.items,entry));
  if (schema.type === 'object' || schema.properties) return value && typeof value === 'object' && !Array.isArray(value) && (schema.required ?? []).every(name => Object.hasOwn(value,name)) && Object.keys(value).length >= (schema.minProperties ?? 0) && Object.entries(value).every(([name,entry]) => Object.hasOwn(schema.properties??{},name) ? matches(schema.properties[name],entry) : schema.additionalProperties !== false);
  return true;
}
export function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  if (/cfk_v1_[a-f0-9]{16}_[A-Za-z0-9_-]{43}|cf[il]_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}|https?:[^\s"\\]*(?:[?&](?:code|token|ticket)=)/i.test(serialized) || /"(?:token|credential|secret|password|inviteCode|invite_code)"\s*:/i.test(serialized) || /"authorization"\s*:\s*"/i.test(serialized)) throw toolError('CLI_SECRET_INPUT_REJECTED','Secrets and one-time capability URLs require their dedicated secure delivery flow');
}
const typed = (raw,schema) => {
  if (!schema) { if (/^(?:true|false|null)$/.test(raw) || /^[\[{]/.test(raw)) { try { return JSON.parse(raw); } catch {} } return raw; }
  if (schema.type === 'array') return typed(raw,schema.items);
  if (schema.type === 'integer' || schema.type === 'number') return Number(raw);
  if (schema.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (schema.type === 'object' || schema.anyOf || schema.oneOf || Array.isArray(schema.type)) { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
};
export async function readInput(stream, { maxBytes = 256 * 1024 } = {}) {
  const parts=[]; let bytes=0;
  for await (const chunk of stream) { const buffer=Buffer.from(chunk); bytes+=buffer.length; if(bytes>maxBytes) throw toolError('CLI_INPUT_TOO_LARGE','Input exceeds 256 KiB'); parts.push(buffer); }
  return Buffer.concat(parts).toString('utf8');
}
async function boundedFileRead(file) {const handle=await open(file,'r');try {const info=await handle.stat();if(!info.isFile()||info.size>256*1024)throw toolError('CLI_INPUT_TOO_LARGE','Input must be a regular file of at most 256 KiB');return await readInput(handle.createReadStream({autoClose:false}));}finally {await handle.close();}}
export async function parseArguments(argv,{ stdin=process.stdin, fileRead=boundedFileRead }={}) {
  let locale='en'; const options={ json:false,help:false,version:false,advanced:false,interactive:null,stdinConsumed:false }; const words=[]; const flags=[];
  const globals=new Set();const once=name=>{if(globals.has(name))throw argumentError('CLI_DUPLICATE_OPTION',`--${name} may only be supplied once`,`--${name} 只能提供一次`);globals.add(name);};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];
    if(arg==='--json') { once('json');options.json=true; continue; }
    if(arg==='--help'||arg==='-h') { once('help');options.help=true; continue; }
    if(arg==='--version') { once('version');options.version=true; continue; }
    if(arg==='--advanced') {once('advanced');options.advanced=true;continue;}
    if(arg==='--interactive'||arg==='--no-interactive') {once(arg.slice(2));if(options.interactive!==null)throw argumentError('CLI_CONFLICTING_INPUT','Choose either --interactive or --no-interactive','--interactive 与 --no-interactive 不能同时使用');options.interactive=arg==='--interactive';continue;}
    if(arg==='--locale'||arg.startsWith('--locale=')) { once('locale');locale=arg==='--locale'?argv[++index]:arg.slice(9); if(!['en','zh-CN'].includes(locale)) throw argumentError('CLI_INVALID_ARGUMENT','--locale accepts en or zh-CN','--locale 只接受 en 或 zh-CN'); continue; }
    if(arg==='--local'||arg.startsWith('--local='))throw argumentError('CLI_UNKNOWN_OPTION','Unknown option --local; use --locale en|zh-CN','未知选项 --local；请使用 --locale en|zh-CN');
    if(!arg.startsWith('-')) { if(flags.length) throw argumentError('CLI_INVALID_ARGUMENT','Unexpected positional argument; use documented long options','出现多余的位置参数；请使用文档中的长选项'); words.push(arg); continue; }
    if(!arg.startsWith('--')) throw argumentError('CLI_INVALID_ARGUMENT','Only documented long options are accepted','只接受文档中的长选项');
    const [key,inline]=arg.slice(2).split(/=(.*)/s); const boolean=['body-stdin','input-stdin','capability-stdin'].includes(key);
    const value=inline ?? (boolean ? 'true' : argv[++index]);
    if(value===undefined || value.startsWith('--')) throw argumentError('CLI_INVALID_ARGUMENT',`--${safeOption(key)} requires a value`,`--${safeOption(key)} 需要提供值`);
    flags.push([key,value]);
  }
  const name=words.join(' '); const command=COMMANDS.find(command=>command.name===name);
  if(options.advanced&&options.version&&!options.help)throw argumentError('CLI_INVALID_ARGUMENT','--advanced is only available with help','--advanced 仅用于帮助命令');
  if(!name||words[0]==='help'||name==='howto'||options.help||options.version||!command&&COMMANDS.some(command=>command.name.startsWith(`${name} `))) {
    if(flags.length)throw argumentError('CLI_UNKNOWN_OPTION','Help accepts only --json, --locale, --help, --version, --advanced and interaction options','帮助只接受 --json、--locale、--help、--version、--advanced 和交互选项');
    return { ...options,locale,help: !options.version, prefix: words[0]==='help'?words.slice(1).join(' '):name };
  }
  if(!command) throw argumentError('CLI_UNKNOWN_COMMAND','Unknown command; use cfkanban help','未知命令；请查看 cfkanban help');
  if(options.advanced)throw argumentError('CLI_INVALID_ARGUMENT','--advanced is only available with help; add --help','--advanced 仅用于帮助命令；请同时使用 --help');
  const fields=commandFields(command); const input={}; const transports=new Map();
  for(const [key,raw]of flags) {
    if(['input-file','input-stdin','body-file','body-stdin','capability-stdin'].includes(key)) { if(transports.has(key)) throw toolError('CLI_DUPLICATE_OPTION',`--${key} may only be supplied once`); transports.set(key,raw); continue; }
    const aliases={'instance':'instance-id','instance-id':'instance','workspace':'workspace-id','workspace-id':'workspace','project':'project-id','project-id':'project'};
    const alias=fields[aliases[key]];
    const field=fields[key]??(alias&&alias.schema?.type!=='array'?alias:undefined);
    if(!field) throw argumentError('CLI_UNKNOWN_OPTION',`Unknown option --${safeOption(key)}; use cfkanban ${command.name} --help`,`未知选项 --${safeOption(key)}；请查看 cfkanban ${command.name} --help`);
    const value=typed(raw,field.schema);
    if(field.schema?.type==='array') (input[field.name]??=[]).push(value);
    else { if(Object.hasOwn(input,field.name)) throw argumentError('CLI_DUPLICATE_OPTION',`--${safeOption(key)} may only be supplied once`,`--${safeOption(key)} 只能提供一次`); input[field.name]=value; }
  }
  if(transports.has('input-file')&&transports.has('input-stdin')||transports.has('body-file')&&transports.has('body-stdin')||[...transports.keys()].filter(key=>key.endsWith('stdin')).length>1) throw toolError('CLI_CONFLICTING_INPUT','Choose one input transport');
  if(transports.has('input-file')||transports.has('input-stdin')) {
    let decoded;
    try { const raw=transports.has('input-file')?await fileRead(transports.get('input-file'),'utf8'):await readInput(stdin); if(Buffer.byteLength(raw)>256*1024)throw toolError('CLI_INPUT_TOO_LARGE','Input exceeds 256 KiB'); decoded=JSON.parse(raw); } catch(error) { if(error.code==='CLI_INPUT_TOO_LARGE')throw error; throw toolError('CLI_INVALID_JSON','Input must be a JSON object'); }
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)) throw toolError('CLI_INVALID_JSON','Input must be a JSON object');
    const allowed=new Set(Object.values(fields).map(field=>field.name));
    for(const [key,value]of Object.entries(decoded)) { if(!allowed.has(key)) throw argumentError('CLI_UNKNOWN_OPTION',`Unknown input field ${safeOption(key)}`,`未知输入字段 ${safeOption(key)}`); if(Object.hasOwn(input,key)) throw argumentError('CLI_DUPLICATE_OPTION',`Input field ${safeOption(key)} supplied twice`,`输入字段 ${safeOption(key)} 重复提供`); input[key]=value; }
  }
  if(transports.has('body-file')||transports.has('body-stdin')) {
    const field=fields.body??fields.summary??fields.context;
    if(!field||Object.hasOwn(input,field.name)) throw toolError('CLI_CONFLICTING_INPUT','This command requires a documented text field and one body source');
    input[field.name]=transports.has('body-file')?await fileRead(transports.get('body-file'),'utf8'):await readInput(stdin);
    if(Buffer.byteLength(input[field.name])>256*1024)throw toolError('CLI_INPUT_TOO_LARGE','Input exceeds 256 KiB');
  }
  validateCommandInput(command,input,{allowContext:true});
  if(command.sensitiveStdin||command.workflow==='operation-recover'&&transports.has('capability-stdin')) { if(!transports.has('capability-stdin')) throw toolError('CLI_CAPABILITY_STDIN_REQUIRED','Pass the invitation URL through --capability-stdin; never put it in arguments or files'); input.capabilityInput=(await readInput(stdin,{maxBytes:8192})).trim(); }
  else if(transports.has('capability-stdin'))throw toolError('CLI_CONFLICTING_INPUT','This command does not accept capability stdin');
  if(input.delivery==='stdout_once')throw toolError('CLI_SECRET_DELIVERY_REJECTED','CLI supports clipboard and browser delivery; headless one-time capability output is unavailable');
  return {...options,stdinConsumed:[...transports.keys()].some(key=>key.endsWith('stdin')),locale,command,input};
}
