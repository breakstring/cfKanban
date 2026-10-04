import { createInterface } from 'node:readline';
import { toolError } from '../../skill-runtime/src/errors.mjs';
import { assertNoSecrets } from './parser.mjs';

export function safeLabel(value) {
  if(typeof value!=='string')return '';
  try {assertNoSecrets({value});} catch {return '[redacted]';}
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,160);
}
const stableId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value:'';
const safeOrigin=value=> {
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'?url.origin:'';} catch {return '';}
};
export function candidateLabel(candidate) {
  if(!candidate||typeof candidate!=='object')return '';
  const names=['display_name','name','title','instance_display_name','workspace_display_name','project_display_name'].map(key=>safeLabel(candidate[key])).filter(Boolean);
  const origin=safeOrigin(candidate.trusted_api_origin??candidate.origin);
  const ids=['instance_id','workspace_id','project_id','id'].map(key=>stableId(candidate[key])).filter(Boolean);
  return [...new Set([...names,origin,...ids].filter(Boolean))].join(' · ');
}
export const canSelect=(parsed,{stdin,stdout,stderr})=>parsed.interactive!==false&&!parsed.json&&!parsed.stdinConsumed&&stdin.isTTY===true&&stdout.isTTY===true&&stderr.isTTY===true;
export function createTerminalSelector({stdin,stderr,locale='en',signal}) {
  let reader=null;
  const cancelled=()=>toolError('CLI_SELECTION_CANCELLED','Context selection cancelled');
  const select=async({kind,candidates})=> {
    if(signal?.aborted||!Array.isArray(candidates)||!candidates.length)throw cancelled();
    const chinese=locale==='zh-CN';
    const title={instance:chinese?'实例':'instance',workspace:chinese?'工作区':'workspace',project:chinese?'项目':'project'}[kind]??(chinese?'上下文':'context');
    stderr.write(`${chinese?'请选择':'Select'} ${title}:\n`);
    candidates.forEach((candidate,index)=>stderr.write(`  ${index+1}. ${candidateLabel(candidate)}\n`));
    reader=createInterface({input:stdin,output:stderr,terminal:false});
    const question=()=>new Promise((resolve,reject)=> {
      const close=()=>{cleanup();reject(cancelled());};
      const abort=()=>{cleanup();reject(cancelled());reader.close();};
      const cleanup=()=>{reader.removeListener('close',close);signal?.removeEventListener('abort',abort);};
      reader.once('close',close);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)return abort();
      reader.question(chinese?'输入编号（q 或空行取消）: ':'Enter a number (q or an empty line cancels): ',answer=>{cleanup();resolve(answer.trim());});
    });
    try {
      while(true) {
        const answer=await question();
        if(!answer||/^(?:q|quit|cancel)$/i.test(answer))throw cancelled();
        const index=/^[1-9]\d*$/.test(answer)?Number(answer)-1:-1;
        if(Number.isSafeInteger(index)&&index>=0&&index<candidates.length)return candidates[index];
        stderr.write(chinese?'请输入列表中的编号。\n':'Enter a number from the list.\n');
      }
    } finally {reader?.close();reader=null;}
  };
  select.close=()=>reader?.close();
  return select;
}
