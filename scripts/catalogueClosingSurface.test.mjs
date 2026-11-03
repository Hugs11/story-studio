import { catalogueViewFixture } from './catalogueFixtures.mjs';
import './chromeBench.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
i18next.use(initReactI18next);
import { initialFilterState, filterSummary } from '../src/store/catalogue/filterState.js';
import { card } from './catalogueFixtures.mjs';
const { CatalogueFilterBar, ActiveFilterSummary } = await import('../src/components/Catalogue/CatalogueFilterBar.jsx');
const { CatalogueEmptyState } = await import('../src/components/Catalogue/CatalogueEmptyState.jsx');
const { CoverImage } = await import('../src/components/Catalogue/views/CoverImage.jsx');
const { CatalogueToolbar } = await import('../src/components/Catalogue/CatalogueToolbar.jsx');
const { ListView } = await import('../src/components/Catalogue/views/ListView.jsx');
const noop = () => {};
test('FR/EN/IT age presets are translated and apply without closing',async()=>{
  const engine=createTestI18n();
  await i18next.init({...engine.options, resources:engine.options.resources});
  for(const language of ['fr','en','it']) {
    await i18next.changeLanguage(language);
    const state=initialFilterState();state.filters.age={min:3,max:3,hideUnknown:false};
    const actions=[]; let closed=0;
    const surface=mountSurface(React.createElement(CatalogueFilterBar,{family:'age',onClose:()=>{closed++;},cards:[card({language:'fr'})],view:{...state,summary:filterSummary(state),dispatch:action=>actions.push(action)}}));
    assert.doesNotMatch(surface.html, /catalogue-age-apply|catalogue:|\[object Object\]/);
    assert.equal(surface.elements.filter(element => element.type === 'input' && element.props.type === 'number').length, 2);
    assert.ok(surface.html.includes(engine.t('catalogue:age.precise', { lng: language })));
    const presets = surface.elements.filter(element => element.type === 'button' && typeof element.props['aria-pressed'] === 'boolean');
    assert.equal(presets.length, 6);
    presets[3].props.onClick();
    assert.equal(closed, 0);
    assert.deepEqual(actions[0], { type: 'set', family: 'age', value: { min: null, max: 5, hideUnknown: false } });
    for(const context of [{},{sources:[{status:'active'}],scanning:true},{sources:[{status:'active'}]},{sources:[{status:'active'}],filtered:true},{sources:[{status:'active',availability:'unavailable'}]}]) {
      const empty=mountSurface(React.createElement(CatalogueEmptyState,{...context,onAddFolder:noop,onPreferences:noop,onRefresh:noop,onClearFilters:noop}));
      assert.match(empty.html,/data-empty-state=/);assert.doesNotMatch(empty.html,/catalogue:/);
    }
    assert.doesNotMatch(mountSurface(React.createElement(CoverImage,{})).html,/<img/);
  }
});
test('toolbar commands remain directly accessible without a disclosure',()=>{
  const surface=mountSurface(React.createElement(CatalogueToolbar,{view:{ ...catalogueViewFixture(),summary:[],query:'',sort:{key:'title',direction:'asc'},view:'cards'},counts:{fiches:0,exemplaires:0},searchRef:{current:null}}));
  assert.doesNotMatch(surface.html, /<details|<summary/);
  assert.match(surface.html, /role="group"/);
  assert.match(surface.html, /id="catalogue-search"/);
});
test('search clearing and reset filters have distinct wired buttons',()=>{
  const actions=[];
  const state=initialFilterState();state.query='Ours';
  state.filters.favoritesOnly=true;
  const filters=mountSurface(React.createElement(ActiveFilterSummary,{cards:[],view:{...state,summary:filterSummary(state),dispatch:action=>actions.push(action)}}));
  filters.elements.filter(element=>element.type==='button').at(-1).props.onClick();assert.equal(actions[0].type,'reset');
  const toolbar=mountSurface(React.createElement(CatalogueToolbar,{view:{ ...catalogueViewFixture(),summary:[],query:'Ours',sort:{key:'title',direction:'asc'},view:'cards',setQuery:value=>actions.push(value)},counts:{fiches:0,exemplaires:0},searchRef:{current:null}}));
  toolbar.elements.find(element=>element.type==='button').props.onClick();assert.equal(actions[1],'');
});

test('FR/EN/IT removal buttons include short source folder names and translated format values',async()=>{
  const engine=createTestI18n();
  await i18next.init({...engine.options,resources:engine.options.resources});
  for(const language of ['fr','en','it']) {
    await i18next.changeLanguage(language);
    const state=initialFilterState();
    state.filters.sourceIds=['A','B'];state.filters.formats=['project','zip'];
    const surface=mountSurface(React.createElement(ActiveFilterSummary,{cards:[],sources:[{id:'A',status:'active',path:'/Histoires/Ours'},{id:'B',status:'active',path:'/Histoires/Chats'}],view:{...state,summary:filterSummary(state),dispatch:noop}}));
    const buttons=surface.elements.filter(element=>element.type==='button'&&element.props['aria-label']);
    const source=buttons.find(button=>button.props['aria-label'].includes('Ours'));
    assert.ok(source);assert.ok(source.props['aria-label'].includes('Chats'));assert.ok(!source.props['aria-label'].includes('/Histoires'));
    const format=buttons.find(button=>button.props['aria-label'].includes('ZIP'));
    assert.ok(format);assert.ok(format.props['aria-label'].includes(engine.t('catalogue:format.project.label', { lng: language })));
    assert.doesNotMatch(surface.html,/catalogue:|\[object Object\]/);
  }
});

test('List exposes the owning card for focus inside a different expanded card',()=>{
  const items=[{card:card({id:'active',title:'A'}),exemplars:[]},{card:card({id:'focused',title:'B',exemplars:[{id:'copy',path:'/B.zip'}]}),exemplars:[]}];
  for(const item of items){item.exemplars=item.card.exemplars;item.representative=item.exemplars[0];}
  const view={activeId:'active',selected:new Set(),expanded:new Set(['focused']),menu:{open:false},setActiveId:noop,onItemClick:noop,onOpenModal:noop,onItemKeyDown:noop,onCardMenu:noop,onFormatClick:noop,onExemplarMenu:noop,onToggleExpanded:noop};
  for(const View of [ListView]){
    const surface=mountSurface(React.createElement(View,{items,view}));
    const expanded=surface.elements.find(element=>element.type==='tr'&&element.props['data-focus-card-id']==='focused');
    assert.ok(expanded);
    assert.equal(view.activeId,'active');
  }
});

test('active chips edit on label, remove on cross, clear all independently of search text', () => {
  const state=initialFilterState(); state.query='Lune';
  state.filters.age={min:null,max:5,hideUnknown:false}; state.filters.favoritesOnly=true;
  const edits=[]; const actions=[];
  const surface=mountSurface(React.createElement(ActiveFilterSummary,{cards:[],view:{...state,summary:filterSummary(state),dispatch:action=>actions.push(action)},onEdit:family=>edits.push(family)}));
  const labels=surface.elements.filter(element=>element.type==='button'&&element.props.className==='catalogue-filter-chip-label');
  labels[0].props.onClick({currentTarget:{}}); assert.deepEqual(edits,['favoritesOnly']); assert.equal(labels.length, 1); assert.equal(actions.length,0);
  const crosses=surface.elements.filter(element=>element.type==='button'&&element.props['aria-label']);
  crosses[0].props.onClick(); assert.deepEqual(actions[0],{type:'remove',family:'favoritesOnly',key:'catalogue:filter.favorites.only'});
  surface.elements.filter(element=>element.type==='button').at(-1).props.onClick(); assert.deepEqual(actions[1],{type:'reset'});
  assert.equal(state.query,'Lune');
});

test('PF-N1 search hints follow platform and customized shortcuts; age removal names the current range', async () => {
  const { getCurrentShortcuts, setCurrentShortcuts, getShortcutLabelMap } = await import('../src/store/keyboardShortcuts.js');
  const previous = getCurrentShortcuts();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  try {
    for (const platform of ['Linux', 'MacIntel']) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } });
      for (const customized of [false, true]) {
        const shortcuts = { ...previous, ...(customized ? { catalogueSearch: { ctrl: true, shift: true, key: 'k', code: 'KeyK' } } : {}) };
        setCurrentShortcuts(shortcuts);
        const state = initialFilterState();
        state.filters.age = { min: 3, max: 7, hideUnknown: false };
        const surface = mountSurface(React.createElement(CatalogueToolbar, { view: { ...catalogueViewFixture(), ...state, sort: { key: 'title', direction: 'asc' }, summary: filterSummary(state) }, searchRef: { current: null } }));
        const input = surface.elements.find(element => element.props?.id === 'catalogue-search');
        assert.equal(input.props['aria-keyshortcuts'], `${platform === 'MacIntel' ? 'Meta' : 'Control'}+${customized ? 'Shift+K' : 'F'}`);
        const hint = surface.elements.find(element => element.type === 'kbd');
        assert.equal(hint.props['aria-hidden'], 'true');
        assert.equal(hint.props.children, getShortcutLabelMap(shortcuts).catalogueSearch);
        const remove = surface.elements.find(element => element.type === 'button' && element.props['aria-label']?.includes('3'));
        assert.equal(remove.props['aria-label'], engine.t('catalogue:filter.remove.label', { filter: 'Âge : 3 à 7 ans' }));
      }
    }
  } finally {
    setCurrentShortcuts(previous);
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test('PF-N1 precise age sentence keeps two inputs and singular/plural in FR/EN/IT', async () => {
  const engine = createTestI18n();
  await i18next.init({ ...engine.options, resources: engine.options.resources });
  for (const language of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(language);
    for (const max of [1, 2]) {
      const state = initialFilterState();
      state.filters.age = { min: 0, max, hideUnknown: false };
      const surface = mountSurface(React.createElement(CatalogueFilterBar, { family: 'age', view: state }));
      const sentence = surface.html.match(/<div class="catalogue-age-range">(.*?)<\/div>/)[1];
      assert.equal((sentence.match(/<input/g) ?? []).length, 2);
      assert.equal(sentence.replace(/<[^>]*>/g, ''), engine.t('catalogue:age.preciseRange', { count: max, lng: language }).replace(/<[^>]*>/g, ''));
    }
  }
});
