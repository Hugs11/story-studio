import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { mountSurface } from './chromeBench.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import { RELEASE_NOTES } from '../src/config/releaseNotes.js';
const { askSaveBeforeLeave } = await import('../src/hooks/saveBeforeLeave.js');
const { buildToolbarInventory, SUSPENDED_BY_EXPORT } = await import('../src/store/toolbarModel.js');
import { WORKSPACE_MODE_HIERARCHICAL } from '../src/store/projectWorkState.js';

// Le portal est remplacé car SSR ne l’accepte pas. Les contenus des domaines
// Médias et IA sont isolés ; le shell, ses onglets et les notes sont rendus réellement.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('/src/components/SDQueuePanel/SDQueuePanel.jsx')) {
      return { format: 'module', source: 'export function SDQueuePanel() { return null; }', shortCircuit: true };
    }
    if (url.endsWith('/src/components/MediaSubscriptions/MediaSubscriptionsPanel.jsx')) {
      return { format: 'module', source: 'export function MediaSubscriptionsPanel() { return null; }', shortCircuit: true };
    }
    if (url.endsWith('/src/components/common/AppModalPortal.jsx')) {
      return { format: 'module', source: 'export function AppModalPortal({ children }) { return children; }', shortCircuit: true };
    }
    return next(url, context);
  },
});
const { AppShell } = await import('../src/components/AppShell.jsx');
const { AppModals } = await import('../src/components/AppModals.jsx');
const { BottomWorkspacePanel } = await import('../src/components/BottomWorkspacePanel/BottomWorkspacePanel.jsx');
const { TitleBar } = await import('../src/components/layout/TitleBar.jsx');
const { CommandButton } = await import('../src/components/layout/Toolbar.jsx');
const { ProjectMenuPopover } = await import('../src/components/layout/ProjectMenuPopover.jsx');
const { StructureActionsBar } = await import('../src/components/structure/StructureActionsBar.jsx');
const { WorkspaceEmptyState } = await import('../src/workspace/WorkspaceEmptyState.jsx');
const { LuniiShell } = await import('../src/tabs/EmulatorTab/LuniiShell.jsx');
const { ReleaseNotesModal } = await import('../src/components/common/ReleaseNotesModal.jsx');

const instance = createTestI18n();
i18next.init({
  ...instance.options,
  resources: { ...instance.options.resources, pseudo: pseudoResources(instance.options.resources.fr) },
});
const noop = () => {};
const paint = (Component, props = {}) => mountSurface(createElement(Component, props));

function assertPseudoText(html) {
  // Les noms auteur, nombres, marques et symboles sont les seules valeurs stables.
  const text = html.replace(/<[^>]+>/g, '').replace(/\[[^\]]*\]/g, '').replaceAll('Story Studio', '');
  assert.doesNotMatch(text, /[\p{L}]{2,}/u, text);
  const labels = [...html.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map((match) => match[1]);
  for (const label of labels) assert.ok(label.startsWith('['), label);
}

test('surfaces shell en pseudo-locale, y compris libellés accessibles et tables déjà créées', async () => {
  await i18next.changeLanguage('fr');
  const inventory = buildToolbarInventory({ workspaceMode: WORKSPACE_MODE_HIERARCHICAL, editingLocked: true });
  assert.equal(inventory.find((entry) => entry.id === 'saveProject').label, 'Enregistrer');
  await i18next.changeLanguage('pseudo');
  assert.equal(SUSPENDED_BY_EXPORT, 'common:toolbar.export.suspended');
  for (const entry of inventory) assertPseudoText(paint(CommandButton, { entry, onClick: noop, Icon: () => null }).html);
  const modals = { modals: { isOpen: () => false }, project: {}, sdGenerate: {}, packMetadata: {} };
  assertPseudoText(paint(AppShell, {
    mediaTransfer: {}, titleBar: {}, toolbar: {}, workspace: {}, bottomPanel: {}, appModalsProps: modals,
    bottomBar: { projectOpen: true, mediaLibraryCount: 0, renderQueueActiveCount: 0, aiQueueActiveCount: 0 },
  }).html);
  assertPseudoText(paint(AppModals, { ...modals, saveProgress: { lines: [], complete: false } }).html);
  assertPseudoText(paint(AppModals, { ...modals, saveAsProgress: { lines: [], complete: true } }).html);
  const importSurface = paint(AppModals, { ...modals, importing: { total: 3, index: 1, name: '', phase: '' } });
  assertPseudoText(importSurface.html);
  assertPseudoText(paint(AppModals, { ...modals, unpacking: { name: '' } }).html);
  assertPseudoText(paint(BottomWorkspacePanel, {
    activeTab: null, project: { menus: [] }, sdJobs: [], xttsJobs: [], mediaLibraryPaths: [],
    renderQueue: { jobs: [] },
  }).html);
  assertPseudoText(paint(TitleBar, { onOpenPreferences: noop, onOpenCredits: noop }).html);
  assertPseudoText(paint(ProjectMenuPopover, {
    open: true, commands: inventory, shortcutLabels: {}, trigger: () => null,
  }).html);
  assertPseudoText(paint(WorkspaceEmptyState).html);
  assertPseudoText(paint(StructureActionsBar, {
    onAddStory: noop, onAddFolder: noop, onImportFolder: noop, onImportPodcast: noop,
    onImportYoutube: noop, onRecord: noop, onGenerateStoryTts: noop, onLaunchSimulator: noop,
    availableInlineSize: 1200,
  }).html);
  assertPseudoText(paint(LuniiShell, {
    onClose: noop, dragHandleProps: {}, playbackControls: { visible: true, currentTime: 0, duration: 20 },
    chromeControls: { autoPlaybackEnabled: true, transparentPreview: false },
  }).html);
  const notes = paint(ReleaseNotesModal, { appVersion: RELEASE_NOTES.version }).html;
  assert.ok(notes.includes(i18next.t('common:releaseNotes.current.fixes.label')));
  // Intl reste en FR en pseudo ; vérifier la date entière avant de l'exclure.
  const date = new Date(RELEASE_NOTES.date).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const time = `<time dateTime="${RELEASE_NOTES.date}">${date}</time>`;
  assert.ok(notes.includes(time), time);
  assert.ok(notes.includes(RELEASE_NOTES.version));
  const strippedNotes = notes.replace(time, '').replaceAll(RELEASE_NOTES.version, '')
    .replace(/STORY STUDIO/g, '').replace(/hugs11/g, '');
  // Le numéro de version, y compris son suffixe de pré-version, reste technique.
  assertPseudoText(strippedNotes);
  await i18next.changeLanguage('fr');
});

test('garde déjà ouverte : langue à chaud, nom auteur intact, français historique', async () => {
  const work = { project: { projectType: 'pack', projectName: 'Mon titre auteur' }, pristine: false,
    savePath: '/tmp/a.mbah', projectName: 'Mon titre auteur', savedSnapshot: null };
  const before = JSON.stringify(work);
  await i18next.changeLanguage('fr');
  await askSaveBeforeLeave(() => work, noop, async (dialog) => {
    assert.equal(dialog.title, 'Modifications non enregistrées');
    assert.equal(dialog.message, 'Les modifications de « Mon titre auteur » depuis le dernier enregistrement seront perdues.');
    await i18next.changeLanguage('en');
    assert.equal(dialog.actions[0].label, 'Cancel');
    assert.equal(dialog.actions[2].label, 'Save');
    assert.match(dialog.message, /Mon titre auteur/);
    await i18next.changeLanguage('pseudo');
    assert.ok(dialog.message.startsWith('['));
    assert.ok(dialog.actions[0].label.startsWith('['));
    return 'cancel';
  });
  assert.equal(JSON.stringify(work), before);
  await i18next.changeLanguage('fr');
});


test('file de rendu : repli à l’affichage après changement de langue, nom auteur stable', async () => {
  const { newRenderJob, WORK_NATURE } = await import('../src/store/production/renderQueueWork.js');
  const { RenderQueuePanel } = await import('../src/components/RenderQueuePanel/RenderQueuePanel.jsx');
  await i18next.changeLanguage('fr');
  const jobs = [WORK_NATURE.FREE, WORK_NATURE.ADVANCED].map((nature, index) =>
    newRenderJob({ id: `empty-${index}`, nature, createdAt: 0, projectName: '', outputFolder: '/tmp' }));
  jobs.push(newRenderJob({ id: 'named', createdAt: 0, projectName: 'Mon titre auteur', outputFolder: '/tmp' }));
  assert.deepEqual(jobs.map((job) => job.projectName), ['', '', 'Mon titre auteur']);
  const before = JSON.stringify(jobs);
  for (const language of ['fr', 'en', 'it', 'pseudo']) {
    await i18next.changeLanguage(language);
    const { html } = mountSurface(createElement(I18nextProvider, { i18n: i18next },
      createElement(RenderQueuePanel, { jobs, embedded: true })));
    const names = [...html.matchAll(/class="rq-job-name">([^<]*)<\/span>/g)].map((match) => match[1]);
    assert.deepEqual(names, [i18next.t('common:status.node.fallback'), i18next.t('common:status.node.fallback'), 'Mon titre auteur']);
    if (language === 'fr') assert.equal(names[0], '(sans nom)');
    if (language === 'pseudo') assert.ok(names[0].startsWith('['));
    assert.equal(JSON.stringify(jobs), before);
  }
  await i18next.changeLanguage('fr');
});
