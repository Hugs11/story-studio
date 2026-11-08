import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { mountSurface } from './chromeBench.mjs';
const { AggregateDestinationChoice, AggregateGenerationReview } = await import('../src/components/AggregatePacks/AggregateDestinationChoice.jsx');
const { PackNameModal } = await import('../src/components/layout/PackNameModal.jsx');
const engine = createTestI18n();
await i18next.init({ ...engine.options, resources: engine.options.resources });

for (const language of ['fr','en','it']) {
  test(`${language}: destination offers two labelled exclusive keyboard radio controls`,async()=>{
    await i18next.changeLanguage(language);
    for(const destination of ['editor','generate']) {
      const html=mountSurface(React.createElement(AggregateDestinationChoice,{destination,onChoose(){}})).html;
      assert.match(html,/<fieldset/);
      assert.match(html,/<legend>[^<]+<\/legend>/);
      assert.equal((html.match(/type="radio"/g)||[]).length,2);
      assert.equal((html.match(/checked=""/g)||[]).length,1);
      const selected=html.match(/<input[^>]*checked=""[^>]*>/)[0];
      assert.ok(selected.includes(`value="${destination}"`));
      assert.doesNotMatch(html,/home:|catalogue:|\[object Object\]/);
      assert.ok(html.includes(i18next.t('home:aggregate.destination.editor')));
      assert.ok(html.includes(i18next.t('home:aggregate.destination.generate')));
    }
  });

  test(`${language}: generation confirmation displays folder, exact archive and ordered inputs`,async()=>{
    await i18next.changeLanguage(language);
    const html=mountSurface(React.createElement(AggregateGenerationReview,{folder:'/NAS/Été et histoires',fileName:'Soir.zip',files:['/NAS/Second.zip','/NAS/Premier.zip'],onConfirm(){},onCancel(){}})).html;
    assert.match(html,/aria-labelledby="aggregate-review-title"/);
    assert.match(html,/id="aggregate-review-title" tabindex="-1"/);
    assert.ok(html.includes('/NAS/Été et histoires'));
    assert.ok(html.includes('Soir.zip'));
    assert.ok(html.indexOf('/NAS/Second.zip')<html.indexOf('/NAS/Premier.zip'));
    assert.equal((html.match(/<button/g)||[]).length,2);
    assert.doesNotMatch(html,/home:|\[object Object\]/);
  });

  test(`${language}: embedded metadata offers the selected destination without a second generation action`,async()=>{
    await i18next.changeLanguage(language);
    const label=i18next.t('home:aggregate.destination.editor');
    const html=mountSurface(React.createElement(PackNameModal,{open:true,embedded:true,primaryActionLabel:label,packMetadata:{title:'Histoires',uuid:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',minAge:''},onClose(){},onSaveAndGenerate(){}})).html;
    assert.ok(html.includes(label));
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.doesNotMatch(html,/pack-meta-age-chip is-active[^>]*>3/);
    assert.doesNotMatch(html,/home:/);
  });
}
