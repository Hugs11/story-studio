import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';

test('resume banner and D70 choices have translated actions and an explicit project default',async()=>{
  const server=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
  try {
    const {initializeI18n}=await server.ssrLoadModule('/src/i18n/index.js');
    const engine=initializeI18n('fr');
    const {FormatTag}=await server.ssrLoadModule('/src/components/Catalogue/FormatTag.jsx');
    const {ResumeBanner}=await server.ssrLoadModule('/src/components/Catalogue/open/ResumeBanner.jsx');
    const {editWarningDialog}=await server.ssrLoadModule('/src/components/Catalogue/open/EditWarningDialog.jsx');
    for(const language of ['fr','en','it']) {
      await engine.changeLanguage(language);
      const html=renderToStaticMarkup(React.createElement(ResumeBanner,{recoveries:[{projectName:'Ancien',modifiedAtMs:1000},{projectName:'_RECENT_',modifiedAtMs:2000}]}));
      assert.match(html,/_RECENT_/);
      assert.doesNotMatch(html,/Ancien|catalogue:|undefined|\[object Object\]/);
      assert.equal((html.match(/<button/g)??[]).length,2);
      const tag=renderToStaticMarkup(React.createElement(FormatTag,{id:'project-tag',tag:{format:'project',labelKey:'catalogue:format.project.label',regenerate:true,mentions:[{key:'catalogue:generation.modified.reason',params:{}}]}}));
      assert.match(tag,/catalogue-generation-dot/);
      assert.doesNotMatch(tag,/catalogue:|undefined/);
      const model=editWarningDialog({project:{path:'_PROJECT_'},message:{params:{date:1700000000000}}});
      assert.match(model.message,/_PROJECT_/);
      assert.match(model.message,/2023/,'catalogue dates are milliseconds, not seconds');
      assert.equal(model.cancelValue,null);
      assert.equal(model.actions[0].value,'project');
      assert.equal(model.actions[0].autoFocus,true);
      for(const action of model.actions) assert.doesNotMatch(action.label,/catalogue:|common:/);
    }
    assert.equal(renderToStaticMarkup(React.createElement(ResumeBanner,{recoveries:[]})),'');
  } finally {await server.close();}
});
