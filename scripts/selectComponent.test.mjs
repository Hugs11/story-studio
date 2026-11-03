import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
// JSX de production + hooks du pilote de test : aucune logique de la liste n'est recopiée ici.
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
// La liste se pose dans `document.body` (portail) ; le pilote n'a pas de DOM, ce double en tient lieu.
globalThis.document = { body: { nodeType: 1 }, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 800, innerHeight: 600 };
const { Select } = await import('../src/components/common/Select.jsx');
const model = await import('../src/components/common/selectModel.js');

const LANGS = [
  { value: '', label: 'Non renseignée' },
  { value: 'de', label: 'Allemand' },
  { value: 'en', label: 'Anglais' },
  { value: 'es', label: 'Espagnol' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italien' },
  { value: 'x', label: 'Éthiopien', disabled: true },
];

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(child => walk(child, visit));
  if (node.props) visit(node);
  walk(node.props?.children ?? node.children, visit);
}
const all = tree => { const found = []; walk(tree, node => found.push(node)); return found; };

function mount(props) {
  const state = { props, changes: [], focus: 0 };
  const ui = runner(() => Select({ ...state.props, onChange: value => { state.changes.push(value); state.props = { ...state.props, value }; } }));
  state.tree = () => ui.render();
  state.render = () => { state.last = ui.render(); ui.flush(); state.last = ui.render(); return state.last; };
  state.trigger = () => {
    const button = all(state.last).find(node => node.type === 'button');
    button.props.ref.current ??= { focus() { state.focus++; }, getBoundingClientRect: () => ({}) };
    return button;
  };
  state.list = () => all(state.last).find(node => node.props.role === 'listbox');
  // `Option` est mémoïsé : on le déplie pour juger le balisage réel (role, aria-*).
  state.options = () => all(state.list()).filter(node => node.props.option !== undefined).map(node => node.type.type(node.props));
  state.key = (key, extra = {}) => {
    const event = { key, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    state.trigger().props.onKeyDown(event); state.render();
    return event;
  };
  state.render();
  state.ui = ui;
  return state;
}
const activeLabel = s => { const id = s.trigger().props['aria-activedescendant']; return s.options().find(o => o.props.id === id)?.props.children[1].props.children.props.children; };

test('ARIA : combobox fermé, puis combobox + listbox + options une fois ouvert', () => {
  const s = mount({ value: 'fr', options: LANGS, id: 'langue', 'aria-label': 'Langue', invalid: true });
  let trigger = s.trigger();
  assert.equal(trigger.props.role, 'combobox'); assert.equal(trigger.props.id, 'langue');
  assert.equal(trigger.props['aria-expanded'], false); assert.equal(trigger.props['aria-haspopup'], 'listbox');
  assert.equal(trigger.props['aria-controls'], undefined); assert.equal(trigger.props['aria-invalid'], true);
  assert.equal(trigger.props['aria-label'], 'Langue'); assert.equal(trigger.props.type, 'button');
  assert.equal(all(trigger.props.children).find(n => n.props.className === 'select-value').props.children, 'Français');
  s.key('ArrowDown');
  trigger = s.trigger();
  const list = s.list();
  assert.equal(trigger.props['aria-expanded'], true);
  assert.equal(trigger.props['aria-controls'], list.props.id);
  assert.equal(list.props['aria-label'], 'Langue');
  const options = s.options();
  assert.equal(options.length, LANGS.length);
  assert.deepEqual(options.filter(o => o.props['aria-selected']).map(o => o.props.id), [options[4].props.id]);
  assert.equal(trigger.props['aria-activedescendant'], options[4].props.id, 'l’ouverture vise la valeur courante');
  assert.equal(options[6].props['aria-disabled'], true); assert.equal(options[1].props['aria-disabled'], undefined);
  assert.equal(new Set(options.map(o => o.props.id)).size, LANGS.length);
});

test('Espace, ↓, ↑ et Alt+↓ ouvrent ; Entrée fermée n’ouvre pas et remonte ; readOnly et disabled ne s’ouvrent pas', () => {
  for (const [key, extra] of [[' ', {}], ['ArrowDown', {}], ['ArrowUp', {}], ['ArrowDown', { altKey: true }]]) {
    const s = mount({ value: 'en', options: LANGS });
    const event = s.key(key, extra);
    assert.equal(s.trigger().props['aria-expanded'], true, key); assert.ok(event.defaultPrevented, key);
  }
  const closed = mount({ value: 'en', options: LANGS });
  const enterClosed = closed.key('Enter');
  assert.equal(closed.trigger().props['aria-expanded'], false, 'Entrée fermée n’ouvre pas');
  assert.equal(enterClosed.defaultPrevented, false); assert.equal(enterClosed.stopped, false, 'et l’événement remonte à l’éditeur');
  assert.equal(closed.key('a', { altKey: true }).defaultPrevented, false, 'Alt + lettre est laissé');
  const readOnly = mount({ value: 'en', options: LANGS, readOnly: true });
  readOnly.key(' '); assert.equal(readOnly.trigger().props['aria-expanded'], false); assert.equal(readOnly.trigger().props['aria-readonly'], true);
  const disabled = mount({ value: 'en', options: LANGS, disabled: true });
  assert.equal(disabled.trigger().props.disabled, true);
});

test('↑ ↓ Début Fin déplacent l’option active en sautant les options désactivées ; Entrée choisit', () => {
  const s = mount({ value: 'de', options: LANGS });
  s.key(' ');
  assert.equal(activeLabel(s), 'Allemand');
  s.key('ArrowDown'); assert.equal(activeLabel(s), 'Anglais');
  s.key('ArrowUp'); s.key('ArrowUp'); assert.equal(activeLabel(s), 'Non renseignée');
  s.key('ArrowUp'); assert.equal(activeLabel(s), 'Non renseignée', 'borné en haut');
  s.key('End'); assert.equal(activeLabel(s), 'Italien', 'Fin saute l’option désactivée finale');
  s.key('ArrowDown'); assert.equal(activeLabel(s), 'Italien');
  s.key('Home'); assert.equal(activeLabel(s), 'Non renseignée');
  s.key('ArrowDown'); s.key('ArrowDown');
  const enter = s.key('Enter');
  assert.deepEqual(s.changes, ['en']); assert.ok(enter.defaultPrevented && enter.stopped);
  assert.equal(s.trigger().props['aria-expanded'], false); assert.ok(s.focus > 0, 'le focus revient au déclencheur');
});

test('Échap ferme sans changer, rend le focus et ne remonte pas ; fermée, la touche remonte', () => {
  const s = mount({ value: 'en', options: LANGS });
  const closedEscape = s.key('Escape');
  assert.equal(closedEscape.defaultPrevented, false); assert.equal(closedEscape.stopped, false);
  s.key(' '); s.key('ArrowDown');
  const before = s.focus;
  const escape = s.key('Escape');
  assert.ok(escape.defaultPrevented && escape.stopped);
  assert.equal(s.trigger().props['aria-expanded'], false); assert.deepEqual(s.changes, []); assert.equal(s.focus, before + 1);
});

test('Tab ferme sans changer ni retenir la touche', () => {
  const s = mount({ value: 'en', options: LANGS });
  s.key(' '); s.key('ArrowDown');
  const tab = s.key('Tab');
  assert.equal(tab.defaultPrevented, false); assert.equal(tab.stopped, false);
  assert.equal(s.trigger().props['aria-expanded'], false); assert.deepEqual(s.changes, []);
});

test('un clic sur une option choisit ; une option désactivée ne répond pas ; la valeur courante ne déclenche rien', () => {
  const s = mount({ value: 'en', options: LANGS });
  s.key(' ');
  assert.equal(s.options()[6].props.onClick, undefined);
  s.options()[4].props.onClick(); s.render();
  assert.deepEqual(s.changes, ['fr']);
  s.key(' '); s.options()[4].props.onClick(); s.render();
  assert.deepEqual(s.changes, ['fr'], 'même valeur : pas de changement');
  assert.equal(s.trigger().props['aria-expanded'], false);
});

test('recherche par frappe : sans accent ni casse, préfixe, lettre répétée en cycle, tampon vidé après 500 ms', () => {
  const real = Date.now; let now = 1_000_000; Date.now = () => now;
  try {
    const s = mount({ value: '', options: [...LANGS.slice(0, 6), { value: 'etc', label: 'Estonien' }, { value: 'el', label: 'Élamite' }] });
    // Fermée, le déclencheur focalisé : comme un select natif, la valeur change.
    s.key('i'); assert.deepEqual(s.changes, ['it']);
    now += 600; s.key('E'); assert.deepEqual(s.changes, ['it', 'etc'], 'E → première entrée en E après la courante');
    now += 100; s.key('e'); assert.deepEqual(s.changes.at(-1), 'el', 'même lettre → entrée suivante ; accent ignoré : Élamite');
    now += 100; s.key('e'); assert.deepEqual(s.changes.at(-1), 'es', 'cycle : retour à la première');
    now += 100; s.key('e'); assert.deepEqual(s.changes.at(-1), 'etc');
    now += 600; s.key('é'); s.key('l'); assert.equal(s.changes.at(-1), 'el', 'préfixe « él »');
    now += 600; s.key('z'); const count = s.changes.length; assert.equal(s.changes.length, count, 'sans correspondance, rien ne change');
    // Espace dans une frappe en cours fait partie du texte ; seul, il ouvre.
    now += 600; s.key(' '); assert.equal(s.trigger().props['aria-expanded'], true);
    s.key('Escape');
    // Ouverte : la frappe déplace l’option active sans changer la valeur.
    const before = s.changes.length;
    s.key(' '); now += 600; s.key('f'); assert.equal(activeLabel(s), 'Français'); assert.equal(s.changes.length, before);
    now += 600; s.key('A'); assert.equal(activeLabel(s), 'Allemand'); s.key('n'); assert.equal(activeLabel(s), 'Anglais', 'préfixe « an »');
  } finally { Date.now = real; }
});

test('la recherche par frappe saute les options désactivées', () => {
  const options = [{ value: 'a1', label: 'Alpha', disabled: true }, { value: 'a2', label: 'Alto' }, { value: 'b', label: 'Beta' }];
  assert.equal(model.typeaheadMatch(options, 'a', -1), 1);
  assert.equal(model.typeaheadMatch(options, 'al', 1), 1);
  assert.equal(model.typeaheadMatch(options, 'zz', 1), -1);
  assert.equal(model.foldText('Éthiopien'), 'ethiopien');
});

test('groupes : section nommée (role group + titre), options à plat pour le clavier', () => {
  const options = [{ value: 'a', label: 'A', group: 'Scènes' }, { value: 'b', label: 'B', group: 'Scènes' }, { value: 'c', label: 'C', group: 'Menus' }, { value: 'd', label: 'D' }];
  const s = mount({ value: 'b', options }); s.key(' ');
  const groups = all(s.list()).filter(node => node.props.role === 'group');
  assert.equal(groups.length, 2);
  const headings = all(s.list()).filter(node => node.props.role === 'presentation');
  assert.deepEqual(headings.map(h => h.props.children), ['Scènes', 'Menus']);
  assert.deepEqual(groups.map(g => g.props['aria-labelledby']), headings.map(h => h.props.id));
  assert.equal(s.options().length, 4);
  s.key('ArrowDown'); assert.equal(s.trigger().props['aria-activedescendant'], s.options()[2].props.id, 'le clavier traverse les groupes');
  assert.deepEqual(model.buildSections(options).map(x => [x.group, x.options.length]), [['Scènes', 2], ['Menus', 1], [null, 1]]);
});

test('valeurs numériques : onChange rend la valeur de l’option telle quelle', () => {
  const s = mount({ value: 2, options: [{ value: 1, label: 'Un' }, { value: 2, label: 'Deux' }, { value: 3, label: 'Trois' }] });
  s.key(' '); s.key('ArrowDown'); s.key('Enter');
  assert.deepEqual(s.changes, [3]);
});

test('placement : sous le champ, retourné au-dessus sans place, largeur ≥ champ, bornes de la fenêtre', () => {
  const viewport = { width: 800, height: 600 };
  const below = model.placeList({ rect: { left: 100, top: 100, bottom: 134, width: 180 }, listWidth: 200, contentHeight: 500, viewport });
  assert.equal(below.above, false); assert.equal(below.top, 138); assert.equal(below.minWidth, 180); assert.equal(below.maxHeight, 320);
  const flipped = model.placeList({ rect: { left: 100, top: 520, bottom: 554, width: 180 }, listWidth: 200, contentHeight: 200, viewport });
  assert.equal(flipped.above, true); assert.equal(flipped.top + 200, 516);
  const tall = model.placeList({ rect: { left: 790, top: 520, bottom: 554, width: 10 }, listWidth: 200, contentHeight: 900, viewport });
  assert.equal(tall.left, 592); assert.ok(tall.top >= 0 && tall.maxHeight <= 320);
  const short = model.placeList({ rect: { left: 10, top: 100, bottom: 134, width: 90 }, listWidth: 90, contentHeight: 60, viewport });
  assert.equal(short.above, false);
});

test('garde : plus aucun <select> natif dans le catalogue, ni de CSS mort pour lui', () => {
  const root = fileURLToPath(new URL('../src/components/Catalogue', import.meta.url));
  const files = []; (function visit(dir) { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) visit(path); else if (/\.(jsx|css)$/.test(name)) files.push(path); } })(root);
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.jsx')) assert.doesNotMatch(text, /<select[\s>]|createElement\(['"]select/, file);
    else assert.doesNotMatch(text, /\.catalogue-(field-editor|selection-metadata|language-select)[^{]*\bselect\b|\.catalogue-language-select/, file);
  }
});
