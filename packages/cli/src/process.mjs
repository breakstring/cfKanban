import { spawn } from 'node:child_process';

export function capturedRunner(signal,{maxBytes=2*1024*1024,timeoutMs=120000,onOutput}={}) {
  return (executable,args,{env=process.env}={})=>new Promise(resolve=> {
    if(signal.aborted)return resolve({code:null,signal:'SIGTERM',stdout:'',stderr:''});
    const child=spawn(executable,args,{env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const out=[],err=[];let bytes=0;let stopped=false;let killTimer;
    const stop=()=>{if(stopped)return;stopped=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);};
    const timer=setTimeout(stop,timeoutMs);signal.addEventListener('abort',stop,{once:true});
    const read=parts=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes){stop();return;}parts.push(chunk);if(onOutput)try {onOutput(chunk.toString('utf8'));}catch {stop();}};
    child.stdout.on('data',read(out));child.stderr.on('data',read(err));
    const complete=(code,reason)=>{clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',stop);resolve({code:stopped?null:code,signal:reason??(stopped?'SIGTERM':null),stdout:stopped?'':Buffer.concat(out).toString('utf8'),stderr:stopped?'':Buffer.concat(err).toString('utf8')});};
    child.once('error',()=>complete(null,null));child.once('close',complete);
  });
}
