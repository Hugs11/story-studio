import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { mountSurface } from './chromeBench.mjs';
const { PackNameModal } = await import('../src/components/layout/PackNameModal.jsx');
const engine = createTestI18n();
await i18next.init({ ...engine.options, resources: engine.options.resources });

for (const language of ['fr','en','it']) {
  test(`${language}: embedded metadata offers generation without an Apply button`,async()=>{
    await i18next.changeLanguage(language);
    const label=i18next.t('home:aggregate.generation.action');
    const html=mountSurface(React.createElement(PackNameModal,{open:true,embedded:true,primaryActionLabel:label,project:{rootEntries:[{type:'zip',zipPath:'/a.zip'},{type:'zip',zipPath:'/b.zip'}]},packMetadata:{title:'Histoires',uuid:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',minAge:''},onClose(){},onSaveAndGenerate(){}})).html;
    assert.ok(html.includes(label));
    assert.ok(!html.includes('>'+i18next.t('home:packName.save.apply')+'<'));
    const standalone=mountSurface(React.createElement(PackNameModal,{open:true,onClose(){},onSave(){}})).html;
    assert.ok(standalone.includes('>'+i18next.t('home:packName.save.apply')+'<'));
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.doesNotMatch(html,/pack-meta-age-chip is-active[^>]*>3/);
    assert.doesNotMatch(html,/home:/);
    assert.doesNotMatch(html,/pack-meta-close|pack-meta-status/);
    assert.ok(html.includes(i18next.t('home:aggregate.count.packs', {count:2})));
    assert.ok(html.includes('>'+i18next.t('home:funnel.footer.back')+'<'));
    assert.ok(!html.includes('>'+i18next.t('common:dialog.cancel.label')+'<'));
    assert.match(standalone,/pack-meta-close/);
    assert.match(standalone,/pack-meta-status/);
    assert.ok(standalone.includes('>'+i18next.t('common:dialog.cancel.label')+'<'));
  });
}
