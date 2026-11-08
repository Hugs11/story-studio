import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { mountSurface } from './chromeBench.mjs';
const { AssemblyPreparationDialog } = await import('../src/components/Catalogue/assembly/AssemblyPreparationDialog.jsx');
const { AssemblyExcludedList } = await import('../src/components/Catalogue/assembly/AssemblyExcludedList.jsx');
test('preparation and exclusions render translated accessible surfaces',async()=>{
 const engine=createTestI18n();await i18next.init({...engine.options,resources:engine.options.resources});
 for(const language of ['fr','en','it']) {
  await i18next.changeLanguage(language);
  const html=mountSurface(React.createElement(AssemblyPreparationDialog,{state:{phase:'preparing',progress:{candidates:{processed:2,total:5}}},onClose(){}})).html;
  assert.ok(html.includes(i18next.t('catalogue:assembly.progress', {processed:2,total:5})));assert.match(html,/aria-atomic="true"/);assert.match(html,/<dialog/);assert.match(html,/role="status"/);assert.doesNotMatch(html,/catalogue:|\[object Object\]/);
  const excluded=mountSurface(React.createElement(AssemblyExcludedList,{entries:[{ficheId:'project',reason:'generateFirst'},{ficheId:'gone',reason:'unavailable'}]})).html;
  assert.match(excluded,/project/);assert.doesNotMatch(excluded,/catalogue:/);
 }
});

test('assembly metadata leaves unknown age empty and keeps zero', async () => {
 const { PackNameModal } = await import('../src/components/layout/PackNameModal.jsx');
 for (const minAge of ['', '0', '9']) {
  const html = mountSurface(React.createElement(PackNameModal, { open:true, embedded:true,  packMetadata:{title:'Aggregate',minAge}, onClose(){} })).html;
  assert.doesNotMatch(html,/pack-meta-age-chip is-active[^>]*>3</);
  if (minAge === '9') assert.match(html,/class="pack-meta-age-chip is-active" aria-pressed="true">9\+</);
  else {
   const input = html.match(/<input[^>]*class="pack-meta-input pack-meta-age-other"[^>]*>/)?.[0];
   assert.ok(input);
   assert.ok(input.includes(`value="${minAge}"`));
  }
 }
});
