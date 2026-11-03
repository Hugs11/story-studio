import { presentStoredError } from '../src/i18n/userMessage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWindowsPath } from '../src/utils/fileUtils.js';
const portable = path => path.replaceAll('\\', '/');
const portableTags = tags => Object.fromEntries(Object.entries(tags).map(([path, tags]) => [portable(path), tags]));
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
const { loadProjectFromPath } = await import('../src/store/projectIO.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useSessionMediaTriage } = await import('../src/hooks/useSessionMediaTriage.js');
const { getProjectFilePrefix } = await import('../src/utils/projectPrefix.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { beginProjectMediaOutput } = await import('../src/store/projectMediaOutput.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
// Execute the exact triage option passed by App.jsx, rather than a copy of
// its adapter. JSX is parsed only to locate that expression; hooks and I/O
// below are real. This catches a dropped saveToken in the application wiring.
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const appAst = parse(appSource, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
const nodes = [appAst];
let triageOption;
while (nodes.length) {
  const node = nodes.pop();
  if (node.type === 'CallExpression' && node.callee.name === 'useSaveProgress') {
    triageOption = node.arguments[0].properties.find(property => property.key.name === 'triageSessionMedia').value;
    break;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) nodes.push(...value.filter(item => item?.type));
    else if (value?.type) nodes.push(value);
  }
}
assert.ok(triageOption, 'the application supplies its session triage to useSaveProgress');
const bindApplicationTriage = new Function('triageSessionMedia', 'getProjectFilePrefix',
  `return (${appSource.slice(...triageOption.range)});`);

const noop=()=>{};const ref=(current)=>({current});
async function withProject(run, { ephemeral=false, useTriage=false }={}) {
  const disk=await createDiskHarness();
  const { KEYS } = await import('../src/store/persistentSettings.js');
  disk.settings.setItem(KEYS.WORKSPACE_DIR,disk.workspace);
  try {
    let store;let saves;let transfers;let triage;
    const library=ref([]);const saved=ref(null);const errors=[];const moved=[];const copyFailures=[];const promotions=[];
    const sessionDir=await disk.mkdirp('session');
    const session={mode:ephemeral?'ephemeral':'project',dir:sessionDir};
    const target=disk.dir('projet','Azuro.mbah');await disk.mkdirp('projet');
    const app=runner(()=>{
      store=useProjectStore();
      transfers=useMediaTransferHandlers({
        store,copyImportedFilesEnabled:true,setCopyImportedFilesEnabled:noop,
        workspaceDir:disk.workspace,workspaceDirRef:ref(disk.workspace),setWorkspaceDirState:noop,
        savePathRef:{get current(){return store.savePath;}},pathAudit:{},dismissedTransferPromptRef:ref(null),
        setSaveToast:noop,persistProjectSnapshotRef:ref(noop),showErrorDialog:(e)=>errors.push(e),addPathsToMediaLibrary:noop,
      });
      triage=useSessionMediaTriage({
        store, mediaLibraryPathsRef:library, setMediaLibraryPaths:(paths)=>{library.current=paths;},
        showChoiceDialog:async(options)=>{copyFailures.push(options);return 'drop';},
      });
      saves=useSaveProgress({
        store,configuredWorkspaceDir:disk.workspace,mediaLibraryPathsRef:library,setMediaLibraryPaths:(paths)=>{library.current=paths;},
        autoSaveEnabled:false,autoSaveBackupLimit:0,savedSnapshotRef:saved,autoSaveSnapshotRef:ref(null),
        isSavingRef:ref(false),setSaveToast:noop,setRecentProjects:noop,
        showErrorDialog:(e)=>errors.push(e),maybeOfferTransferIntoProject:transfers.maybeOfferTransferIntoProject,
        captureWorkSession:()=>session,isWorkSessionCurrent:()=>true,
        onMediaPathsRelocated:(remap)=>moved.push(remap),
        triageSessionMedia:useTriage ? bindApplicationTriage(triage.triageSessionMedia,getProjectFilePrefix) : null,
        onProjectSaved:(_result,options)=>{if(options) promotions.push(options);},
      });
      return store;
    });
    app.render();store.setProjectType('pack');app.render();
    const c={disk,library,saved,errors,moved,copyFailures,promotions,target,session,get triageRequest(){return triage.triageRequest;},render:()=>app.render(),get store(){return store;},get saves(){return saves;},
      async media(category='voix-generees',filename='sound.mp3') {
        const output=beginProjectMediaOutput({root:ephemeral?sessionDir:disk.workspace,storage:store.readProject().storage,ephemeral});
        try {const directory=await output.directory(category);await fs.mkdir(directory,{recursive:true});const path=`${directory}/${filename}`;await fs.writeFile(path,'media');return path;}
        finally {output.release();}
      },
      async saveAs(){disk.answerSave(target);const result=await saves.handleSaveProjectAs();app.render();return result;},
    };
    await run(c);
  } finally {await disk.dispose();}
}

test('manual naming moves files/catalog/tags/jobs and permanently relocates both history stacks',async()=>withProject(async(c)=>{
  const source=await c.media();c.store.updateRootMedia('rootAudio',source);c.store.updateProjectName('Azuro');c.store.addMediaTag(source,'voix');c.library.current=[source];c.render();
  assert.equal(await c.saveAs(),c.target);
  const target=`${c.disk.workspace}/voix-generees/Azuro/sound.mp3`;
  assert.equal(await c.disk.exists(source),false);assert.equal(await c.disk.exists(target),true);
  assert.equal(c.store.project.rootAudio,normalizeWindowsPath(target));assert.deepEqual(c.library.current.map(portable),[target]);assert.deepEqual(portableTags(c.store.readMediaTags()),{[target]:['voix']});
  assert.equal(portable(c.moved[0](source)),target);assert.equal(c.store.project.storage.provisional,false);
  assert.equal(c.saved.current,createWorkSnapshot(c.store.project,c.library.current,c.store.readMediaTags()));
  c.store.undo();c.render();assert.equal(c.store.project.storage.provisional,false);assert.equal(c.store.project.storage.folder,'Azuro');assert.equal(portable(c.store.project.rootAudio),target);
  c.store.redo();c.render();assert.equal(c.store.project.storage.provisional,false);
  c.store.updateProjectName('Azuro v2');c.render();
  const next=await c.media('images-generees','new.png');assert.match(next,/images-generees\/Azuro\/new.png$/);
  await c.saves.handleSave();c.render();assert.equal(c.store.project.storage.folder,'Azuro');
}));

test('failed mbah write rolls disk back before publishing any memory or history changes',async()=>withProject(async(c)=>{
  const source=await c.media();c.store.updateRootMedia('rootAudio',source);c.store.updateProjectName('Azuro');c.library.current=[source];c.store.addMediaTag(source,'voix');c.render();
  const before=structuredClone(c.store.readProject());
  c.disk.injectFailure({cmd:'plugin:fs|write_text_file',match:'Azuro.mbah'});
  assert.equal(await c.saveAs(),null);assert.deepEqual(c.store.project,before);
  assert.equal(await c.disk.exists(source),true);assert.equal(await c.disk.exists(`${c.disk.workspace}/voix-generees/Azuro`),false);
  assert.deepEqual(c.library.current,[source]);assert.deepEqual(c.store.readMediaTags(),{[source]:['voix']});
  assert.match(presentStoredError(c.errors.at(-1).message),/panne injectée/);
  assert.equal(await c.saveAs(),c.target);assert.equal(c.store.project.storage.provisional,false);
}));

test('autosave and author typing do not name folders; busy producer defers until next Ctrl+S',async()=>withProject(async(c)=>{
  const source=await c.media();c.store.updateRootMedia('rootAudio',source);c.store.setSavePath(c.target);c.store.updateProjectName('Azuro');c.render();
  assert.equal((await c.saves.handleSave({silent:true})).status,'saved');c.render();
  assert.equal(c.store.project.storage.provisional,true);assert.equal(await c.disk.exists(source),true);
  assert.equal(c.disk.countCalls('rename_project_folder'),0);
  const producer=beginProjectMediaOutput({root:c.disk.workspace,storage:c.store.project.storage,ephemeral:false});
  await producer.arguments();assert.equal(await c.saves.handleSave(),c.target);c.render();
  assert.equal(c.store.project.storage.provisional,true);assert.equal(await c.disk.exists(source),true);
  producer.release();assert.equal(await c.saves.handleSave(),c.target);c.render();assert.equal(c.store.project.storage.provisional,false);
  assert.equal(await c.disk.exists(source),false);
}));

test('ephemeral promotion copies media straight to final category folders and persists storage',async()=>withProject(async(c)=>{
  const voice=await c.media();const image=await c.media('images-generees','image.png');const micro=await c.media('enregistrements','record.webm');
  c.store.updateRootMedia('rootAudio',voice);c.store.updateRootMedia('rootImage',image);c.store.addStory(null,micro,{name:'Micro'});c.store.updateProjectName('Azuro');c.store.addMediaTag(voice,'voix');c.library.current=[voice];c.render();
  assert.equal(await c.disk.exists(`${c.disk.workspace}/voix-generees`),false);
  assert.equal(await c.saveAs(),c.target);
  for(const [category,name] of [['voix-generees','sound.mp3'],['images-generees','image.png'],['enregistrements','record.webm']]) {
    assert.equal(await c.disk.exists(`${c.disk.workspace}/${category}/Azuro/${name}`),true);
    assert.equal(await c.disk.exists(`${c.disk.workspace}/${category}/Projet sans titre`),false);
  }
  const body=JSON.parse(await fs.readFile(c.target,'utf8'));assert.equal(body.storage.provisional,false);assert.equal(body.storage.folder,'Azuro');
  assert.deepEqual(portableTags(c.store.readMediaTags()),{[`${c.disk.workspace}/voix-generees/Azuro/sound.mp3`]:['voix']});
  assert.ok(!Object.keys(body.mediaTags).some(path=>path.includes('/session/')));
},{ephemeral:true}));


test('session promotion copies an edited take whose deleted original is cited by its sidecar, without the sidecar',async()=>withProject(async(c)=>{
  const take=await c.media('enregistrements','take.wav');
  const edited=await c.media('fichiers-importes','take.mp3');
  const sidecar=`${c.session.dir}/fichiers-importes/.story-studio-audio-edits/take.mp3.edit.json`;
  await fs.mkdir(`${c.session.dir}/fichiers-importes/.story-studio-audio-edits`,{recursive:true});
  await fs.writeFile(sidecar,JSON.stringify({original_path:take,mode:'convert'}));
  await fs.rm(take);
  c.store.updateRootMedia('rootAudio',edited);c.store.updateProjectName('Azuro');c.render();
  assert.equal(await c.saveAs(),c.target);assert.deepEqual(c.errors,[]);
  const target=`${c.disk.workspace}/fichiers-importes/Azuro/take.mp3`;
  assert.equal(c.store.project.rootAudio,normalizeWindowsPath(target));assert.equal(await c.disk.exists(target),true);
  assert.equal(await c.disk.exists(`${c.disk.workspace}/fichiers-importes/Azuro/.story-studio-audio-edits`),false);
  assert.equal(c.store.project.storage.provisional,false);
  assert.equal(normalizeWindowsPath(JSON.parse(await fs.readFile(c.target,'utf8')).rootAudio),normalizeWindowsPath(target));
},{ephemeral:true}));

test('cancelling the first manual save leaves the provisional folders and descriptor untouched', async () => withProject(async (c) => {
  const source = await c.media();
  c.store.updateRootMedia('rootAudio', source);
  c.store.updateProjectName('Azuro');
  c.render();
  const before = structuredClone(c.store.project);
  c.disk.answerSave(null);
  assert.equal(await c.saves.handleSaveProjectAs(), null);
  c.render();
  assert.deepEqual(c.store.project, before);
  assert.equal(await c.disk.exists(source), true);
  assert.equal(c.disk.countCalls('rename_project_folder'), 0);
}));


test('App wiring keeps the save token while retaining an unassigned session voice at the first save', async () => withProject(async (c) => {
  const source = await c.media('voix-generees', 'unused.mp3');
  c.store.updateProjectName('Azuro');
  c.store.addMediaTag(source, 'à conserver');
  c.library.current = [source];
  c.render();
  const storageBefore = structuredClone(c.store.project.storage);
  const saving = c.saveAs();
  const deadline = Date.now() + 3000;
  while (!c.triageRequest && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
    c.render();
  }
  assert.ok(c.triageRequest, 'first save asks what to keep from the captured session');
  assert.deepEqual(c.triageRequest.items.map(item => item.path), [source]);
  c.triageRequest.resolve({ keptPaths: [source] });
  assert.equal(await saving, c.target);
  c.render();
  const target = `${c.disk.workspace}/voix-generees/Azuro/unused.mp3`;
  assert.equal(c.disk.countCalls('copy_project_media'), 1);
  assert.equal(await c.disk.exists(target), true);
  assert.deepEqual(c.library.current.map(portable), [target]);
  assert.deepEqual(portableTags(c.store.readMediaTags()), { [target]: ['à conserver'] });
  const reopened = await loadProjectFromPath(c.target);
  assert.deepEqual(reopened.mediaLibraryPaths.map(portable), [target]);
  assert.deepEqual(portableTags(reopened.mediaTags), { [target]: ['à conserver'] });
  assert.deepEqual(reopened.data.storage, c.store.project.storage);
  assert.deepEqual(c.copyFailures, [], 'no retry/drop dialogue masks a lost token');
  assert.deepEqual(c.errors, []);
  assert.equal(c.promotions.length, 1);
  assert.equal(c.promotions[0].promote, true);
  assert.equal(c.promotions[0].session, c.session);
  assert.equal(c.promotions[0].workspaceDir, c.disk.workspace);
  assert.equal(c.store.project.storage.workId, storageBefore.workId);
  assert.equal(c.store.project.storage.provisional, false);
  assert.equal(c.store.project.storage.folder, 'Azuro');
}, { ephemeral: true, useTriage: true }));
