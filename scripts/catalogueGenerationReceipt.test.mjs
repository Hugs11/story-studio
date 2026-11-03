import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
const { useCatalogueGeneration }=await import('../src/hooks/useCatalogueGeneration.js');
const { projectToRustExport }=await import('../src/store/projectModel/schema.js');
const { createWorkSnapshot }=await import('../src/store/projectHelpers.js');
const { useRenderQueueExecutor }=await import('../src/hooks/useRenderQueueExecutor.js');
const { newRenderJob, WORK_NATURE }=await import('../src/store/production/renderQueueWork.js');
const { createNativeGenerationLock }=await import('../src/store/nativeGenerationLock.js');

test('only a saved identical clean work can record a successful generation',async()=>{
  let project={projectType:'pack',projectName:'A',rootEntries:[]};
  const calls=[];
  const options={readProject:()=>project,savePathRef:{current:'/a.mbah'},savedSnapshotRef:{current:createWorkSnapshot(project)},mediaLibraryPathsRef:{current:[]},mediaTagsRef:{current:{}},api:{recordGeneration:async result=>calls.push(result)},loadSaved:async()=>({data:project,mediaLibraryPaths:[],mediaTags:{},sourceText:JSON.stringify(project)})};
  const generationApp=runner(()=>useCatalogueGeneration(options));
  const renderGeneration=()=>{generationApp.render();generationApp.flush();return generationApp.render();};
  const callback=renderGeneration();
  assert.equal(renderGeneration(),callback,'unchanged saved evidence keeps the callback stable');
  await callback({projectPath:'/a.mbah',outputPath:'/a.zip'});
  assert.equal(calls.length,0,'no attestation without evidence captured before generation');
  const generatedProjectJson=await callback.prepare({savePath:'/a.mbah',projectJson:JSON.stringify(projectToRustExport(project))});
  assert.equal(generatedProjectJson,JSON.stringify(project));
  assert.equal(await callback.prepare({savePath:'/a.mbah',projectJson:'{}'}),null,'different queued input is unproven');
  options.loadSaved=async()=>({data:{...project,projectName:'External B'},mediaLibraryPaths:[],mediaTags:{},sourceText:'external B'});
  assert.equal(await renderGeneration().prepare({savePath:'/a.mbah',projectJson:JSON.stringify(projectToRustExport(project))}),null,'a changed disk file is never substituted for the generated input');
  await callback({projectPath:'/a.mbah',outputPath:'/a.zip',generatedProjectJson});
  assert.equal(calls.length,1);
  project={...project,projectName:'Changed'};
  assert.equal(renderGeneration(),null);
  await callback({projectPath:'/a.mbah',outputPath:'/b.zip'});
  assert.equal(calls.length,1,'a captured callback cannot attest a later revision');
  project={...project,projectName:'A'};
  options.savePathRef.current='/other.mbah';
  await callback({projectPath:'/a.mbah',outputPath:'/c.zip'});
  assert.equal(calls.length,1,'a different file never inherits the receipt');
  options.savePathRef.current=null;
  assert.equal(renderGeneration(),null);
  options.savePathRef.current='/a.mbah';
  options.api.recordGeneration=async()=>{throw new Error('catalogue unavailable');};
  await assert.doesNotReject(renderGeneration()({projectPath:'/a.mbah',outputPath:'/a.zip',generatedProjectJson}));
});

for(const nature of [WORK_NATURE.FREE,WORK_NATURE.ADVANCED]) for(const failure of [false,true]) test(`post-generation callback: ${nature}, failure=${failure}`,async()=>{
  let finish;
  const native=new Promise((resolve,reject)=>{finish=failure?()=>reject(new Error('failed')):()=>resolve({zipPath:'/a.zip',conversions:[],destinations:[],warnings:[]});});
  const callbacks=[];
  let jobs=[newRenderJob({id:'a',createdAt:1,nature,savePath:'/a.mbah',projectJson:'{}',outputFolder:'/',request:{payload:'DOC'},epoch:1,ticketDocument:'DOC',onGenerated:async result=>{callbacks.push(result);throw new Error('best effort');}})];
  const lock=createNativeGenerationLock();
  const app=runner(()=>useRenderQueueExecutor({jobs,updateJob:(id,patch)=>{jobs=jobs.map(job=>job.id===id?{...job,...patch}:job);},appendLog:()=>{},lock,isRuntime:()=>true,invoke:()=>native,readAdvancedTicket:()=>({projectEpoch:1,document:'DOC'}),subscribeProgress:()=>()=>{},notify:()=>{}}));
  const settle=async()=>{for(let i=0;i<8;i++){app.render();app.flush();await Promise.resolve();await Promise.resolve();}};
  await settle();
  assert.equal(callbacks.length,0,'nothing is recorded before native success');
  finish();
  await settle();
  assert.equal(callbacks.length,failure?0:1);
  assert.equal(jobs[0].status,failure?'error':'done','a receipt failure never downgrades a successful generation');
  if(!failure)assert.deepEqual(callbacks[0],{projectPath:'/a.mbah',outputPath:'/a.zip'});
  await settle();
  assert.equal(callbacks.length,failure?0:1,'the callback is used once');
  app.unmount();
});

for(const nature of [WORK_NATURE.FREE,WORK_NATURE.ADVANCED]) test(`immutable pre-generation evidence precedes native invocation: ${nature}`,async()=>{
  let ready;const preparing=new Promise(resolve=>{ready=resolve;});
  const events=[];const received=[];
  const callback=async result=>{received.push(result);events.push('receipt');};
  callback.prepare=async job=>{events.push('prepare');await preparing;assert.equal(nature===WORK_NATURE.FREE?job.projectJson:job.request.payload,'DOC');return 'saved A';};
  const original=newRenderJob({id:'proof',createdAt:1,nature,savePath:'/a.mbah',projectJson:'DOC',outputFolder:'/',request:{payload:'DOC'},epoch:1,ticketDocument:'DOC',onGenerated:callback});
  let jobs=[original];
  const app=runner(()=>useRenderQueueExecutor({jobs,updateJob:(id,patch)=>{jobs=jobs.map(job=>({...job,...patch}));},appendLog:()=>{},lock:createNativeGenerationLock(),isRuntime:()=>true,
    invoke:async(command,args)=>{events.push('native');assert.equal(command==='generate_pack'?args.projectJson:args.payload,'DOC');return {zipPath:'/a.zip',outputFingerprint:'published-sha256',conversions:[],destinations:[],warnings:[]};},
    readAdvancedTicket:()=>({projectEpoch:1,document:'DOC'}),subscribeProgress:()=>()=>{},notify:()=>{}}));
  const settle=async()=>{for(let i=0;i<12;i++){app.render();app.flush();await Promise.resolve();await Promise.resolve();}};
  await settle();assert.deepEqual(events,['prepare']);
  original.projectJson='B';original.request.payload='B';
  ready();await settle();
  assert.deepEqual(events,['prepare','native','receipt']);
  assert.deepEqual(received,[{projectPath:'/a.mbah',outputPath:'/a.zip',generatedProjectJson:'saved A',generatedOutputFingerprint:'published-sha256'}]);
  app.unmount();
});

test('advanced proof covers payload, bindings and envelope from the same saved read',async()=>{
  const { createAdvancedProject }=await import('../src/store/projectModel/authoring.js');
  const { buildExportRequest }=await import('../src/store/advancedExport/exportRequest.js');
  const project=createAdvancedProject({payload:'opaque A',projectName:'Advanced A',mediaBindings:[]});
  const options={readProject:()=>project,savePathRef:{current:'/advanced.mbah'},savedSnapshotRef:{current:createWorkSnapshot(project,[],{})},mediaLibraryPathsRef:{current:[]},mediaTagsRef:{current:{}},api:{recordGeneration:async()=>{}},loadSaved:async()=>({data:project,mediaLibraryPaths:[],mediaTags:{},sourceText:'saved envelope A'})};
  const generationApp=runner(()=>useCatalogueGeneration(options));
  const renderGeneration=()=>{generationApp.render();generationApp.flush();return generationApp.render();};
  const callback=renderGeneration();
  assert.equal(renderGeneration(),callback,'unchanged saved evidence keeps the callback stable');
  const request=buildExportRequest({project,outputFolder:'/output',archiveName:'Chosen name'});
  assert.equal(await callback.prepare({savePath:'/advanced.mbah',request}),'saved envelope A');
  assert.equal(await callback.prepare({savePath:'/advanced.mbah',request:{...request,payload:'opaque B'}}),null);
  assert.equal(await callback.prepare({savePath:'/advanced.mbah',request:{...request,mediaBindings:[{id:'new',path:'/new.ogg'}]}}),null);
});
