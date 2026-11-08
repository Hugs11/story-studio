import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';

// These draft tests assert French labels and decimal input, independent of the system language.
const french = createTestI18n();
i18next.init({ ...french.options, lng: 'fr', initAsync: false });

register('./nodeSourceResolver.mjs', import.meta.url);
const doubles = new Map([
  // Le test porte sur les brouillons et commandes, le rendu Trans est couvert par i18nHomeSurface.
  ['react-i18next', 'export function Trans() { return null; }'],
  ['../common/UserMessage.jsx', 'export function TechnicalDetail() { return null; }'],
  ['@tauri-apps/api/core', 'export async function invoke() { return null; }'],
  ['@tauri-apps/plugin-fs', 'export async function exists() { return false; }'],
  ['../icons/LucideLocal', 'export const CircleCheck = () => null; export const Image = () => null; export const Package = () => null; export const Pencil = () => null; export const RotateCcw = () => null; export const TriangleAlert = () => null;'],
  ['../common/Tooltip', 'export function Tooltip() { return null; }'],
  ['../common/Button', 'export function Button() { return null; }'],
  ['../editors/ImageField', 'export function ImageField() { return null; }'],
  ['../../hooks/useEscapeKey', 'export function useEscapeKey() {}'],
  ['../../hooks/useLocalFile', 'export function useLocalFile() { return null; }'],
  ['../common/Toggle', 'export function Toggle() { return null; }'],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (doubles.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(doubles.get(specifier))}`, shortCircuit: true };
    }
    if (specifier === 'react/jsx-runtime') {
      return { url: `data:text/javascript,${encodeURIComponent('export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx; export const Fragment = Symbol.for("react.fragment");')}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      return { format: 'module', shortCircuit: true, source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code };
    }
    return next(url, context);
  },
});

const { PackNameModal } = await import('../src/components/layout/PackNameModal.jsx');
const { PackAudioProcessingFields } = await import('../src/components/layout/PackAudioProcessingFields.jsx');

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

function control(node, label) {
  return elements(node).find((entry) => entry.props.children === label);
}

function audio(node) {
  return elements(node).find((entry) => entry.type === PackAudioProcessingFields);
}

test('la fiche propose deux modes et un interrupteur, avec la durée courante', (t) => {
  for (const mode of ['normalize', 'add', 'off']) {
    const updates = [];
    const hook = runner(() => PackAudioProcessingFields({
      values: { harmonizeLoudness: true, silenceMode: mode, leadingSilenceSec: null, trailingSilenceSec: null },
      onChange: (...args) => updates.push(args),
    }));
    t.after(() => hook.unmount());
    const node = hook.render();
    const segments = elements(node).filter((entry) => entry.props.className?.split(' ').includes('pack-meta-audio-segment'));
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((entry) => entry.props['aria-pressed']),
      ['normalize', 'add'].map((candidate) => candidate === (mode === 'off' ? 'normalize' : mode)));
    assert.equal(elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration').props.children, '0,4 s');
    const toggle = elements(node).find((entry) => entry.props.ariaLabel === 'Activer le traitement des silences de début et de fin');
    assert.equal(toggle.props.on, mode !== 'off');
    const content = elements(node).find((entry) => entry.type === 'fieldset');
    assert.equal(content.props.disabled, mode === 'off');
    assert.equal(content.props.inert, mode === 'off');
    if (mode === 'off') toggle.props.onChange(true);
    segments[1].props.onClick();
    assert.deepEqual(updates, mode === 'off'
      ? [['silenceMode', 'normalize'], ['silenceMode', 'add']]
      : [['silenceMode', 'add']]);
  }
});

test('éteindre puis rallumer restaure le dernier mode de la session', (t) => {
  const values = { silenceMode: 'normalize', harmonizeLoudness: true };
  const hook = runner(() => PackAudioProcessingFields({
    values, onChange: (field, value) => { values[field] = value; },
  }));
  t.after(() => hook.unmount());
  const toggle = () => elements(hook.render()).find((entry) => entry.props.ariaLabel === 'Activer le traitement des silences de début et de fin');
  elements(hook.render()).find((entry) => entry.props['aria-label']?.startsWith('Ajouter')).props.onClick();
  assert.equal(values.silenceMode, 'add');
  toggle().props.onChange(false);
  assert.equal(values.silenceMode, 'off');
  toggle().props.onChange(true);
  assert.equal(values.silenceMode, 'add');
});

test('le stylo ouvre deux saisies et la remise par défaut efface les deux personnalisations', (t) => {
  const updates = [];
  const values = { harmonizeLoudness: true, silenceMode: 'normalize', leadingSilenceSec: null, trailingSilenceSec: null };
  const hook = runner(() => PackAudioProcessingFields({ values, onChange: (...args) => updates.push(args) }));
  t.after(() => hook.unmount());
  let node = hook.render();
  assert.equal(elements(node).filter((entry) => entry.type === 'input').length, 0);
  elements(node).find((entry) => entry.props['aria-label'] === 'Modifier les durées du pack').props.onClick();
  node = hook.render();
  const inputs = elements(node).filter((entry) => entry.type === 'input');
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((entry) => entry.props.value), ['0,4', '0,4']);
  inputs[0].props.onChange({ target: { value: '0,8' } });
  assert.deepEqual(updates, [['leadingSilenceSec', '0,8']]);

  values.leadingSilenceSec = '0,8';
  values.trailingSilenceSec = '0';
  node = hook.render();
  assert.equal(elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration-scope').props.children, 'Personnalisé');
  control(node, 'Reprendre les valeurs par défaut').props.onClick();
  assert.deepEqual(updates.slice(-2), [['leadingSilenceSec', null], ['trailingSilenceSec', null]]);
});

function setup({ graph = false, globalOptions = graph ? undefined : {} } = {}) {
  const saved = [];
  const closed = [];
  const project = { rootEntries: [], ...(globalOptions === undefined ? {} : { globalOptions }) };
  const props = {
    open: true,
    project,
    packMetadata: { title: 'Un pack', uuid: '123e4567-e89b-42d3-a456-426614174000' },
    advanced: graph ? {
      draft: { title: 'Un pack', uuid: '123e4567-e89b-42d3-a456-426614174000' },
      governance: { version: { editable: true }, uuid: { editable: true } },
    } : null,
    onSave: async (payload) => { saved.push(payload); },
    onClose: () => closed.push(true),
  };
  const hook = runner(() => PackNameModal(props));
  return { hook, project, props, saved, closed };
}

for (const graph of [false, true]) {
  test(`${graph ? 'graphe' : 'menus'} : brouillon audio, Annuler et Appliquer suivent le même contrat`, async (t) => {
    // Un graphe importé peut ne porter aucun `globalOptions`. La fiche doit
    // quand même proposer les défauts audio et les écrire à Appliquer.
    const state = setup({ graph });
    const sourceOptions = graph ? undefined : {};
    t.after(() => state.hook.unmount());
    let node = state.hook.render();
    state.hook.flush();
    node = state.hook.render();
    assert.deepEqual(audio(node).props.values, { harmonizeLoudness: true, silenceMode: 'normalize', leadingSilenceSec: null, trailingSilenceSec: null });

    audio(node).props.onChange('harmonizeLoudness', false);
    audio(node).props.onChange('silenceMode', 'add');
    audio(node).props.onChange('leadingSilenceSec', '0,8');
    audio(node).props.onChange('trailingSilenceSec', '0');
    node = state.hook.render();
    assert.deepEqual(audio(node).props.values, { harmonizeLoudness: false, silenceMode: 'add', leadingSilenceSec: '0,8', trailingSilenceSec: '0' });
    assert.deepEqual(state.project.globalOptions, sourceOptions, 'le projet reste intact avant Appliquer');

    control(node, 'Annuler').props.onClick();
    assert.equal(state.closed.length, 1);
    assert.deepEqual(state.saved, []);
    assert.deepEqual(state.project.globalOptions, sourceOptions);

    state.props.open = false;
    state.hook.render();
    state.hook.flush();
    state.props.open = true;
    state.hook.render();
    state.hook.flush();
    node = state.hook.render();
    assert.deepEqual(audio(node).props.values, { harmonizeLoudness: true, silenceMode: 'normalize', leadingSilenceSec: null, trailingSilenceSec: null }, 'rouvrir reprend les valeurs du projet');

    audio(node).props.onChange('harmonizeLoudness', false);
    audio(node).props.onChange('silenceMode', 'off');
    audio(node).props.onChange('leadingSilenceSec', '0,8');
    audio(node).props.onChange('trailingSilenceSec', '0');
    node = state.hook.render();
    await control(node, 'Appliquer').props.onClick();
    assert.equal(state.saved.length, 1);
    assert.equal(state.saved[0].harmonizeLoudness, false);
    assert.equal(state.saved[0].silenceMode, 'off');
    assert.equal(state.saved[0].leadingSilenceSec, 0.8);
    assert.equal(state.saved[0].trailingSilenceSec, 0);
  });
}

test('une durée invalide empêche Appliquer et générer, puis la remise par défaut annule les personnalisations', async (t) => {
  const state = setup({ globalOptions: { leadingSilenceSec: 0.8, trailingSilenceSec: 1.25 } });
  t.after(() => state.hook.unmount());
  state.hook.render();
  state.hook.flush();
  let node = state.hook.render();
  assert.equal(audio(node).props.values.leadingSilenceSec, 0.8);
  audio(node).props.onChange('leadingSilenceSec', '-1');
  node = state.hook.render();
  assert.equal(control(node, 'Appliquer').props.disabled, true);
  assert.equal(control(node, 'Appliquer & générer').props.disabled, true);
  await control(node, 'Appliquer').props.onClick();
  await control(node, 'Appliquer & générer').props.onClick();
  assert.deepEqual(state.saved, []);

  audio(node).props.onChange('leadingSilenceSec', null);
  audio(node).props.onChange('trailingSilenceSec', null);
  node = state.hook.render();
  assert.equal(control(node, 'Appliquer').props.disabled, false);
  await control(node, 'Appliquer').props.onClick();
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].leadingSilenceSec, null);
  assert.equal(state.saved[0].trailingSilenceSec, null);
  assert.deepEqual(state.project.globalOptions, { leadingSilenceSec: 0.8, trailingSilenceSec: 1.25 });
});

test('le stylo désigne le groupe des durées qu’il ouvre', (t) => {
  const values = { harmonizeLoudness: true, silenceMode: 'normalize', leadingSilenceSec: null, trailingSilenceSec: null };
  const hook = runner(() => PackAudioProcessingFields({ values, onChange: () => {} }));
  t.after(() => hook.unmount());
  let node = hook.render();
  const pen = () => elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration-edit');
  const group = () => elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration-editor');
  // Fermé, le groupe existe déjà, masqué : la cible d'`aria-controls` ne
  // disparaît jamais.
  assert.equal(pen().props['aria-expanded'], false);
  assert.ok(pen().props['aria-controls']);
  assert.equal(pen().props['aria-controls'], group().props.id);
  assert.equal(group().props.hidden, true);
  const idBefore = group().props.id;
  pen().props.onClick();
  node = hook.render();
  assert.equal(pen().props['aria-expanded'], true);
  assert.equal(group().props.hidden, false);
  assert.equal(group().props.id, idBefore, 'l’identifiant reste stable d’un rendu à l’autre');
});

test('un champ vidé reprend la préférence ; au-delà de 10 s, la saisie est refusée', async (t) => {
  // Le composant seul : vider n'affiche aucune erreur, le champ montre la
  // préférence en filigrane et la fiche reste « Par défaut ».
  const values = { harmonizeLoudness: true, silenceMode: 'normalize', leadingSilenceSec: '', trailingSilenceSec: '12' };
  const hook = runner(() => PackAudioProcessingFields({ values, onChange: () => {} }));
  t.after(() => hook.unmount());
  let node = hook.render();
  elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration-edit').props.onClick();
  node = hook.render();
  const [leadingInput, trailingInput] = elements(node).filter((entry) => entry.type === 'input');
  assert.equal(leadingInput.props.value, '');
  assert.equal(leadingInput.props.placeholder, '0,4');
  assert.equal(leadingInput.props['aria-invalid'], undefined);
  assert.equal(trailingInput.props['aria-invalid'], true);
  const errors = elements(node).filter((entry) => entry.props.className === 'pack-meta-audio-duration-error');
  assert.deepEqual(errors.map((entry) => entry.props.children), ['Saisis une durée de 0 à 10 s, ou laisse vide.']);
  assert.match(trailingInput.props['aria-describedby'], new RegExp(errors[0].props.id));
  const note = elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration-note');
  assert.match(note.props.children, /champ vide reprend la valeur des Préférences/);
  assert.match(leadingInput.props['aria-describedby'], new RegExp(note.props.id));
  values.trailingSilenceSec = '';
  node = hook.render();
  assert.equal(elements(node).find((entry) => entry.props.className === 'pack-meta-audio-duration-scope').props.children, 'Par défaut');

  // La fiche entière : 12 s bloque Appliquer, vider le champ le débloque et
  // envoie `null`, c'est-à-dire « reprendre la préférence ».
  const state = setup({ globalOptions: { leadingSilenceSec: 0.8, trailingSilenceSec: 1.25 } });
  t.after(() => state.hook.unmount());
  state.hook.render();
  state.hook.flush();
  let modal = state.hook.render();
  audio(modal).props.onChange('trailingSilenceSec', '12');
  modal = state.hook.render();
  assert.equal(control(modal, 'Appliquer').props.disabled, true);
  assert.equal(control(modal, 'Appliquer & générer').props.disabled, true);
  audio(modal).props.onChange('leadingSilenceSec', '');
  audio(modal).props.onChange('trailingSilenceSec', '10');
  modal = state.hook.render();
  assert.equal(control(modal, 'Appliquer').props.disabled, false);
  await control(modal, 'Appliquer').props.onClick();
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].leadingSilenceSec, null);
  assert.equal(state.saved[0].trailingSilenceSec, 10);
});

test('fiche déjà ouverte : FR → EN → IT actualise les libellés sans modifier le brouillon auteur', async (t) => {
  const { default: i18next } = await import('i18next');
  const { createTestI18n } = await import('./i18nTestSetup.mjs');
  i18next.init({ lng: 'fr', resources: createTestI18n().options.resources, initAsync: false, keySeparator: false, interpolation: { escapeValue: false } });
  const state = setup();
  t.after(() => { state.hook.unmount(); i18next.changeLanguage('fr'); });
  state.hook.render(); state.hook.flush();
  const source = JSON.stringify(state.props);
  for (const [language, apply, placeholder] of [['fr', 'Appliquer', 'Titre de mon pack'], ['en', 'Apply', 'My audiobook title'], ['it', 'Applica', 'Titolo del mio audiolibro']]) {
    await i18next.changeLanguage(language);
    const node = state.hook.render();
    assert.ok(control(node, apply));
    const title = elements(node).find((entry) => entry.props.placeholder === placeholder);
    assert.equal(title.props.value, 'Un pack');
    assert.equal(JSON.stringify(state.props), source);
    assert.deepEqual(state.saved, []);
  }
});

test('assembly with unknown age survives editor metadata confirmation and final export', async () => {
  const { buildAggregateProject, defaultMetadataForPacks } = await import('../src/components/AggregatePacks/aggregateProject.js');
  const { projectToRustExport, normalizeProjectData } = await import('../src/store/projectModel.js');
  const { generateConventionName } = await import('../src/utils/packConvention.js');
  const metadata=defaultMetadataForPacks([{name:'Sans âge',path:'/pack.zip',ageMin:null}], '123e4567-e89b-42d3-a456-426614174000');
  let project=buildAggregateProject({packs:[{name:'Sans âge',path:'/pack.zip'}],rootAudio:'/menu.mp3',rootImage:'/menu.png',metadata});
  assert.equal(project.packMetadata.minAge,'');
  let generated;
  const hook=runner(() => PackNameModal({open:true,project,packMetadata:project.packMetadata,onClose(){},onSaveAndGenerate:async payload => {generated=payload;}}));
  hook.render();hook.flush();
  await control(hook.render(),'Appliquer & générer').props.onClick();
  assert.equal(generated.minAge,'');
  project=normalizeProjectData({...project,packMetadata:generated});
  assert.equal(projectToRustExport(project).packMetadata.minAge,'');
  assert.doesNotMatch(generateConventionName(project.packMetadata),/^3\+\]/);
  assert.doesNotMatch(projectToRustExport(project).name,/^3\+\]/);
  hook.unmount();
});


for (const graph of [false, true]) {
  test(`${graph ? 'graphe' : 'menus'} : la puce active revient à un âge vide, conservé à la validation`, async (t) => {
    const state = setup({ graph });
    state.props.packMetadata.minAge = '6';
    t.after(() => state.hook.unmount());
    state.hook.render(); state.hook.flush();
    const chip = () => elements(state.hook.render()).find(entry => entry.type === 'button' && entry.props.children?.[0] === '6');
    assert.equal(chip().props['aria-pressed'], true);
    chip().props.onClick();
    assert.equal(chip().props['aria-pressed'], false);
    await control(state.hook.render(), 'Appliquer').props.onClick();
    assert.equal((graph ? state.saved[0].naming : state.saved[0]).minAge, '');
    chip().props.onClick();
    assert.equal(chip().props['aria-pressed'], true);
  });
}

test('fiche menus : titre proposé depuis la racine, Annuler ne modifie pas le projet', async (t) => {
  const state = setup();
  state.project.rootName = 'La forêt';
  state.props.packMetadata.title = '';
  t.after(() => state.hook.unmount());
  state.hook.render(); state.hook.flush();
  const title = elements(state.hook.render()).find(entry => entry.type === 'input' && entry.props.placeholder === i18next.t('home:packName.title.placeholder'));
  assert.equal(title.props.value, 'La forêt');
  control(state.hook.render(), 'Annuler').props.onClick();
  assert.equal(state.props.packMetadata.title, '');
  assert.equal(state.saved.length, 0);
});

test('fiche graphe : la proposition reste dans le brouillon jusqu’à Appliquer', async (t) => {
  const { advancedPackMetadataDraft } = await import('../src/store/packMetadataModel.js');
  const view = { metadata: {}, entryTitle: 'La forêt' };
  const state = setup({ graph: true });
  state.props.advanced.draft = advancedPackMetadataDraft(view);
  t.after(() => state.hook.unmount());
  state.hook.render(); state.hook.flush();
  const title = elements(state.hook.render()).find(entry => entry.type === 'input' && entry.props.placeholder === i18next.t('home:packName.title.placeholder'));
  assert.equal(title.props.value, 'La forêt');
  control(state.hook.render(), 'Annuler').props.onClick();
  assert.deepEqual(view.metadata, {});
  assert.equal(state.saved.length, 0);
  await control(state.hook.render(), 'Appliquer').props.onClick();
  assert.equal(state.saved[0].title, 'La forêt');
});
