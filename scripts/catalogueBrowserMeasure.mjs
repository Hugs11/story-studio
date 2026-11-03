// Offline browser benchmark: no local listener, installation, or dependency.
// Uses an isolated Firefox profile and an inline production Vite bundle.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(),'catalogue-browser-measure-'));
const profile = join(root,'profile');
const output = process.argv[2] ?? join(tmpdir(),'catalogue-browser-measure.json');
await mkdir(profile);
await writeFile(join(profile,'user.js'), 'user_pref("browser.dom.window.dump.enabled", true);\n');
await build({ configFile:false, plugins:[react()], logLevel:'error', build:{outDir:join(root,'bundle'),emptyOutDir:true,minify:false,lib:{entry:join(process.cwd(),'scripts/catalogueBrowserBench.jsx'),name:'CatalogueBench',formats:['iife'],fileName:'bench'}} });
const files = await readdir(join(root,'bundle'));
const script = await readFile(join(root,'bundle',files.find(file=>file.endsWith('.js'))),'utf8');
const css = (await Promise.all(files.filter(file=>file.endsWith('.css')).map(file=>readFile(join(root,'bundle',file),'utf8')))).join('\n');
await writeFile(join(root,'bench.html'), `<!doctype html><html lang="fr"><head><meta charset="UTF-8"><style>${css}\n.catalogue-window {font-size:13px;} body{margin:0;} </style></head><body><button id="run">Run</button><pre id="results"></pre><div id="surface"></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`);
let result;
let processMemory;
let stage;
const receivedRows = [];
const browser = spawn('firefox',['--headless','--no-remote','--profile',profile,'--window-size','1280,900',`file://${join(root,'bench.html')}?auto=1`],{stdio:['ignore','pipe','pipe']});
let errors = '';
let buffer = '';
const memorySamples = [];
// Linux benchmark adapter: RSS includes all private-profile browser processes
// and shared pages counted per process; it is a conservative process measure,
// not an invented JS heap value for Firefox's missing performance.memory.
async function memory() {
  const status = await Promise.all((await readdir('/proc')).filter(name=>/^\d+$/.test(name)).map(async name=>{
    try {
      const text=await readFile(`/proc/${name}/status`,'utf8');
      return {pid:Number(name),parent:Number(text.match(/^PPid:\s+(\d+)/m)?.[1]),rss:Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)*1024};
    } catch {return null;}
  }));
  const owned = new Set([browser.pid]);
  let added;
  do { added=false; for(const row of status) if(row&&owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);added=true;} } while(added);
  const bytes=status.filter(row=>row&&owned.has(row.pid)).reduce((sum,row)=>sum+row.rss,0);
  const sample={timestamp:Date.now(),rssMiB:bytes/1024/1024,processes:owned.size};
  memorySamples.push(sample);processMemory=sample;
  if(stage)stage.peakRssMiB=Math.max(stage.peakRssMiB,sample.rssMiB);
}
const interval=setInterval(()=>void memory().catch(()=>{}),100);
const timeout=setTimeout(()=>browser.kill('SIGTERM'),15*60*1000);
browser.stdout.on('data',chunk=>{
  buffer+=chunk.toString();
  let newline;
  while((newline=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
    if(line.startsWith('CATALOGUE_STAGE_START ')){stage={startRssMiB:processMemory?.rssMiB ?? null,peakRssMiB:processMemory?.rssMiB ?? 0};}
    if(line.startsWith('CATALOGUE_ROW ')){
      const row=JSON.parse(line.slice(14));
      row.firefoxProcessRss=processMemory;row.firefoxStageMemory=stage;receivedRows.push(row);stage=null;
      process.stdout.write(JSON.stringify(row)+'\n');
    }
    if(line.startsWith('CATALOGUE_RESULT ')){
      result=JSON.parse(line.slice(17));browser.kill('SIGTERM');
    }
    if(line.startsWith('CATALOGUE_ERROR '))errors+=line+'\n';
  }
});
browser.stderr.on('data',chunk=>{errors+=chunk.toString();});
try {
 await new Promise((resolve,reject)=>{browser.once('error',reject);browser.once('close',(code,signal)=>{errors+=`Exit ${code}, signal ${signal}\n`;resolve();});});
 if(!result)throw new Error(`Firefox benchmark did not produce a result: ${errors.slice(-3000)}`);
 result.rows=receivedRows;
 result.machine={cpu:cpus()[0].model,threads:cpus().length,ramBytes:totalmem()};
 result.memorySamples=memorySamples;
 await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(`Saved ${result.rows.length} browser measurements: ${output}`);
} finally {clearInterval(interval);clearTimeout(timeout);await rm(root,{recursive:true,force:true});}
