import { open } from 'node:fs/promises';
import { toolError } from '../../skill-runtime/src/errors.mjs';
import { COMMANDS } from './catalog.mjs';

export const flagName = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_','-').toLowerCase();
export const supportsServiceIdempotency = command => command.write_contract?.includes('idempotent') === true;
const wranglerVersionSchema = {type:'string',minLength:1,maxLength:64,pattern:'^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$'};
export function commandFields(command) {
  if (!command.apiPath) return Object.fromEntries((command.fields ?? []).map(name => [flagName(name), { name, required: (command.required ?? []).includes(name), schema: name === 'wranglerVersion' ? wranglerVersionSchema : name === 'instanceId' || name === 'operationId' || /(?:Principal|Credential)Id$/.test(name) ? {type:'string',format:'uuid'} : /(?:Version|Bytes|Seconds)$/.test(name) ? {type:'integer',minimum:0} : /^(?:allow|replace|persistence|committed)/.test(name) ? {type:'boolean'} : ['plan','authorization','request','target','targets','artifactFiles','repoTargets','validTargets','explicitTargets','release','current','cloudflare','resources','bindings','owner','migrations','restorePoint','attachments','usageAnalytics','body'].includes(name) ? {type:['object','array','null']} : undefined }]));
  return Object.fromEntries([
    ['instance', { name: 'instanceId', schema: { type: 'string', format: 'uuid' }, required: true }],
    ['operation-id', { name: 'operationId', schema: { type: 'string', format: 'uuid' } }],
    ...(supportsServiceIdempotency(command)?[['idempotency-key', { name: 'idempotencyKey', schema: { type: 'string', minLength: 1, maxLength: 128 } }]]:[]),
    ['directory', { name: 'directory', schema: {type:'string'} }],
    ['allow-unfiltered', { name: 'allowUnfiltered', schema: {type:'boolean'} }],
    ...(['revokeCredential','revokePrincipalPasskey'].includes(command.operation)?[['principal-id',{name:'principal_id',schema:{type:'string',format:'uuid'},required:true}]]:[]),
    ...command.parameters.filter(parameter => parameter.in !== 'header').map(parameter => [flagName(parameter.name), { name: parameter.name, schema: parameter.schema, required: parameter.required && !parameter.name.endsWith('expected_version') }]),
    ...Object.entries(command.body?.properties ?? {}).map(([name,schema]) => [name==='locale'?'preference-locale':flagName(name), { name, schema, body: true, required: command.body.required?.includes(name) && !name.endsWith('expected_version') }]),
  ]);
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
  if (Array.isArray(schema.type)) return schema.type.some(type => matches({...schema,type},value));
  if (schema.type === 'string') return typeof value === 'string' && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (schema.format !== 'uuid' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  if (schema.type === 'integer' || schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && (!schema.uniqueItems || new Set(value.map(entry => JSON.stringify(entry))).size === value.length) && value.every(entry => matches(schema.items,entry));
  if (schema.type === 'object' || schema.properties) return value && typeof value === 'object' && !Array.isArray(value) && (schema.required ?? []).every(name => Object.hasOwn(value,name)) && Object.keys(value).length >= (schema.minProperties ?? 0) && Object.entries(value).every(([name,entry]) => schema.properties?.[name] ? matches(schema.properties[name],entry) : schema.additionalProperties !== false);
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
  let locale='en'; const options={ json:false,help:false,version:false }; const words=[]; const flags=[];
  const globals=new Set();const once=name=>{if(globals.has(name))throw toolError('CLI_DUPLICATE_OPTION',`--${name} may only be supplied once`);globals.add(name);};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];
    if(arg==='--json') { once('json');options.json=true; continue; }
    if(arg==='--help'||arg==='-h') { once('help');options.help=true; continue; }
    if(arg==='--version') { once('version');options.version=true; continue; }
    if(arg==='--locale') { once('locale');locale=argv[++index]; if(!['en','zh-CN'].includes(locale)) throw toolError('CLI_INVALID_ARGUMENT','--locale accepts en or zh-CN'); continue; }
    if(!arg.startsWith('-')) { if(flags.length) throw toolError('CLI_INVALID_ARGUMENT','Unexpected positional argument'); words.push(arg); continue; }
    if(!arg.startsWith('--')) throw toolError('CLI_INVALID_ARGUMENT','Only documented long options are accepted');
    const [key,inline]=arg.slice(2).split(/=(.*)/s); const boolean=['body-stdin','input-stdin','capability-stdin'].includes(key);
    const value=inline ?? (boolean ? 'true' : argv[++index]);
    if(value===undefined || value.startsWith('--')) throw toolError('CLI_INVALID_ARGUMENT',`--${key} requires a value`);
    flags.push([key,value]);
  }
  const name=words.join(' '); const command=COMMANDS.find(command=>command.name===name);
  if(!name||words[0]==='help'||name==='howto'||options.help||options.version||!command&&COMMANDS.some(command=>command.name.startsWith(`${name} `))) {
    if(flags.length)throw toolError('CLI_UNKNOWN_OPTION','Help accepts only --json, --locale, --help and --version');
    return { ...options,locale,help: !options.version, prefix: words[0]==='help'?words.slice(1).join(' '):name };
  }
  if(!command) throw toolError('CLI_UNKNOWN_COMMAND','Unknown command; use cfkanban help');
  const fields=commandFields(command); const input={}; const transports=new Map();
  for(const [key,raw]of flags) {
    if(['input-file','input-stdin','body-file','body-stdin','capability-stdin'].includes(key)) { if(transports.has(key)) throw toolError('CLI_DUPLICATE_OPTION',`--${key} may only be supplied once`); transports.set(key,raw); continue; }
    const field=fields[key] ?? (key==='instance'&&fields['instance-id']?fields['instance-id']:undefined);
    if(!field) throw toolError('CLI_UNKNOWN_OPTION',`Unknown option --${key}`);
    const value=typed(raw,field.schema);
    if(field.schema?.type==='array') (input[field.name]??=[]).push(value);
    else { if(Object.hasOwn(input,field.name)) throw toolError('CLI_DUPLICATE_OPTION',`--${key} may only be supplied once`); input[field.name]=value; }
  }
  if(transports.has('input-file')&&transports.has('input-stdin')||transports.has('body-file')&&transports.has('body-stdin')||[...transports.keys()].filter(key=>key.endsWith('stdin')).length>1) throw toolError('CLI_CONFLICTING_INPUT','Choose one input transport');
  if(transports.has('input-file')||transports.has('input-stdin')) {
    let decoded;
    try { const raw=transports.has('input-file')?await fileRead(transports.get('input-file'),'utf8'):await readInput(stdin); if(Buffer.byteLength(raw)>256*1024)throw toolError('CLI_INPUT_TOO_LARGE','Input exceeds 256 KiB'); decoded=JSON.parse(raw); } catch(error) { if(error.code==='CLI_INPUT_TOO_LARGE')throw error; throw toolError('CLI_INVALID_JSON','Input must be a JSON object'); }
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)) throw toolError('CLI_INVALID_JSON','Input must be a JSON object');
    const allowed=new Set(Object.values(fields).map(field=>field.name));
    for(const [key,value]of Object.entries(decoded)) { if(!allowed.has(key)) throw toolError('CLI_UNKNOWN_OPTION',`Unknown input field ${key}`); if(Object.hasOwn(input,key)) throw toolError('CLI_DUPLICATE_OPTION',`Input field ${key} supplied twice`); input[key]=value; }
  }
  if(transports.has('body-file')||transports.has('body-stdin')) {
    const field=fields.body??fields.summary??fields.context;
    if(!field||Object.hasOwn(input,field.name)) throw toolError('CLI_CONFLICTING_INPUT','This command requires a documented text field and one body source');
    input[field.name]=transports.has('body-file')?await fileRead(transports.get('body-file'),'utf8'):await readInput(stdin);
    if(Buffer.byteLength(input[field.name])>256*1024)throw toolError('CLI_INPUT_TOO_LARGE','Input exceeds 256 KiB');
  }
  assertNoSecrets(input);
  for(const field of Object.values(fields)) {
    if(field.required&&!Object.hasOwn(input,field.name)) throw toolError('CLI_MISSING_ARGUMENT',`Missing --${flagName(field.name)}`);
    if(Object.hasOwn(input,field.name)&&!matches(field.schema,input[field.name])) throw toolError('CLI_INVALID_ARGUMENT',`Invalid --${flagName(field.name)}`);
  }
  if(command.sensitiveStdin||command.workflow==='operation-recover'&&transports.has('capability-stdin')) { if(!transports.has('capability-stdin')) throw toolError('CLI_CAPABILITY_STDIN_REQUIRED','Pass the invitation URL through --capability-stdin; never put it in arguments or files'); input.capabilityInput=(await readInput(stdin,{maxBytes:8192})).trim(); }
  else if(transports.has('capability-stdin'))throw toolError('CLI_CONFLICTING_INPUT','This command does not accept capability stdin');
  if(input.delivery==='stdout_once')throw toolError('CLI_SECRET_DELIVERY_REJECTED','CLI supports clipboard and browser delivery; headless one-time capability output is unavailable');
  return {...options,locale,command,input};
}
