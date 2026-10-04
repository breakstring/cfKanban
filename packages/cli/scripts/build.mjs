import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { helpDocument } from '../src/main.mjs';
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repoRoot=path.resolve(packageRoot,'../..');
const declared=JSON.parse(await readFile(path.join(repoRoot,'release/version.json'),'utf8'));
const index=process.argv.indexOf('--version'); const version=index<0?declared.release_version??declared.version:process.argv[index+1];
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version??''))throw new Error('CLI build requires a fixed release version');
const outputRoot=path.join(packageRoot,'dist'); await mkdir(outputRoot,{recursive:true});
const outfile=path.join(outputRoot,'cfkanban.mjs');
await build({absWorkingDir:repoRoot,entryPoints:[path.join(packageRoot,'bin/cfkanban.mjs')],outfile,bundle:true,platform:'node',target:'node22.12',format:'esm',minify:true,legalComments:'inline',logLevel:'silent',define:{__CFKANBAN_CLI_VERSION__:JSON.stringify(version)},banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'}});
const entries=[];
for(const name of ['cfkanban.mjs','commands.json','THIRD_PARTY_NOTICES.txt']) {
  if(name==='commands.json')await writeFile(path.join(outputRoot,name),`${JSON.stringify(helpDocument('','en',version),null,2)}\n`);
  if(name==='THIRD_PARTY_NOTICES.txt')await writeFile(path.join(outputRoot,name),'cfKanban CLI contains cfKanban first-party runtime modules only. License: Apache-2.0.\n');
  const bytes=await readFile(path.join(outputRoot,name)); entries.push({path:name,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(path.join(outputRoot,'build-metadata.json'),`${JSON.stringify({schema_version:1,name:'cfkanban-cli',release_version:version,node_range:'>=22.12.0',entries,dependencies:[]},null,2)}\n`);
process.stdout.write(`Built cfKanban CLI ${version}\n`);
