import { catalogueViewFixture } from './catalogueFixtures.mjs';
import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import i18next from 'i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { initialFilterState, filterStateReducer, filterSummary } from '../src/store/catalogue/filterState.js';
const { CatalogueActivity } = await import('../src/components/Catalogue/activity/CatalogueActivity.jsx');
const { ActiveFilterSummary } = await import('../src/components/Catalogue/CatalogueFilterBar.jsx');
const { CatalogueToolbar } = await import('../src/components/Catalogue/CatalogueToolbar.jsx');

test('FR/EN/IT single and multiple notifications use the generic label and visible count', async () => {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const label = i18next.t('catalogue:sources.add.label');
    const single = mountSurface(React.createElement(CatalogueActivity, { browserNotice: { key: 'catalogue:sources.add.label' } }));
    const button = single.elements.find(element => element.type === 'button' && element.props['data-toolbar-id'] === 'catalogueActivity');
    assert.equal(button.props['aria-label'], i18next.t('catalogue:header.activity', { count: 1 }));
    assert.match(single.html, /validation-pill-count">1</);
    assert.ok(single.html.includes(i18next.t('catalogue:activity.pill.info')));
    assert.ok(single.elements.some(element => element.props?.label === label), 'the detailed notification remains available to the popover');
    assert.doesNotMatch(single.html, /has-entry-label/);
    const multiple = mountSurface(React.createElement(CatalogueActivity, { browserNotice: { key: 'catalogue:sources.add.label' }, sourceNotice: { key: 'catalogue:sources.add.label' } }));
    assert.match(multiple.html, /validation-pill-count">2</);
    assert.doesNotMatch(multiple.html, /has-entry-label/);
    assert.doesNotMatch(single.html + multiple.html, /catalogue:|\[object Object\]/);
  }
});

test('missing files chip is translated, counted in Filters and removes its criterion', async () => {
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    const state = filterStateReducer(initialFilterState(), { type: 'showMissing' });
    const actions = [];
    const view = { ...catalogueViewFixture(), ...state, summary: filterSummary(state), dispatch: action => actions.push(action), sort: { key: 'title', direction: 'asc' } };
    const surface = mountSurface(React.createElement(ActiveFilterSummary, { view, cards: [] }));
    assert.ok(surface.html.includes(i18next.t('catalogue:filter.missingFiles.label')));
    const chip = surface.elements.find(element => element.type === 'button' && element.props['aria-label']);
    chip.props.onClick();
    assert.deepEqual(actions, [{ type: 'remove', family: 'missingFilesOnly', key: 'catalogue:filter.missingFiles.label' }]);
    const toolbar = mountSurface(React.createElement(CatalogueToolbar, { view, searchRef: { current: null } }));
    assert.match(toolbar.html, /catalogue-filter-chip/);
    assert.doesNotMatch(toolbar.html, /catalogue-filter-count/);
  }
});

test('le balai n’apparaît qu’à partir de deux entrées effaçables et les efface toutes pour la session', async () => {
  const { StatusPill } = await import('../src/components/layout/StatusPill.jsx');
  const { activityDismissals } = await import('../src/store/catalogue/activityModel.js');
  const headerAction = (props) => mountSurface(React.createElement(CatalogueActivity, props))
    .elements.find(element => element.type === StatusPill).props.headerAction;
  const sourceNotice = { key: 'catalogue:sources.add.label' };
  assert.equal(headerAction({ sourceNotice }), null, 'une seule entrée : la croix suffit');
  assert.equal(headerAction({ sourceNotice, browserNotice: { key: 'catalogue:sources.add.label' } }), null,
    'une entrée sans croix ne compte pas');
  let dismissed = 0;
  const broom = headerAction({ sourceNotice, browserNotice: { key: 'catalogue:sources.add.label' }, onDismissBrowserNotice: () => { dismissed += 1; } });
  assert.ok(broom, 'deux entrées effaçables : balai présent');
  assert.equal(broom.props.text, i18next.t('catalogue:activity.dismissAll'));
  broom.props.children.props.onClick();
  assert.equal(dismissed, 1, 'l’entrée à rappel est effacée par son rappel');
  assert.ok(activityDismissals.snapshot().has(`sources:${JSON.stringify(sourceNotice)}`), 'l’entrée à signature est masquée pour la session');
});

test('pendant un envoi vers la Lunii, l’activité reste dépliée : ni la sortie du survol ni un clic ailleurs ne la referment', async () => {
  const { StatusPill } = await import('../src/components/layout/StatusPill.jsx');
  const pill = (props) => mountSurface(React.createElement(CatalogueActivity, props)).elements.find(element => element.type === StatusPill);
  // Not the balai test's notice: that one stays hidden for the session.
  const sourceNotice = { key: 'catalogue:sources.add.label', params: { case: 'keepOpen' } };
  assert.equal(pill({ sourceNotice }).props.keepOpen, false, 'sans envoi en cours, la fermeture habituelle');
  assert.equal(pill({ sourceNotice, running: [{ operationId: 'op', operationKind: 'luniiSend', status: 'running' }] }).props.keepOpen, true);
  assert.equal(pill({ sourceNotice, running: [{ operationId: 'op', operationKind: 'scan', status: 'running' }] }).props.keepOpen, false, 'une analyse ne retient pas la pastille');
  for (const keepOpen of [true, false]) {
    const changes = [];
    const wrap = mountSurface(React.createElement(StatusPill, { state: 'progress', open: true, onOpenChange: value => changes.push(value), keepOpen, tooltip: 'Activité', label: 'Activité', title: 'Activité' }, null))
      .elements.find(element => element.type === 'div' && String(element.props.className).includes('validation-pill-wrap'));
    wrap.props.onPointerLeave();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(changes, keepOpen ? [] : [false]);
  }
});
