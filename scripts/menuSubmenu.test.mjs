import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFragment: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { MenuSubmenu } = await import('../src/components/layout/MenuSubmenu.jsx');
const { submenuPlacement, insideIntentTriangle } = await import('../src/components/layout/submenuGeometry.js');
const { navigateMenu, menuItems } = await import('../src/components/layout/menuNavigation.js');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const key = (value, extra = {}) => ({ key: value, detail: 0, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

// Un faux DOM minimal : l'ouverture du sous-menu mesure et donne le focus à des éléments.
function fakeMenu(items) {
  const menu = {
    getBoundingClientRect: () => ({ width: 220, height: 120, left: 0, top: 0, right: 220, bottom: 120 }),
    contains: element => items.includes(element),
    querySelectorAll: () => items,
  };
  items.forEach(item => { item.closest = () => menu; });
  return menu;
}
function setup() {
  const previous = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver };
  const events = new EventTarget();
  globalThis.document = Object.assign(events, { activeElement: null });
  globalThis.window = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  globalThis.getComputedStyle = () => ({ paddingTop: '10px', borderTopWidth: '1px' });
  globalThis.ResizeObserver = undefined;
  const items = [{ focus() { globalThis.document.activeElement = this; } }, { focus() { globalThis.document.activeElement = this; } }];
  const submenu = fakeMenu(items);
  const triggerElement = { focus() { globalThis.document.activeElement = this; } };
  let changes = [];
  const hook = runner(() => MenuSubmenu({ label: 'Étiquettes', onOpenChange: value => changes.push(value),
    trigger: props => ({ type: 'button', props: { ...props, role: 'menuitem', children: 'Étiquettes' } }),
    children: [{ type: 'button', key: 'a', props: { role: 'menuitemcheckbox', children: 'A' } }] }));
  const render = () => {
    const tree = hook.render();
    const wrap = tree;
    const menu = elements(tree).find(node => node.props?.role === 'menu');
    if (menu) menu.props.ref.current = Object.assign(submenu, { closest: () => null });
    const trigger = elements(tree).find(node => node.props?.role === 'menuitem');
    trigger.props.ref(triggerElement);
    hook.flush();
    return { tree, menu, trigger: trigger.props, wrap };
  };
  // `wrapRef` n'est lu qu'à l'ouverture : un élément qui mesure.
  const first = hook.render();
  first.props.ref.current = { closest: () => ({ getBoundingClientRect: () => ({ left: 0, right: 260, top: 0, bottom: 300 }) }), getBoundingClientRect: () => ({ top: 40 }), contains: () => false };
  return { render, items, submenu, triggerElement, changes: () => changes, restore() { hook.unmount(); Object.assign(globalThis, previous); } };
}

test('fermé par défaut : l’entrée annonce un sous-menu replié', () => {
  const s = setup();
  try {
    const { menu, trigger } = s.render();
    assert.equal(menu, undefined);
    assert.equal(trigger['aria-haspopup'], 'menu');
    assert.equal(trigger['aria-expanded'], false);
  } finally { s.restore(); }
});

test('→ ouvre et met le focus sur la 1re entrée ; ← rend le focus à l’entrée parente', () => {
  const s = setup();
  try {
    let view = s.render();
    const right = key('ArrowRight'); view.trigger.onKeyDown(right);
    assert.ok(right.prevented && right.stopped, 'la touche ne remonte pas au menu parent');
    view = s.render();
    assert.equal(view.trigger['aria-expanded'], true);
    assert.equal(view.menu.props.role, 'menu');
    assert.equal(view.menu.props['aria-label'], 'Étiquettes');
    assert.equal(globalThis.document.activeElement, s.items[0], 'focus sur la 1re entrée');
    assert.deepEqual(s.changes(), [true]);
    const left = key('ArrowLeft'); view.menu.props.onKeyDown(left);
    assert.ok(left.stopped);
    view = s.render();
    assert.equal(view.trigger['aria-expanded'], false);
    assert.equal(globalThis.document.activeElement, s.triggerElement, 'focus rendu à l’entrée parente');
  } finally { s.restore(); }
});

test('Échap dans le sous-menu ne ferme que lui (la touche ne remonte pas) ; Tab remonte', () => {
  const s = setup();
  try {
    let view = s.render(); view.trigger.onClick(key('Enter', { type: 'click' })); view = s.render();
    assert.equal(view.trigger['aria-expanded'], true);
    const tab = key('Tab'); view.menu.props.onKeyDown(tab); assert.ok(!tab.stopped, 'Tab ferme le menu racine');
    const escape = key('Escape'); view.menu.props.onKeyDown(escape);
    assert.ok(escape.stopped, 'Échap s’arrête au sous-menu : le menu racine reste ouvert');
    view = s.render(); assert.equal(view.trigger['aria-expanded'], false);
    assert.equal(globalThis.document.activeElement, s.triggerElement);
  } finally { s.restore(); }
});

test('← dans un champ de saisie du sous-menu appartient au champ', () => {
  const s = setup();
  try {
    let view = s.render(); view.trigger.onClick(key('Enter')); view = s.render();
    const left = key('ArrowLeft', { target: { tagName: 'INPUT' } }); view.menu.props.onKeyDown(left);
    assert.ok(!left.prevented);
    assert.equal(s.render().trigger['aria-expanded'], true);
  } finally { s.restore(); }
});

test('un clic souris ouvre sans déplacer le focus ; un clic clavier (Entrée) le déplace', () => {
  const s = setup();
  try {
    let view = s.render(); view.trigger.onClick(key('click', { detail: 1 })); view = s.render();
    assert.equal(view.trigger['aria-expanded'], true);
    assert.notEqual(globalThis.document.activeElement, s.items[0]);
  } finally { s.restore(); }
  const k = setup();
  try {
    let view = k.render(); view.trigger.onClick(key('click', { detail: 0 })); view = k.render();
    assert.equal(globalThis.document.activeElement, k.items[0]);
  } finally { k.restore(); }
});

test('le sous-menu est posé à côté du menu parent, premier élément aligné sur l’entrée', () => {
  const s = setup();
  try {
    let view = s.render(); view.trigger.onClick(key('click')); s.render(); view = s.render();
    assert.deepEqual(view.menu.props.style, { left: 258, top: 29 });
  } finally { s.restore(); }
});

test('submenuPlacement : retournement à gauche, recalage vertical, sous-menu plus haut que la fenêtre', () => {
  const viewport = { width: 1000, height: 600 };
  const parent = { left: 700, right: 960 };
  assert.deepEqual(submenuPlacement({ parent: { left: 100, right: 360 }, anchor: { top: 50 }, size: { width: 220, height: 100 }, viewport, inset: 11 }), { left: 358, top: 39, flipped: false });
  assert.deepEqual(submenuPlacement({ parent, anchor: { top: 50 }, size: { width: 220, height: 100 }, viewport, inset: 11 }), { left: 482, top: 39, flipped: true });
  assert.equal(submenuPlacement({ parent: { left: 100, right: 360 }, anchor: { top: 560 }, size: { width: 220, height: 200 }, viewport, inset: 11 }).top, 392, 'recalé au-dessus du bord bas');
  assert.equal(submenuPlacement({ parent: { left: 100, right: 360 }, anchor: { top: 10 }, size: { width: 220, height: 900 }, viewport, inset: 11 }).top, 8, 'jamais au-dessus du bord haut');
  assert.equal(submenuPlacement({ parent: { left: 10, right: 300 }, anchor: { top: 0 }, size: { width: 800, height: 10 }, viewport, inset: 0 }).left >= 8, true, 'ni trop à gauche');
});

test('tolérance de trajectoire : le pointeur qui va vers le sous-menu n’en sort pas', () => {
  const rect = { left: 260, right: 480, top: 100, bottom: 300 };
  const origin = { x: 200, y: 120 };
  assert.equal(insideIntentTriangle({ x: 230, y: 180 }, origin, rect), true, 'en diagonale vers le sous-menu');
  assert.equal(insideIntentTriangle({ x: 230, y: 20 }, origin, rect), false, 'vers le haut, hors du triangle');
  assert.equal(insideIntentTriangle({ x: 150, y: 400 }, origin, rect), false);
  assert.equal(insideIntentTriangle({ x: 500, y: 180 }, { x: 540, y: 120 }, rect, true), true, 'sous-menu retourné à gauche');
});

test('navigation : flèches entre les entrées du seul sous-menu, avec bouclage', () => {
  const previous = globalThis.document;
  const items = [{ focus() { globalThis.document.activeElement = this; } }, { focus() { globalThis.document.activeElement = this; } }, { focus() { globalThis.document.activeElement = this; }, disabled: true }];
  const menu = { querySelectorAll: () => items }; items.forEach(item => { item.closest = () => menu; });
  items.push({ closest: () => ({}), focus() {} });
  globalThis.document = { activeElement: null };
  try {
    assert.equal(menuItems(menu).length, 2, 'ni désactivées ni celles d’un autre menu');
    assert.equal(navigateMenu(key('ArrowDown'), menu), true); assert.equal(globalThis.document.activeElement, items[0]);
    navigateMenu(key('ArrowDown'), menu); assert.equal(globalThis.document.activeElement, items[1]);
    navigateMenu(key('ArrowDown'), menu); assert.equal(globalThis.document.activeElement, items[0], 'boucle');
    navigateMenu(key('End'), menu); assert.equal(globalThis.document.activeElement, items[1]);
    assert.equal(navigateMenu(key('a'), menu), false);
  } finally { globalThis.document = previous; }
});

test('survol : ouverture temporisée, fermeture différée à la sortie, le tactile n’ouvre qu’au clic', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  try {
    let view = s.render();
    view.tree.props.onPointerEnter({ pointerType: 'touch' }); t.mock.timers.tick(1000);
    assert.equal(s.render().trigger['aria-expanded'], false, 'le tactile n’ouvre pas au survol');
    view.tree.props.onPointerEnter({ pointerType: 'mouse' });
    t.mock.timers.tick(100); assert.equal(s.render().trigger['aria-expanded'], false, 'une traversée rapide n’ouvre rien');
    view.tree.props.onPointerLeave({ pointerType: 'mouse', clientX: 0, clientY: 0 }); t.mock.timers.tick(1000);
    assert.equal(s.render().trigger['aria-expanded'], false, 'quitter avant la temporisation annule l’ouverture');
    view.tree.props.onPointerEnter({ pointerType: 'mouse' }); t.mock.timers.tick(200);
    view = s.render(); assert.equal(view.trigger['aria-expanded'], true);
    view.tree.props.onPointerLeave({ pointerType: 'mouse', clientX: 0, clientY: 0 });
    t.mock.timers.tick(100); assert.equal(s.render().trigger['aria-expanded'], true, 'la fermeture attend');
    view.tree.props.onPointerEnter({ pointerType: 'mouse' }); t.mock.timers.tick(1000);
    assert.equal(s.render().trigger['aria-expanded'], true, 'revenir annule la fermeture');
    view.tree.props.onPointerLeave({ pointerType: 'mouse', clientX: 0, clientY: 0 }); t.mock.timers.tick(400);
    assert.equal(s.render().trigger['aria-expanded'], false);
  } finally { s.restore(); }
});
