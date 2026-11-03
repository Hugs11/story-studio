import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAggregateLanding, landAggregate, refreshAggregateMetadata, moveAggregatePack, aggregateDestinationReducer, INITIAL_AGGREGATE_DESTINATION } from '../src/components/AggregatePacks/aggregateLanding.js';
import { buildAggregateProject, defaultMetadataForPacks } from '../src/components/AggregatePacks/aggregateProject.js';
import { createZipEntry, DEFAULT_PACK_METADATA, normalizeProjectData, projectToRustExport, projectToSerializable, walkProjectMediaReferences } from '../src/store/projectModel.js';
import { collectSessionBoundReferences } from '../src/store/sessionMediaTriage.js';
import { parseConventionName, getExportPackName } from '../src/utils/packConvention.js';
import { translateHome } from '../src/i18n/homePresentation.js';
import preparation from './fixtures/catalogue/assembly-preparation.json' with { type: 'json' };
import { assemblyPacks } from '../src/store/catalogue/assemblySelection.js';
import { createCatalogueAssemblyApi } from '../src/store/catalogue/catalogueAssemblyApi.js';
import transferFixture from './fixtures/catalogue/assembly-transfer.json' with { type: 'json' };

const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function draft(packs = [{ id: 'a', name: 'Premier', fileName: '5+]Premier.zip', path: '/source/first.zip', coverImage: '/source/cover.png', coverAudio: '/source/voice.mp3' }]) {
  return { packs, rootAudio: '/draft/root.mp3', rootImage: '/draft/root.png', metadata: defaultMetadataForPacks(packs, uuid) };
}
const copy = async (source, workspace) => `${workspace}/${path.basename(source)}`;
const stripEntryIds = project => {
  const next = structuredClone(project);
  for (const entry of next.rootEntries) delete entry.id;
  return next;
};

for (const entry of ['home', 'catalogue']) {
  for (const destination of ['editor', 'generate']) {
    test(`${entry} → ${destination} preserves the same aggregate metadata and entry order`, async () => {
      const packs = entry === 'catalogue' ? assemblyPacks(preparation) : draft().packs;
      const current = draft(packs);
      if (entry === 'catalogue') current.metadata.minAge = String(preparation.suggestedAgeMin);
      const preview = buildAggregateProject(current);
      let transfers = 0;
      const project = await prepareAggregateLanding({
        draft: current, preparation: entry === 'catalogue' ? preparation : null,
        workspaceDir: '/session', copy, requestId: 'request',
        transfer: async ({ preparationId, workSessionId }) => {
          transfers++;
          return { preparationId, ownerSessionId: workSessionId, transferred: true, assets: preparation.entries.flatMap(item => [item.zipPath, item.coverPath].filter(Boolean).map(sourcePath => ({sourcePath, sessionPath: `/session/${path.basename(sourcePath)}`}))) };
        },
      });
      assert.equal(transfers, entry === 'catalogue' ? 1 : 0);
      assert.equal(project.packMetadata.uuid, preview.packMetadata.uuid);
      assert.equal(project.packMetadata.minAge, preview.packMetadata.minAge);
      assert.deepEqual(project.rootEntries.map(item => item.name), packs.map(item => item.name));
      if (destination === 'generate') {
        assert.equal(projectToRustExport(project).packUuid, uuid);
      } else {
        assert.equal(project.projectType, 'pack');
        assert.ok(collectSessionBoundReferences({ project, sessionDir: '/session' }).length >= 3);
      }
    });
  }
}

test('an explicit unknown age survives build, save envelope, reopen and Rust export name', () => {
  for (const minAge of ['', '0', '9']) {
    const current = draft();
    current.metadata.minAge = minAge;
    const project = buildAggregateProject(current);
    const saved = JSON.parse(JSON.stringify(projectToSerializable(project)));
    const reopened = normalizeProjectData(saved);
    assert.equal(project.packMetadata.minAge, minAge);
    assert.equal(reopened.packMetadata.minAge, minAge);
    if (minAge === '') assert.doesNotMatch(projectToRustExport(reopened).name, /^3\+\]/);
    if (minAge === '0') assert.match(projectToRustExport(reopened).name, /^0\+\]/);
  }
});

test('both entry types suggest max or empty, including explicit clearing and zero', () => {
  for (const packs of [
    [{ name: 'First', fileName: '4+]First.zip' }, { name: 'Second', fileName: '8+]Second.zip' }],
    [{ ageMin: 4 }, { ageMin: 8 }, { ageMin: null }],
  ]) assert.equal(defaultMetadataForPacks(packs, uuid).minAge, '8');
  for (const packs of [[], [{fileName:'Unknown.zip'}], [{ageMin:null, fileName:'8+]Cleared.zip'}], [{ageMax:9}]]) {
    assert.equal(defaultMetadataForPacks(packs, uuid).minAge, '');
    assert.equal(buildAggregateProject(draft(packs)).packMetadata.minAge, '');
  }
  assert.equal(defaultMetadataForPacks([{ageMin:0}],uuid).minAge,'0');
});

test('editing any metadata field protects all user fields from subsequent entry changes', () => {
  const before = { ...draft().metadata, title:'Mon titre', minAge:'', version:7, description:'Notes', author:'Auteur', namingMode:'legacy', legacyExportName:'Nom personnalisé' };
  const packs = [{ageMin:12}];
  assert.equal(refreshAggregateMetadata(before,packs,true),before);
  const suggested = refreshAggregateMetadata(before,packs,false);
  assert.equal(suggested.minAge,'12');
  assert.equal(suggested.title,'Mon titre');
  assert.equal(suggested.uuid,uuid);
  assert.equal(getExportPackName(before),'Nom personnalisé');
});

test('reordering retains exact entry objects, corrected fields and paths', () => {
  const first={id:'a',name:'Corrigé',path:'/First.zip',coverImage:'/Cover.PNG',ageMin:8};
  const second={id:'b',name:'Autre',path:'/second.zip',coverAudio:'/voice.mp3'};
  const original=[first,second];
  const moved=moveAggregatePack(original,0,1);
  assert.deepEqual(moved,[second,first]);
  assert.equal(moved[1],first);
  assert.deepEqual(original,[first,second]);
  assert.equal(moveAggregatePack(original,0,-1),original);
  assert.equal(moveAggregatePack(original,1,1),original);
  assert.equal(moveAggregatePack(original,-1,1),original);
});

test('destination reducer does not start work, clears stale confirmation and ignores unknown choices', () => {
  let state=aggregateDestinationReducer(INITIAL_AGGREGATE_DESTINATION,{type:'choose',destination:'generate'});
  assert.equal(state.confirmation,null);
  state=aggregateDestinationReducer(state,{type:'review',confirmation:{folder:'/output',fileName:'pack.zip'}});
  assert.equal(state.confirmation.folder,'/output');
  state=aggregateDestinationReducer(state,{type:'cancel'});
  assert.equal(state.destination,'generate');
  assert.equal(state.confirmation,null);
  state=aggregateDestinationReducer(state,{type:'choose',destination:'editor'});
  assert.equal(aggregateDestinationReducer(state,{type:'review',confirmation:{}}),state);
  assert.equal(aggregateDestinationReducer(state,{type:'choose',destination:'other'}),state);
});

test('landing runs background and save guards before any session or copy', async () => {
  for (const [background,save,expected] of [[false,true,['background']],[true,false,['background','save']],[true,true,['background','save','session','prepare','install']]]) {
    const events=[];
    const result=await landAggregate({
      confirmBackgroundWork:async()=>{events.push('background');return background;},
      confirmSave:async()=>{events.push('save');return save;},
      runLanding:async(type,fn,options)=>{events.push('session');assert.equal(type,'pack');assert.equal(options.applyProjectType,false);assert.equal(options.forceEphemeral,true);await fn('/session');},
      prepare:async dir=>{events.push('prepare');assert.equal(dir,'/session');return {projectType:'pack'};},
      install:async project=>{events.push('install');assert.equal(project.projectType,'pack');},
    });
    assert.equal(result,background&&save);
    assert.deepEqual(events,expected);
  }
});

test('transfer and media copy failures never install a phantom project and preserve source draft', async () => {
  for (const failureAt of ['transfer','copy']) {
    const original=draft(assemblyPacks(preparation));
    const snapshot=structuredClone(original);
    let installed=false;
    await assert.rejects(landAggregate({
      confirmBackgroundWork:async()=>true,confirmSave:async()=>true,
      runLanding:async(type,fn)=>fn('/session'),
      prepare:workspaceDir=>prepareAggregateLanding({draft:original,preparation,workspaceDir,requestId:'request',
        transfer:async()=>{if(failureAt==='transfer')throw Error('transfer');return {preparationId:preparation.preparationId,ownerSessionId:'/session',transferred:true,assets:preparation.entries.flatMap(item=>[item.zipPath,item.coverPath].filter(Boolean).map(sourcePath=>({sourcePath,sessionPath:`/session/${path.basename(sourcePath)}`})))};},
        copy:async()=>{throw Error('copy');},
      }),install:()=>{installed=true;},
    }),new RegExp(failureAt));
    assert.equal(installed,false);
    assert.deepEqual(original,snapshot);
  }
});

test('incomplete or mismatched transfer receipt cannot publish a project', async () => {
  for (const patch of [{transferred:false},{ownerSessionId:'another'},{preparationId:'another'},{assets:null},{assets:[]}]) {
    await assert.rejects(prepareAggregateLanding({draft:draft(assemblyPacks(preparation)),preparation,workspaceDir:'/session',requestId:'request',copy,
      transfer:async()=>({preparationId:preparation.preparationId,ownerSessionId:'/session',transferred:true,assets:[],...patch}),
    }),error=>error.code==='CATALOG_ASSEMBLY_TRANSFER_FAILED');
  }
});

test('transfer API matches the handwritten native contract and presents coded failures',async()=>{
  const args={preparationId:'prepared',workSessionId:'session',requestId:'request'};
  const api=createCatalogueAssemblyApi({invoke:async(command,actual)=>{
    assert.equal(command,'catalogue_transfer_assembly');assert.deepEqual(actual,args);return transferFixture;
  }});
  assert.deepEqual(await api.transfer(args),transferFixture);
  for(const code of ['CATALOG_ASSEMBLY_TRANSFER_FAILED','CATALOG_ASSEMBLY_SESSION_INVALID']) {
    const failed=createCatalogueAssemblyApi({invoke:async()=>{throw {code,params:{}};}});
    await assert.rejects(failed.transfer(args),error=>error.code===code && !error.message.includes('[object Object]'));
  }
});

test('duplicate media paths are copied once, while POSIX path case remains distinct',async()=>{
  const current=draft([{name:'One',path:'/Source.zip',coverImage:'/Cover.png',coverAudio:'/voice.mp3'},{name:'Two',path:'/source.zip',coverImage:'/Cover.png',coverAudio:'/voice.mp3'}]);
  current.rootImage='/Cover.png';
  const copies=[];
  const project=await prepareAggregateLanding({draft:current,workspaceDir:'/session',copy:async(source,workspace)=>{copies.push(source);return copy(source,workspace);}});
  assert.equal(copies.filter(p=>p==='/Cover.png').length,1);
  assert.ok(copies.includes('/Source.zip'));
  assert.ok(copies.includes('/source.zip'));
  assert.equal(project.rootImage,project.rootEntries[0].coverImage);
});

test('closing assistant, purging its cache, saving and reopening leaves all promoted references valid',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aggregate-lifetime-'));
  try {
    const assistant=path.join(root,'assistant');const owned=path.join(root,'catalogue-cache');
    const session=path.join(root,'session');const saved=path.join(root,'saved');
    for(const dir of [assistant,owned,session,saved])await fs.mkdir(dir);
    const paths={zip:path.join(owned,'0.zip'),cover:path.join(owned,'0.jpg'),rootAudio:path.join(assistant,'menu.mp3'),rootImage:path.join(assistant,'menu.png')};
    for(const file of Object.values(paths))await fs.writeFile(file,`media:${path.basename(file)}`);
    const prepared={preparationId:'prepared',entries:[{zipPath:paths.zip,coverPath:paths.cover}]};
    const current={...draft([{name:'Été',path:paths.zip,coverImage:paths.cover}]),rootAudio:paths.rootAudio,rootImage:paths.rootImage};
    const project=await prepareAggregateLanding({draft:current,preparation:prepared,workspaceDir:session,requestId:'request',
      transfer:async()=>{const assets=[];for(const sourcePath of [paths.zip,paths.cover]){const sessionPath=path.join(session,path.basename(sourcePath));await fs.copyFile(sourcePath,sessionPath);assets.push({sourcePath,sessionPath});}return {preparationId:'prepared',ownerSessionId:session,transferred:true,assets};},
      copy:async(source,workspace)=>{const target=path.join(workspace,path.basename(source));await fs.copyFile(source,target);return target;},
    });
    await fs.rm(assistant,{recursive:true});await fs.rm(owned,{recursive:true});
    for(const ref of walkProjectMediaReferences(project))assert.ok((await fs.readFile(ref.path)).length>0);
    // Exercise the same media walker used by save and session cleanup.
    const persistent=structuredClone(project);const known=new Map();
    for(const ref of walkProjectMediaReferences(persistent)) {
      if(!known.has(ref.path)){const target=path.join(saved,path.basename(ref.path));await fs.copyFile(ref.path,target);known.set(ref.path,target);}
      ref.obj[ref.key]=known.get(ref.path);
    }
    assert.equal(collectSessionBoundReferences({project:persistent,sessionDir:session}).length,0);
    const filename=path.join(saved,'projet.mbah');
    await fs.writeFile(filename,JSON.stringify(projectToSerializable(persistent)));
    await fs.rm(session,{recursive:true});
    const reopened=normalizeProjectData(JSON.parse(await fs.readFile(filename,'utf8')));
    assert.equal(reopened.packMetadata.uuid,uuid);
    for(const ref of walkProjectMediaReferences(reopened))assert.ok((await fs.readFile(ref.path)).length>0);
    assert.equal(projectToRustExport(reopened).rootEntries[0].zipPath,path.join(saved,'0.zip'));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

// Source captured with git show 926c1d074c52e378e356649a646c0dc041c37427:
// src/components/AggregatePacks/aggregateProject.js, before this change.
test('direct generation project remains equivalent to the original source fixture',async()=>{
  const source=await fs.readFile(new URL('./fixtures/aggregateProject.original.txt',import.meta.url),'utf8');
  const executable=source.replace(/^import .*;\n/gm,'').replace(/export function /g,'function ');
  const original=new Function('t','createZipEntry','DEFAULT_PACK_METADATA','normalizeProjectData','parseConventionName',`${executable}\nreturn {buildAggregateProject,defaultMetadataForPacks};`)(translateHome,createZipEntry,DEFAULT_PACK_METADATA,normalizeProjectData,parseConventionName);
  const current=draft();
  const before=projectToRustExport(original.buildAggregateProject(current));
  const after=projectToRustExport(buildAggregateProject(current));
  assert.deepEqual(stripEntryIds(after),stripEntryIds(before));
  assert.equal(after.packUuid,uuid);
  assert.equal(after.globalOptions.harmonizeLoudness,true);
});

test('a landing result from an expired work session cannot install over newer work', async () => {
  let installed = false;
  await assert.rejects(landAggregate({
    confirmBackgroundWork: async () => true,
    confirmSave: async () => true,
    runLanding: (type, fn) => fn('/old-session', { isCurrent: () => false }),
    prepare: async () => buildAggregateProject(draft()),
    install: () => { installed = true; },
  }), error => error.code === 'CATALOG_ASSEMBLY_SESSION_INVALID');
  assert.equal(installed, false);
});

test('reviewed generation retains its complete snapshot after editing entries, order and root media', async () => {
  const { createAggregateConfirmation } = await import('../src/components/AggregatePacks/aggregateLanding.js');
  const current = draft([
    { name: 'Premier', path: '/old/first.zip', coverImage: '/old/cover.png', coverAudio: '/old/cover.mp3' },
    { name: 'Second', path: '/old/second.zip' },
  ]);
  const review = createAggregateConfirmation(current, '/output');
  current.packs.reverse();
  current.packs[1].path = '/new/first.zip';
  current.packs[1].coverImage = '/new/cover.png';
  current.packs[1].coverAudio = '/new/cover.mp3';
  current.packs.push({ name: 'Ajout', path: '/new/third.zip' });
  current.rootAudio = '/new/root.mp3';
  current.rootImage = '/new/root.png';
  current.metadata.title = 'Changed';
  const confirmedProject = buildAggregateProject(review.draft);
  assert.deepEqual(confirmedProject.rootEntries.map(entry => entry.zipPath), ['/old/first.zip', '/old/second.zip']);
  assert.equal(confirmedProject.rootEntries[0].coverImage, '/old/cover.png');
  assert.equal(confirmedProject.rootEntries[0].coverAudio, '/old/cover.mp3');
  assert.equal(confirmedProject.rootAudio, '/draft/root.mp3');
  assert.equal(confirmedProject.rootImage, '/draft/root.png');
  assert.notEqual(confirmedProject.packMetadata.title, current.metadata.title);
  assert.deepEqual(review.files, ['/old/first.zip', '/old/cover.png', '/old/cover.mp3', '/old/second.zip', '/draft/root.mp3', '/draft/root.png']);
  assert.equal(review.folder, '/output');
});

test('catalogue age follows additions and removals until the age itself is edited', () => {
  const prepared = { ...preparation, entries: [{ ...preparation.entries[0], ageMin: 3 }] };
  let packs = assemblyPacks(prepared);
  assert.equal(packs[0].ageMin, 3);
  let metadata = { ...defaultMetadataForPacks(packs, uuid), title: 'User title', author: 'User author' };
  packs = [...packs, { name: 'Older', fileName: '12+]Older.zip', path: '/older.zip' }];
  metadata = refreshAggregateMetadata(metadata, packs, false);
  assert.equal(metadata.minAge, '12');
  assert.equal(metadata.title, 'User title');
  assert.equal(metadata.author, 'User author');
  assert.equal(metadata.uuid, uuid);
  packs = packs.slice(0, 1);
  metadata = refreshAggregateMetadata(metadata, packs, false);
  assert.equal(metadata.minAge, '3');
  assert.equal(refreshAggregateMetadata(metadata, [], false).minAge, '');
  for (const age of ['', '0', '8']) {
    const chosen = { ...metadata, minAge: age };
    assert.equal(refreshAggregateMetadata(chosen, [{ ageMin: 12 }], true), chosen);
  }
  assert.equal(assemblyPacks({ entries: [{...prepared.entries[0],ageMin:null}] })[0].ageMin, null);
});
