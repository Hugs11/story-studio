import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';

const fixtures={ sources:{items:[],sourcesRevision:1,loading:false,busy:false,exclusions:{items:[]}},operations:{state:{items:{},hidden:{},dismissed:{},selected:null},ready:true},entries:{cards:[],status:'ready'} };
const callbacks={onRemove:()=>{},onRefresh:()=>{},onAdd:()=>{},onClose:()=>{},onCancel:()=>{},onReport:()=>{},onSources:()=>{}};
test('catalogue shell and sources render FR/EN/IT, distinct empties and accessible commands', async()=>{
  const server=await createServer({configFile:false,plugins:[{name:'catalogue-surface',enforce:'pre',transform(code,id){
    if(id.endsWith('/useCatalogueSources.js'))return 'export function useCatalogueSources(){return globalThis.__catalogueSurface.sources;}';
    if(id.endsWith('/useCatalogueOperations.js'))return 'export function useCatalogueOperations(){return globalThis.__catalogueSurface.operations;}';
    if(id.endsWith('/useCatalogueEntries.js'))return 'export function useCatalogueEntries(){return globalThis.__catalogueSurface.entries;}';
  }},react()],server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
  const previous=globalThis.__catalogueSurface;
  try{
    globalThis.__catalogueSurface=fixtures;
    const {initializeI18n}=await server.ssrLoadModule('/src/i18n/index.js');
    const engine=initializeI18n('fr');
    const {CatalogueScreen,CataloguePlaceholder}=await server.ssrLoadModule('/src/components/Catalogue/CatalogueScreen.jsx');
    const {SourceRow}=await server.ssrLoadModule('/src/components/Catalogue/sources/SourceRow.jsx');
    const {ScanSummary}=await server.ssrLoadModule('/src/components/Catalogue/operations/ScanSummary.jsx');
    const {ScanTracker}=await server.ssrLoadModule('/src/components/Catalogue/operations/ScanTracker.jsx');
    const {OperationIssuesContent}=await server.ssrLoadModule('/src/components/Catalogue/operations/OperationIssues.jsx');
    const { operationIssueItems, rememberRepatriationTitle } = await server.ssrLoadModule('/src/store/catalogue/operationView.js');
    const technicalKey = '5364042f-cf80-4d5d-b1a0-123456789abc';
    rememberRepatriationTitle('known-transfer', 'Le loup');
    rememberRepatriationTitle(technicalKey, null);
    // Reuse the same items across language switches: translation belongs to rendering.
    const transferError = { code: 'STORYTELLER_STORY_UNREADABLE' };
    const namedItems = operationIssueItems({ items: [] }, { requestId: 'known-transfer', error: transferError });
    const untitledItems = operationIssueItems({ items: [] }, { requestId: technicalKey, error: transferError });
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const render=(component,props)=>renderToStaticMarkup(React.createElement(ErrorDialogProvider,null,React.createElement(component,props)));
    for(const language of ['fr','en','it']){
      await engine.changeLanguage(language);
      const shell=render(CatalogueScreen,{...callbacks});
      assert.equal((shell.match(/aria-live=/g)||[]).length,1);
      assert.doesNotMatch(shell, /catalogue-refresh-reason|<nav|<details|catalogue-organization-actions|catalogue-selection-bar/);
      assert.doesNotMatch(shell,/catalogue:|\[object Object\]/);
      const originalEntries = globalThis.__catalogueSurface.entries;
      const originalSources = globalThis.__catalogueSurface.sources;
      const error = { code: 'CATALOG_STORE_UNAVAILABLE' };
      globalThis.__catalogueSurface.entries = { cards: [], status: 'error', error };
      globalThis.__catalogueSurface.sources = { ...originalSources, error };
      const unavailable = render(CatalogueScreen, callbacks);
      const failureText = renderToStaticMarkup(React.createElement('h2', null, engine.t('catalogue:header.unavailable')));
      assert.equal(unavailable.split(failureText).length - 1, 1);
      assert.doesNotMatch(unavailable, /catalogue-notice|catalogue:|\[object Object\]/);
      globalThis.__catalogueSurface.entries = originalEntries;
      globalThis.__catalogueSurface.sources = originalSources;

      const emptyCases=[{sources:[]},{sources:[{status:'active',availability:'available'}],scanning:true},{sources:[{status:'active',availability:'available'}]},{sources:[{status:'active',availability:'unavailable'}]},{sources:[{status:'active',availability:'available'}],filtered:true}];
      const rendered=emptyCases.map(props=>render(CataloguePlaceholder,{...callbacks,...props,count:0}));
      assert.equal(new Set(rendered).size,5);
      for(const availability of ['available','unavailable','unknown']){
        const html=render(SourceRow,{...callbacks,source:{id:'s',path:'/_AUTHOR_FULL_PATH_',origin:'manual',status:'active',availability,lastScanAt:null,exemplarCount:1},busy:true});
        assert.match(html,/_AUTHOR_FULL_PATH_/);assert.match(html, /<button[^>]*disabled=""/);assert.doesNotMatch(html,/catalogue:|\[object Object\]/);
      }
      const scanningRow = render(SourceRow, { ...callbacks, source: { id: 'scan', path: '/scan', scanning: true } });
      assert.match(scanningRow, /<svg[^>]*class="opts-catalogue-scan-spinner"/, 'scan progress uses its own animated Loader2');
      assert.doesNotMatch(render(SourceRow, { ...callbacks, source: { id: 'idle', path: '/idle', lastScanStatus: 'success' } }), /opts-catalogue-scan-spinner/);
      for(const status of ['declined','removed','active'])assert.doesNotMatch(render(SourceRow,{...callbacks,source:{id:'s',path:'/path',origin:'workspace',status,availability:'available',scanning:true,lastScanAt:1,lastScanStatus:'partial',includedIn:'parent'},sources:[{id:'parent',path:'/parent'}]}),/catalogue:/);
      for(const status of ['success','partial','failed','cancelled']){
        const html=render(ScanSummary,{...callbacks,snapshot:{operationId:'s',status,scanComplete:false,outcomes:{refused:2},reasons:[{reason:'protectedArchive',outcome:'refused',count:2}],roots:{failed:1}}});
        assert.doesNotMatch(html,/catalogue:|\[object Object\]/);
      }
      for (const embedded of [false, true]) for (const operationKind of [undefined, 'trash', 'assembly', 'catalogueImport']) {
        const html = render(ScanSummary, { ...callbacks, embedded, snapshot: { operationId: 'failure', operationKind, status: 'failed', error } });
        assert.equal((html.match(/class="catalogue-notice/g) || []).length, 1, 'the snapshot error is displayed once');
        assert.doesNotMatch(html, /<details|catalogue-operation-issues/, 'a snapshot-only error has no empty Problems section');
      }
      const repatriation = render(ScanSummary, { ...callbacks, snapshot: { operationId: 'transfer', operationKind: 'luniiRepatriate', status: 'failed', error: { code: 'STORYTELLER_STORY_UNREADABLE' } } });
      assert.match(repatriation, /<details/, 'repatriation still offers its snapshot-only issue');
      assert.match(render(ScanTracker,{...callbacks,snapshot:{operationId:'s',status:'cancelling'}}),/aria-disabled="true" aria-describedby="cancel-reason-s"/);
      const report = render(OperationIssuesContent,{...callbacks,items:[{path:'/_PATH_',outcome:'refused',reason:'corruptArchive'}]});
      assert.doesNotMatch(report,/catalogue-reveal-unavailable|aria-disabled/);
      assert.doesNotMatch(report, /<button|Réessayer|Copier les détails/);
      const compression = { code: 'FILES_ARCHIVE_COMPRESSION_UNSUPPORTED', params: { archive: 'Quiz.zip', method: 'LZMA', entryName: 'pack/ni', error: 'decoder failure' } };
      const compressionReport = render(OperationIssuesContent, { ...callbacks, items: [{ path: '/Quiz.zip', outcome: 'refused', reason: 'unsupportedFormat', detail: JSON.stringify({ code: 'IMPORT_UNSUPPORTED_COMPRESSION', detail: JSON.stringify(compression) }) }] });
      const compressionMessage = engine.t('rust:FILES_ARCHIVE_COMPRESSION_UNSUPPORTED', compression.params).replaceAll("'", '&#x27;').replaceAll('"', '&quot;');
      assert.equal(compressionReport.split(compressionMessage).length - 1, 1);
      assert.doesNotMatch(compressionReport, /IMPORT_UNSUPPORTED_COMPRESSION|&quot;code&quot;/);
      const transferReport = render(OperationIssuesContent, { items: [{ path: 'Le loup', detail: { code: 'STORYTELLER_STORY_UNREADABLE', detail: 'repatriation: decrypt-index-li' } }] });
      assert.match(transferReport, /Le loup/);
      assert.equal(transferReport.split('repatriation: decrypt-index-li').length - 1, 1);
      assert.doesNotMatch(transferReport, /STORYTELLER_STORY_UNREADABLE|\[object Object\]/);
      assert.match(render(OperationIssuesContent, { items: namedItems }), /Le loup/);
      const untitledReport = render(OperationIssuesContent, { items: untitledItems });
      const expectedTitle = { fr: 'Histoire sans titre', en: 'Untitled story', it: 'Storia senza titolo' }[language];
      assert.ok(untitledReport.includes(expectedTitle));
      assert.ok(!untitledReport.includes(technicalKey));
      assert.doesNotMatch(untitledReport, /catalogue:lunii.untitled|\[object Object\]/);

      for(const count of [0,1,2,1000000]){
        const output=engine.t('catalogue:progress.analysis.provisional',{analysed:1,count});
        assert.doesNotMatch(output,/1 analysés|1 analizzati/);
        assert.ok(output.includes(String(count)));
      }
    }
  }finally{globalThis.__catalogueSurface=previous;await server.close();}
});
