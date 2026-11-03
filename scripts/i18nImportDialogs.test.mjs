import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).href.replace(/\/$/, '');
import test from 'node:test';
test('revue complémentaire : vrais refus et repli ZIP conservés à chaud', async () => {
const { runner } = await import(root + '/scripts/reactHookDriver.mjs');
const { createDiskHarness } = await import(root + '/scripts/tauriDiskHarness.mjs');
const { createTestI18n } = await import(root + '/scripts/i18nTestSetup.mjs');
const { default: runtime } = await import(root + '/node_modules/i18next/dist/esm/i18next.js');
const { useProjectLoading } = await import(root + '/src/hooks/useProjectLoading.js');
const { useImportSession } = await import(root + '/src/hooks/useImportSession.js');
await runtime.init(createTestI18n().options);
let loading, loadDialog, unpackDialog, imports, heldUnpacking;
const disk = await createDiskHarness({ commands: { unpack_zip_to_entries: async () => { throw { code:'IMPORT_INVALID_ARCHIVE',params:{},detail:'RAW_ARCHIVE' }; } } });
const noop = () => {};
try {
 const loadRunner = runner(() => { loading = useProjectLoading({ store:{}, sdStore:{}, xttsStore:{}, showErrorDialog:d=>loadDialog=d, confirmSaveBeforeLeaveCurrent: async()=>true, handleSaveProject:noop }); });
 loadRunner.render();
 disk.answerOpen('/missing/Auteur.mbah');
 await loading.handleLoad();
 assert.ok(loadDialog);
 const store = { project:{}, savePath:null, workEpochRef:{current:1} };
 const entry = { id:'zip-1',zipPath:'/AUTHOR.zip',name:'' };
 const unpackRunner = runner(() => { imports = useImportSession({ store, projectIndex:{entryById:new Map([['zip-1',entry]]),parentMenuById:new Map()}, workspaceDirRef:{current:disk.workspace},setUnpacking:s=>{if(s)heldUnpacking=s;},showErrorDialog:d=>unpackDialog=d }); });
 unpackRunner.render();
 await imports.handleUnpackZip('zip-1');
 assert.ok(unpackDialog);
 for(const language of ['fr','en','it']) {
  await runtime.changeLanguage(language);
  assert.equal(loadDialog.title,runtime.t('import:project.open.title'));
  assert.equal(unpackDialog.title,runtime.t('import:pack.extraction.title'));
  assert.equal(heldUnpacking.name,runtime.t('import:pack.zip.default'));
 }
 entry.name = 'Nom auteur';
 await imports.handleUnpackZip('zip-1');
 for (const language of ['fr','en','it']) {
  await runtime.changeLanguage(language);
  assert.equal(heldUnpacking.name, 'Nom auteur');
 }
} finally { await disk.dispose(); }

});
