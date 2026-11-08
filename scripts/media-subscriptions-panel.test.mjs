import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';

import { runner } from './reactHookDriver.mjs';

// Seul le runtime JSX est doublé : le panneau de production est rendu tel quel.
const jsxRuntime = 'export const Fragment = "fragment"; export function jsx(type, props, key) { return { type, props, key }; } export const jsxs = jsx;';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react/jsx-runtime') {
      return { url: `data:text/javascript,${encodeURIComponent(jsxRuntime)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      return {
        format: 'module', shortCircuit: true,
        source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code,
      };
    }
    return next(url, context);
  },
});

const { MediaSubscriptionsPanel } = await import('../src/components/MediaSubscriptions/MediaSubscriptionsPanel.jsx');

// Déplie les sous-composants dans le rendu du pilote, y compris le toast partagé.
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !node.props) return [];
  if (typeof node.type === 'function') return elements(node.type(node.props));
  return [node, ...elements(node.props.children)];
}

function text(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node.type === 'function') return text(node.type(node.props));
  return text(node.props?.children);
}

// La gestion est désormais visible directement dans la section des Préférences.
function openPanel(props) {
  return runner(() => elements(MediaSubscriptionsPanel(props))).render();
}

const youtube = {
  id: 'yt', title: 'Chaîne', projectName: 'Story', source: 'youtube', status: 'active', enabled: true,
};

function buttons(nodes, label) {
  return nodes.filter((node) => node.type === 'button' && text(node) === label);
}

test('the panel offers a YouTube tool update, then shows its progress and readable error', () => {
  const calls = [];
  let nodes = openPanel({
    subscriptions: [youtube],
    youtubeTools: { missing: false, updating: false, error: null },
    onUpdateTools: () => calls.push('update'),
  });
  assert.ok(nodes.some((node) => node.type === 'p' && text(node) === 'L’outil YouTube peut être mis à jour.'));
  buttons(nodes, 'Mettre à jour')[0].props.onClick();
  assert.deepEqual(calls, ['update']);

  nodes = openPanel({ subscriptions: [youtube], youtubeTools: { missing: false, updating: true, error: null } });
  assert.equal(buttons(nodes, 'Mise à jour…')[0].props.disabled, true);

  nodes = openPanel({ subscriptions: [youtube], youtubeTools: { missing: true, updating: false, error: 'Mise à jour impossible : réseau.' } });
  assert.ok(nodes.some((node) => node.type === 'p' && text(node) === 'L’outil YouTube n’est pas installé.'));
  assert.equal(buttons(nodes, 'Installer').length, 1);
  assert.ok(nodes.some((node) => node.props.role === 'alert' && text(node) === 'Mise à jour impossible : réseau.'));
});

test('without a tool notice the panel shows no update line', () => {
  const nodes = openPanel({ subscriptions: [youtube], youtubeTools: null });
  assert.equal(buttons(nodes, 'Mettre à jour').length, 0);
  assert.equal(buttons(nodes, 'Installer').length, 0);
});

test('a paused follow whose project is missing shows both states and the relocation action', () => {
  const nodes = openPanel({ subscriptions: [{ ...youtube, status: 'missing', enabled: false }] });
  assert.ok(nodes.some((node) => node.type === 'span' && text(node) === 'Story · YouTube · Suspendu · Projet introuvable'));
  assert.equal(buttons(nodes, 'Retrouver le projet').length, 1);
  assert.equal(buttons(nodes, 'Reprendre').length, 1);

  const active = openPanel({ subscriptions: [{ ...youtube, status: 'missing', enabled: true }] });
  assert.ok(active.some((node) => node.type === 'span' && text(node) === 'Story · YouTube · Actif · Projet introuvable'));
});

const { MediaSubscriptionsSection } = await import('../src/tabs/OptionsTab/MediaSubscriptionsSection.jsx');
const { MediaSubscriptionsToast } = await import('../src/components/MediaSubscriptions/MediaSubscriptionsToast.jsx');
const { useOptionsTabProps } = await import('../src/hooks/useOptionsTabProps.js');

test('preferences section exposes pending items first and every management action without a floating trigger', () => {
  const calls = [];
  const nodes = runner(() => elements(MediaSubscriptionsSection({ className: 'opts-card', sectionRef: 'section-ref', subscriptions: {
    subscriptions: [{ ...youtube, status: 'missing', enabled: false }],
    notifications: [{ id: 'yt', title: 'Nouveau', projectName: 'Story', source: 'youtube', count: 2 }],
    storageError: 'Registre illisible',
    onOpenNotification: id => calls.push(['open', id]),
    onDismissNotification: id => calls.push(['dismiss', id]),
    onToggleSubscription: id => calls.push(['toggle', id]),
    onRemoveSubscription: id => calls.push(['remove', id]),
    onRelocateSubscription: id => calls.push(['relocate', id]),
  } }))).render();
  const section = nodes.find(node => node.type === 'section');
  assert.equal(section.props.id, 'media-subscriptions');
  assert.equal(section.props.ref, 'section-ref');
  assert.equal(section.props.className, 'opts-card');
  assert.ok(nodes.some(node => node.props.className === 'opts-card-title' && text(node) === 'Suivis des médias'));
  assert.deepEqual(nodes.filter(node => node.type === 'h3').map(text), ['Notifications', 'Abonnements']);
  assert.ok(nodes.some(node => node.props.role === 'alert' && text(node) === 'Registre illisible'));
  assert.equal(nodes.some(node => node.props['aria-controls'] === 'media-subscriptions-panel'), false);
  for (const label of ['Ouvrir', 'Supprimer', 'Retrouver le projet', 'Reprendre']) {
    for (const button of buttons(nodes, label)) button.props.onClick();
  }
  assert.deepEqual(calls, [['open', 'yt'], ['dismiss', 'yt'], ['remove', 'yt'], ['relocate', 'yt'], ['toggle', 'yt']]);
  assert.equal(buttons(nodes, 'Vérifier maintenant')[0].props.disabled, true);
  const active = openPanel({ subscriptions: [youtube], onCheck: () => calls.push(['check']) });
  assert.equal(buttons(active, 'Vérifier maintenant')[0].props.disabled, false);
  buttons(active, 'Vérifier maintenant')[0].props.onClick();
  assert.deepEqual(calls.at(-1), ['check']);
  const options = readFileSync(new URL('../src/tabs/OptionsTab.jsx', import.meta.url), 'utf8');
  assert.match(options, /MediaSubscriptionsSection\s+className=\{sectionClass\(MEDIA_SUBSCRIPTIONS_SECTION\)\}\s+sectionRef=\{registerSection\(MEDIA_SUBSCRIPTIONS_SECTION\)\}\s+subscriptions=\{subscriptions\}/);
  const nav = readFileSync(new URL('../src/tabs/OptionsTab/OptionsSectionNav.jsx', import.meta.url), 'utf8');
  assert.match(nav, /id: 'media-subscriptions', labelKey: 'media:subscriptions.section.title'/);
});

test('App renders the dedicated toast in Catalogue and workspace branches with the same live actions', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf("  if (modals.isOpen('catalogue')) return <ProjectContext.Provider");
  const end = source.indexOf('\n}', start);
  const code = transformSync('app-render.jsx', `function render() { ${source.slice(start, end)} }`, { jsx: { runtime: 'classic', factory: 'jsx', fragment: 'Fragment' } }).code;
  const jsx = (type, props, ...children) => ({ type, props: { ...props, children } });
  const calls = [];
  const toastProps = { toast: { id: 'new', title: 'Nouveau', projectName: 'Projet', source: 'podcast', count: 1 }, onOpenNotification: id => calls.push(id), onCloseToast: () => calls.push('close') };
  for (const catalogue of [true, false]) {
    const modals = { isOpen: name => name === 'catalogue' && catalogue };
    const deps = { React: { createElement: jsx, Fragment: 'fragment' }, jsx, Fragment: 'fragment', modals, ProjectContext: { Provider: 'provider' }, projectContextValue: {}, MediaSubscriptionsToast, subscriptions: { panelProps: toastProps }, CatalogueScreen: 'catalogue', catalogueLeaveGuard: { current: null }, handleLandAggregate() {}, useWorkspaceForNewProjects: false, configuredWorkspaceDir: '', catalogueEditorHost: {}, sessionRecoveries: [], appShellProps: { titleBar: {} }, shortcutLabels: {}, AppModals: 'modals', appModalsProps: {}, optionsTabProps: { openPreferences() {} }, handleIgnoreSessionRecovery() {}, AppShell: 'shell' };
    const render = new Function(...Object.keys(deps), `${code}; return render;`)(...Object.values(deps));
    const tree = render();
    const flat = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flatMap(flat)];
    const notice = flat(tree).find(node => node.type === MediaSubscriptionsToast);
    assert.ok(notice, `toast present: Catalogue=${catalogue}`);
    assert.equal(notice.props.toast, toastProps.toast);
    const nodes = runner(() => elements(MediaSubscriptionsToast(notice.props))).render();
    buttons(nodes, 'Ouvrir')[0].props.onClick();
    nodes.find(node => node.type === 'button' && node.props['aria-label']).props.onClick();
    if (catalogue) assert.equal(flat(tree).find(node => node.type === 'catalogue').props.leaveGuard, deps.catalogueLeaveGuard);
  }
  assert.deepEqual(calls, ['new', 'close', 'new', 'close']);
});


test('startup reminder View targets media preferences from home, project and Catalogue; close only dismisses', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf("  if (modals.isOpen('catalogue')) return <ProjectContext.Provider");
  const code = transformSync('app-render.jsx', `function render() { ${source.slice(start, source.indexOf('\n}', start))} }`, { jsx: { runtime: 'classic', factory: 'jsx', fragment: 'Fragment' } }).code;
  const jsx = (type, props, ...children) => ({ type, props: { ...props, children } });
  const flat = node => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flatMap(flat)];
  for (const screen of ['home', 'project', 'catalogue']) {
    let target = null;
    let prefsOpen = false;
    let closed = 0;
    const targetRunner = runner(() => useOptionsTabProps({ onOpen: () => { prefsOpen = true; } }));
    const deps = { React: { createElement: jsx, Fragment: 'fragment' }, jsx, Fragment: 'fragment', modals: { isOpen: name => name === 'catalogue' ? screen === 'catalogue' : name === 'prefs' && prefsOpen }, ProjectContext: { Provider: 'provider' }, projectContextValue: {}, MediaSubscriptionsToast, subscriptions: { panelProps: { toast: { kind: 'startup-reminder', count: 3 }, onCloseToast: () => { closed++; }, onOpenNotification: () => assert.fail('le rappel ne doit pas ouvrir un projet') } }, CatalogueScreen: 'catalogue', catalogueLeaveGuard: {}, handleLandAggregate() {}, useWorkspaceForNewProjects: false, configuredWorkspaceDir: '', catalogueEditorHost: {}, sessionRecoveries: [], appShellProps: { titleBar: {}, project: screen === 'project' ? {} : null }, shortcutLabels: {}, AppModals: 'modals', appModalsProps: {}, optionsTabProps: targetRunner.render(), handleIgnoreSessionRecovery() {}, AppShell: 'shell' };
    const render = () => new Function(...Object.keys(deps), `${code}; return render();`)(...Object.values(deps));
    const notice = flat(render()).find(node => node.type === MediaSubscriptionsToast);
    const nodes = runner(() => elements(MediaSubscriptionsToast(notice.props))).render();
    assert.ok(nodes.some(node => node.type === 'strong' && text(node) === 'Nouveautés en attente'));
    assert.ok(nodes.some(node => node.type === 'span' && text(node) === '3 suivis ont des nouveautés'));
    nodes.find(node => node.type === 'button' && node.props['aria-label']).props.onClick();
    assert.equal(prefsOpen, false);
    assert.equal(closed, 1);
    buttons(nodes, 'Voir')[0].props.onClick();
    target = targetRunner.render();
    assert.equal(prefsOpen, true);
    assert.equal(target.initialSection, 'media-subscriptions');
    assert.equal(closed, 2);
    deps.optionsTabProps = target;
    deps.appModalsProps = { optionsTabProps: target };
    const tree = flat(render());
    if (screen === 'catalogue') {
      const surface = tree.find(node => node.type === 'catalogue').props.preferencesSurface;
      assert.equal(surface.props.preferencesSection ?? surface.props.optionsTabProps.initialSection, 'media-subscriptions');
      tree.find(node => node.type === 'catalogue').props.onPreferences();
      assert.equal(targetRunner.render().initialSection, 'catalogue', 'le menu Catalogue garde sa section par défaut');
    }
  }
});
