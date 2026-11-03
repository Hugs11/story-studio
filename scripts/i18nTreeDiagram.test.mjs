import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import { withBaseSourceAliases } from './baseSourceAliases.mjs';
import { ESLint } from 'eslint';
import react from '@vitejs/plugin-react';
import { createTestI18n } from './i18nTestSetup.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import { checkCatalogues, sourceHash } from './check-i18n.mjs';
import { installMountedDom, renderedText, click } from './treeMountedDom.mjs';

import fixture from './fixtures/tree-diagram-fr-base-sources.json' with { type: 'json' };
import { applyLot413, applyLot413Deep, LOT_413_TREE } from './i18nLot413Corrections.mjs';

const BASE = 'fcbfa8eb709f505185af5170e6873e9e98d07274';
const files = [
  ...['ContextMenu.jsx', 'TreeDisplayPopover.jsx', 'TreeDragOverlay.jsx', 'TreeNode.jsx', 'TreePanel.jsx', 'TreeSearchBar.jsx', 'treeContextMenuActions.jsx', 'useTreeNavigationBadges.js'].map(f => 'src/components/TreePanel/' + f),
  ...['NodeColorFilterChips.jsx', 'NodeColorPicker.jsx', 'nodeColorFilter.js', 'refDisplay.js', 'treeNavigationBadges.js'].map(f => 'src/components/tree/' + f),
  ...['DiagramPanel.jsx', 'FullDiagramNode.jsx', 'FullDiagramTree.jsx', 'flowDiagramLayout.js', 'fullDiagramFocus.js'].map(f => 'src/components/diagram/' + f),
  ...['DiagramLegend.jsx', 'DiagramSearch.jsx', 'DiagramViewToggles.jsx', 'DiagramZoomControls.jsx', 'StructureDiagramLayer.jsx', 'StructureFocusBar.jsx', 'StructureLevelSummaryNode.jsx', 'diagramContextMenu.jsx', 'diagramSearchFilter.js', 'diagramSelection.js', 'localEndStepPresentation.js', 'navigationPresentation.js', 'storyGroupLayout.js', 'structureLevelLayout.js', 'structurePresentation.js'].map(f => 'src/components/diagram/diagram/' + f),
  'src/store/projectModel/menuDepth.js', 'src/store/generatedNavigation.js',
];
const originalSources = new Map(Object.entries(fixture.sources));
const resources = createTestI18n().options.resources;
// Trans répartit les marqueurs pseudo entre composants nommés : accepter uniquement les fragments accentués exacts du catalogue riche.
const pseudoRichFragments = new Set(Object.entries(pseudoResources(resources.fr).tree).filter(([key]) => key.startsWith('diagram.stories.unit_')).flatMap(([, value]) => value.split(/<[^>]*>/).map(part => part.replace(/{{[^}]*}}/g, '').trim()).filter(Boolean)));
const metadata = JSON.parse(readFileSync('src/locales/_meta/tree.json', 'utf8'));
const baseCatalogue = fixture.catalogue;
const addedKeys = Object.keys(resources.fr.tree).filter(key => !Object.hasOwn(baseCatalogue, key));
const noop = () => {};
const author = 'Auteur « mon récit... »';
const story = { id: 's', type: 'story', name: author, controlSettings: {} };
const folder = { id: 'm', type: 'menu', name: '_AUTHOR_FOLDER_', children: [story] };
const project = { projectType: 'pack', rootName: '', projectName: '', rootEntries: [folder], globalOptions: {}, treeColor: '#e24b4a' };
const textValues = html => [...html.matchAll(/>([^<>]+)</g)].map(m => m[1])
  .concat([...html.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)].map(m => m[1]))
  .map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
// Fichiers de la BASE retirés depuis avec l'ancien nœud Lien : la BASE les importe
// encore, ils sont donc servis depuis le fixture pour le seul rendu de référence.
const removedSinceBase = files.filter(f => !existsSync(f));
async function serverFor(base = false) {
  return createServer({ configFile: false, plugins: [{ name: 'base-and-state-fixtures', enforce: 'pre', resolveId(source, importer) {
    if (!base || !importer || !source.startsWith('.')) return null;
    const absolute = path.resolve(path.dirname(importer), source);
    const file = removedSinceBase.find(f => [path.resolve(f), path.resolve(f).replace(/\.[jt]sx?$/, '')].includes(absolute));
    return file ? path.resolve(file) : null;
  }, load(id) {
    const file = base && removedSinceBase.find(f => path.normalize(id) === path.resolve(f));
    return file ? originalSources.get(file) : null;
  }, transform(code, id) {
    const file = files.find(f => id.endsWith('/' + f));
    if (base && file) code = originalSources.get(file);
    if (base) code = withBaseSourceAliases(code, id);
    if (id.endsWith('/DiagramSearch.jsx')) code = code.replace('const [active, setActive] = useState(false)', 'const [active, setActive] = useState(true)');
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}
async function components(server) {
  const result = {};
  for (const file of files.filter(f => f.endsWith('.jsx') && !f.includes('ContextMenuActions') && !f.includes('diagramContextMenu'))) Object.assign(result, await server.ssrLoadModule('/' + file));
  result.actions = await server.ssrLoadModule('/src/store/ProjectActionsContext.js');
  result.model = await server.ssrLoadModule('/src/store/projectModel/index.js');
  return result;
}
function wrap(component, props, modules, engine = i18next) {
  return React.createElement(I18nextProvider, { i18n: engine }, React.createElement(modules.actions.ProjectActionsContext.Provider, { value: {} }, React.createElement(component, props)));
}
const cases = [
  ['TreeSearchBar', { searchTerm: '', setSearchTerm: noop, inputRef: { current: null }, usedColors: [], selectedColors: new Set() }],
  ['TreeDisplayPopover', { open: false }],
  ['TreeDragOverlay', { entry: story }],
  ['NodeColorPicker', {}], ['NodeColorPicker', { currentColor: '__mixed__' }],
  ['NodeColorFilterChips', { colors: [{ color: '#e24b4a', label: '_AUTHOR_COLOR_', count: 1 }], selectedColors: new Set() }],
  ['NodeColorFilterChips', { colors: [{ color: '#e24b4a', label: '_AUTHOR_COLOR_', count: 2 }], selectedColors: new Set() }],
  // `referenceEdges` (liens, retirés) reste vide : seule la BASE le lit encore.
  ['DiagramLegend', { returnEdges: [{}], homeEdges: [{}], afterEndEdges: [{}], referenceEdges: [] }],
  ['DiagramViewToggles', { canFocusBranch: true, hasExpandedStoryGroups: true }],
  ['DiagramViewToggles', { canFocusBranch: false }],
  ['DiagramZoomControls', { zoom: 1 }],
  ['StructureFocusBar', { focus: { targetDepth: 2, parentLabel: '_AUTHOR_PARENT_', targetLabel: '_AUTHOR_TARGET_', breadcrumb: ['_AUTHOR_PARENT_', '_AUTHOR_TARGET_'] }, pinned: true }],
  ['StructureFocusBar', { focus: { targetDepth: 2, parentLabel: '_AUTHOR_PARENT_', targetLabel: '_AUTHOR_TARGET_', breadcrumb: [] }, pinned: false }],
  ...[1, 2].map(count => ['StructureLevelSummaryNode', { entry: { id: 'g', storyCount: count } }]),
  ['FullDiagramNode', { entry: { ...story, afterPlaybackSequence: [{}, {}] } }],
  ['FullDiagramNode', { entry: { id: 'm', type: 'menu', name: '' }, hasExpandedStoryGroup: true }],
  ['FullDiagramNode', { entry: { id: 'm', type: 'menu', name: '' }, draggingId: 's', dragOverContainerId: 'm', dragBlockedReason: 'menu_cycle' }],
  ['TreeNode', { id: 'm', type: 'menu', label: author, level: 2, renaming: true, renameValue: author }],
  ['TreeNode', { id: 'z', type: 'zip', label: author, level: 2 }],
  ['TreePanel', { project, projectType: 'pack', selectedId: 'root', selectedIds: new Set(['root']), validationIssues: [] }],
  ['DiagramSearch', { project, focusTrigger: 0 }],
  ['CompleteDiagramTree', { project, selectedId: 'root', selectedIds: new Set(['root']), showHint: true }],
  ['DiagramPanel', { project, projectType: 'pack', selectedId: 'root', selectedIds: new Set(['root']), showHint: true }],
  ...[1, 2].map(count => ['CompleteDiagramTree', { project: { ...project, rootEntries: [{ ...story, afterPlaybackSequence: Array.from({ length: count }, (_, i) => ({ id: 'step' + i, okTarget: 'story:s2' })) }, { id: 's2', type: 'story', name: '_AUTHOR_TARGET_' }] }, selectedId: 's', selectedIds: new Set(['s']) }]),
  ['CompleteDiagramTree', { project: { ...project, rootEntries: [{ ...story, afterPlaybackPromptAudio: '/_AUTHOR_AUDIO_', afterPlaybackPromptOkTarget: 'story:s2' }, { id: 's2', type: 'story', name: '_AUTHOR_TARGET_' }] }, selectedId: 's', selectedIds: new Set(['s']) }],

];

test('FR des surfaces arbre/diagramme contre git show BASE ; pseudo réellement rendu avec attributs accessibles', async () => {
  assert.equal(fixture.base, BASE);
  const dom = installMountedDom(); window.innerWidth = 1200; window.innerHeight = 900;
  const currentServer = await serverFor(), baseServer = await serverFor(true);
  i18next.init(createTestI18n().options);
  for (const [ns, data] of Object.entries(pseudoResources(resources.fr))) i18next.addResourceBundle('pseudo', ns, data);
  try {
    const current = await components(currentServer), original = await components(baseServer);
    let checked = 0;
    for (const [name, input] of cases) {
      const props = { ...input, projectIndex: current.model.buildProjectIndex(input.project ?? project) };
      await i18next.changeLanguage('fr');
      const fr = renderToStaticMarkup(wrap(current[name], props, current));
      const old = renderToStaticMarkup(wrap(original[name], { ...props, projectIndex: original.model.buildProjectIndex(input.project ?? project) }, original));
      assert.deepEqual(textValues(fr), applyLot413Deep(textValues(old), LOT_413_TREE), `FR ${name} ${JSON.stringify(input)}`);
      const before = JSON.stringify(props.project);
      for (const language of ['en', 'it', 'pseudo']) {
        await i18next.changeLanguage(language);
        const html = renderToStaticMarkup(wrap(current[name], props, current));
        assert.doesNotMatch(html, /tree:|\[object Object\]|{{/);
        if (language === 'pseudo') for (const value of textValues(html)) {
          if (!/\p{L}/u.test(value) || value.includes('_AUTHOR_') || value.includes('Auteur') || /^#[0-9a-f]{6}$/i.test(value) || value === 'ZIP') continue;
          assert.ok(value.includes('[') || pseudoRichFragments.has(value), `hors catalogue/pseudo ${name}: ${value}`);
        }
        assert.equal(JSON.stringify(props.project), before);
      }
      checked++;
    }
    assert.equal(checked, cases.length);
    const badges = [
      { kind: 'graph' }, { kind: 'continuation' }, { kind: 'continuation', sourceStoryName: '_AUTHOR_SOURCE_' },
      ...['return', 'sequence-return', 'prompt-return', 'home-none', 'home-implicit', 'home', 'end-node', 'end-night'].flatMap(kind => [{ kind, targetId: 'root' }, { kind, targetId: 'missing', isInactive: true }]),
      { kind: 'home-implicit' }, { kind: 'home', isEndHomeStep: true, targetId: 'root' },
    ];
    const currentBadges = await currentServer.ssrLoadModule('/src/components/tree/treeNavigationBadges.js');
    const originalBadges = await baseServer.ssrLoadModule('/src/components/tree/treeNavigationBadges.js');
    for (const data of badges) {
      await i18next.changeLanguage('fr');
      const props = { id: 's', type: 'story', label: '_AUTHOR_TITLE_', level: 1, navigationBadges: [currentBadges.formatBadgeTitle(data)] };
      const html = renderToStaticMarkup(wrap(current.TreeNode, props, current));
      const old = renderToStaticMarkup(wrap(original.TreeNode, { ...props, navigationBadges: [originalBadges.formatBadgeTitle(data)] }, original));
      assert.deepEqual(textValues(html), applyLot413Deep(textValues(old), LOT_413_TREE), `badge FR ${JSON.stringify(data)}`);
      await i18next.changeLanguage('pseudo');
      const pseudo = renderToStaticMarkup(wrap(current.TreeNode, { ...props, navigationBadges: [currentBadges.formatBadgeTitle(data)] }, current));
      for (const value of textValues(pseudo)) if (/\p{L}/u.test(value) && !value.includes('_AUTHOR_')) assert.ok(value.includes('['), `badge hors pseudo ${data.kind}: ${value}`);
    }
    const menus = await currentServer.ssrLoadModule('/src/components/TreePanel/treeContextMenuActions.jsx');
    const oldMenus = await baseServer.ssrLoadModule('/src/components/TreePanel/treeContextMenuActions.jsx');
    const diagramMenus = await currentServer.ssrLoadModule('/src/components/diagram/diagram/diagramContextMenu.jsx');
    const oldDiagramMenus = await baseServer.ssrLoadModule('/src/components/diagram/diagram/diagramContextMenu.jsx');
    const menuProject = { ...project, rootEntries: [{ ...folder, children: [{ ...story, audio: '/_AUTHOR_AUDIO_', image: '/_AUTHOR_IMAGE_' }, { id: 's2', type: 'story', name: '_AUTHOR_SECOND_', audio: '/_AUTHOR_SECOND_AUDIO_' }, { id: 'z', type: 'zip', name: '_AUTHOR_ARCHIVE_', zipPath: '/_AUTHOR_ZIP_' }] }] };
    const menuIndex = current.model.buildProjectIndex(menuProject);
    for (const surface of [currentServer, baseServer]) {
      const clipboards = await surface.ssrLoadModule('/src/store/fieldClipboard.js');
      clipboards.audioClipboard.set(['/_AUTHOR_AUDIO_', '/_AUTHOR_SECOND_AUDIO_'], { mode: 'cut' }); clipboards.imageClipboard.set('/_AUTHOR_IMAGE_', { mode: 'copy' });
    }
    const callbacks = Object.fromEntries(['onAddMenu', 'onAddStory', 'onImportFolder', 'onAddEndNode', 'onRemoveEndNode', 'onDemoteRootToMenu', 'onSetMenuAsRoot', 'onSimulateZip', 'onUnpackZip', 'onSimulateNode', 'onMoveToMenu', 'onDuplicate', 'onDeleteMenu', 'onDeleteItem', 'onBulkDeleteItems', 'onBulkUpdateItems', 'onSetNodeColor', 'onOpenMediaAudioTool', 'closeContextMenu', 'callOnSelect', 'onSelectionChange', 'handleCopy', 'handleCut', 'handlePaste', 'handlePasteMedia', 'handleReplaceAudio', 'handleDeleteSelection', 'onUpdateMedia', 'onUpdateMenu', 'onUpdateItem'].map(name => [name, noop]));
    for (const [nodeType, nodeId] of [['root', 'root'], ['root-bg', 'root'], ['menu', 'm'], ['story', 's'], ['zip', 'z'], ['end-node', 'end-node']]) for (const multi of [false, true]) {
      const props = { ...callbacks, nodeType, nodeId, project: menuProject, projectIndex: menuIndex, projectType: 'pack', selectedIds: new Set(multi ? ['s', 's2'] : [nodeId]), getEntry: id => menuIndex.entryById.get(id), getParentId: id => menuIndex.parentMenuById.get(id), getTopLevelSelected: () => multi ? ['s', 's2'] : [nodeId], clipboardRef: { current: { entries: [folder], isCut: false } } };
      for (const [build, oldBuild] of [[menus.buildTreeContextActions, oldMenus.buildTreeContextActions], [diagramMenus.buildDiagramContextActions, oldDiagramMenus.buildDiagramContextActions]]) {
        await i18next.changeLanguage('fr');
        const html = renderToStaticMarkup(wrap(current.ContextMenu, { x: 0, y: 0, actions: build(props) }, current));
        const old = renderToStaticMarkup(wrap(original.ContextMenu, { x: 0, y: 0, actions: oldBuild(props) }, original));
        assert.deepEqual(textValues(html), applyLot413Deep(textValues(old), LOT_413_TREE), `menu FR ${nodeType}/${multi}`);
        await i18next.changeLanguage('pseudo');
        const pseudo = renderToStaticMarkup(wrap(current.ContextMenu, { x: 0, y: 0, actions: build(props) }, current));
        for (const value of textValues(pseudo)) if (/\p{L}/u.test(value) && !value.includes('_AUTHOR_') && !/^#[0-9a-f]{6}$/i.test(value)) assert.ok(value.includes('['), `menu hors pseudo ${nodeType}/${multi}: ${value}`);
      }
    }

  } finally { await currentServer.close(); await baseServer.close(); dom.restore(); }
});

test('FR catalogue ancien intact ; métadonnées nouvelles et mutation de fuite FR dans chaque traduction', () => {
  // Lot 4.13 : valeurs FR corrigées volontairement (typographie, pluriels, vocabulaire), listées au rapport.
  const lot413 = {
    "audio.record.action": "Enregistrer l’audio",
    "audio.play.seek": "Se déplacer dans l’audio",
    "audio.field.removeAudio": "Retirer l’audio de ce champ",
    "audio.edit.action": "Éditer l’audio",
    "audio.unsaved.voiceNotice": "L’audio généré sera stocké dans <strong>{{directory}}</strong>. Enregistre d’abord le projet pour pouvoir utiliser XTTS.",
    "audio.unsaved.recordNotice": "L’audio sera stocké dans <strong>{{directory}}</strong>. Enregistre d’abord le projet pour pouvoir enregistrer.",
    "audio.file.replace": "Remplacer l’audio…",
    "media.file.reveal": "Afficher dans l’explorateur",
    "zip.export.notice": "Ce pack sera inclus tel quel dans l’export final, sans modifications audio.",
    "endNode.audio.label": "Audio de fin d’histoire",
    "endNode.home.description": "Destination si l’enfant appuie sur Accueil pendant le message de fin.",
    "menu.wheel.description": "L’enfant peut parcourir les histoires de ce dossier avec la molette.",
    "menu.autoplay.description": "Après l’audio de sélection, enchaîne automatiquement vers le contenu du dossier, sans appui sur OK.",
    "menu.pause.description": "L’enfant peut mettre en pause l’audio de sélection du dossier.",
    "menu.card.description": "Page de choix où l’enfant sélectionne une histoire à la molette. Configure ici son nom, son visuel et l’audio d’invitation.",
    "menu.audio.description": "Invite l’enfant à choisir une histoire",
    "menu.audio.subtitle": "Audio de sélection — invite l’enfant à choisir une histoire",
    "menu.settings.description": "Règle ce que l’enfant peut faire sur cet Écran de choix.",
    "menu.linear.description": "Tant que ce dossier reste l’unique élément du Menu racine et ne contient pas plusieurs éléments, le pack généré impose la Lecture automatique et désactive la Molette. Place au moins deux éléments dans ce dossier, ou ajoute un autre élément au Menu racine, pour modifier ces deux réglages.",
    "menu.image.transparentDescription": "Aucune image ne sera affichée pendant la lecture de l’audio de sélection.",
    "multi.autoplay.description": "Après l’audio de présentation, enchaîne automatiquement vers le contenu du dossier, sans attendre OK",
    "multi.titlePause.description": "Autorise la pause pendant l’audio de présentation",
    "multi.root.label": "Menu racine",
    "story.during.title": "Pendant l’histoire",
    "multi.generation.description": "Crée d’un coup une image-titre pour chaque histoire ou dossier avec image sélectionné, ou un audio (le nom prononcé) pour les éléments sélectionnés compatibles. Les packs ZIP importés sont ignorés.",
    "multi.generation.audioDescription": "Crée d’un coup un audio (le nom prononcé) pour les éléments sélectionnés compatibles. Les images-titres ne sont proposées que pour les histoires et les dossiers avec image.",
    "story.during.description": "Choisis les boutons utilisables pendant la lecture de l’histoire.",
    "story.pause.enabled": "L’enfant peut utiliser le bouton pause pendant l’histoire.",
    "story.pause.disabled": "L’enfant ne peut pas utiliser le bouton pause pendant l’histoire.",
    "story.home.enabled": "L’enfant peut appuyer sur le bouton Accueil pendant l’histoire.",
    "story.home.disabled": "L’enfant ne peut pas appuyer sur le bouton Accueil pendant l’histoire.",
    "multi.linear.description": "Le dossier linéaire placé seul sous le Menu racine conserve ses valeurs imposées : Lecture automatique activée et Molette désactivée. Les modifications groupées de ces deux réglages s’appliquent uniquement aux autres dossiers sélectionnés.",
    "multi.image.none": "Pas d’image",
    "multi.image.description": "Ces dossiers n’envoient aucune image à la Lunii — l’écran conserve l’affichage précédent pendant la sélection.",
    "multi.home.description": "Destination quand l’enfant appuie sur Accueil pendant la lecture. Sans réglage spécifique : retour au dossier parent.",
    "multi.message.description": "La Lunii continue automatiquement après chaque audio d’histoire pour jouer ce message. Pour modifier la destination, sélectionne le message de fin dans l’arbre à gauche.",
    "multi.message.managedDescription": "La destination après chaque histoire est gérée par le message de fin du pack. Pour la modifier, sélectionne le message de fin dans l’arbre à gauche.",
    "story.end.stay": "Rester sur l’Écran",
    "story.route.waiting": "Attente sur l’Écran",
    "story.destination.afterStory": "Destination après l’histoire",
    "story.destination.description": "L’écran ou le menu affiché à la sortie automatique.",
    "multi.destination.title": "Destination de fin d’histoire",
    "multi.destination.description": "Destination à la fin de l’histoire — suit le dossier parent si rien n’est choisi ici.",
    "multi.selection.mixed": "Sélection mixte (histoires et dossiers) — seuls les contrôles de lecture peuvent être modifiés en groupe ici. Pour le reste, sélectionne un seul type d’élément à la fois.",
    "nativeGraph.kind.stage": "Écran",
    "nativeGraph.filter.placeholder": "Filtrer les Écrans",
    "nativeGraph.list.aria": "Écrans du graphe importé",
    "nativeGraph.image.label": "Image de l’Écran",
    "nativeGraph.audio.label": "Audio de l’Écran",
    "root.autoNext.description": "Enchaîne automatiquement les histoires et ignore les messages, scénarios et retours de fin tant que l’option est active.",
    "root.graph.description": "Ce pack utilise une structure interactive, avec des parcours qui se rejoignent et des retours Accueil explicites. Les Écrans ci-dessous seront conservés à l’identique lors d’un nouvel export.",
    "root.simple.description": "Tu crées un pack contenant une seule histoire. Pour des menus, plusieurs histoires ou une navigation personnalisée, utilise plutôt l’« Éditeur par menus ».",
    "root.pack.identity": "Menu racine",
    "root.simple.mediaDescription": "Image et audio utilisés quand l’enfant choisit cette histoire.",
    "root.pack.mediaDescription": "Image et audio utilisés quand l’enfant choisit ce pack.",
    "story.name.label": "Nom de l’histoire",
    "root.name.example": "Le loup et l’agneau",
    "root.simple.imageDescription": "Visuel utilisé pour présenter l’histoire",
    "story.image.generateHint": "Créer une image-titre à partir du nom de l’histoire",
    "root.story.settings": "Réglages de l’histoire",
    "root.story.description": "S’appliquent à tout le pack. Le simulateur suit ces réglages.",
    "root.autoNext.active": "Toutes les histoires s’enchaînent automatiquement",
    "root.narrative.description": "Le fichier audio joué quand l’enfant valide son choix sur la Lunii — c’est l’histoire en elle-même.",
    "root.narrative.audioDescription": "Joué quand l’enfant valide son choix",
    "story.card.title": "L’histoire",
    "story.audio.subtitle": "Audio de sélection puis lecture de l’histoire",
    "story.selection.description": "Énoncé quand l’enfant parcourt les histoires",
    "story.narrative.description": "Écoutée quand l’enfant valide son choix",
    "story.delete.description": "L’histoire et ses transitions sont retirées du pack. Ses fichiers restent dans l’onglet Médias, sans être supprimés du disque.",
    "story.autoNext.nextDescription": "Auto-next est activé dans les réglages de l’histoire du Menu racine : la sortie automatique lance directement l’histoire suivante.",
    "story.autoNext.lastDescription": "Auto-next est activé dans les réglages de l’histoire du Menu racine : aucune histoire suivante, la sortie automatique revient au dossier.",
    "story.next.fallback": "l’histoire suivante",
    "story.endAudio.sharedDescription": "Cette histoire utilise l’audio commun défini dans le message de fin du pack.",
    "story.endAudio.autoNextDescription": "Ignoré tant qu’Auto-next est activé : l’histoire passe directement à la destination auto-next.",
    "story.endAudio.description": "Joué à la fin de l’histoire",
    "story.endAudio.hint": "Un seul audio joué à la fin (ex : « Bravo, l’histoire est finie ! »)",
    "story.destination.inherited": "Comme à la fin de l’histoire",
    "story.sequence.description": "Séquence jouée après la fin de l’histoire, avant la destination suivante.",
    "story.end.aria": "Comportement à la fin de l’histoire",
    "story.titleAutoplay.label": "Lancer l’histoire automatiquement",
    "story.titleAutoplay.description": "L’histoire se lance toute seule à la fin de l’audio de sélection, sans attendre que l’enfant appuie sur OK.",
    "story.titleOk.description": "L’enfant peut appuyer sur OK pour lancer l’histoire.",
    "story.titleHome.description": "L’enfant peut revenir au menu parent en appuyant sur le bouton Accueil.",
    "story.titlePause.description": "L’enfant peut mettre en pause l’audio de sélection.",
    "story.titleWheel.description": "L’enfant peut tourner la molette pour parcourir les autres histoires.",
    "story.home.returnMenu": "Retour au menu parent",
    "story.selection.controlsDescription": "Boutons actifs pendant l’audio de sélection, avant que l’histoire ne commence.",
    "story.selection.silentDescription": "Ne joue aucun audio de sélection avant le lancement de l’histoire.",
    "story.home.creationName": "Écran d’attente",
    "story.sequence.okDescription": "Bouton OK enchaîne vers l’étape suivante.",
    "story.home.description": "Étape jouée si l’enfant appuie sur le bouton Accueil pendant l’histoire, avant qu’elle ne se termine.",
    "story.home.audioLabel": "Audio joué quand l’enfant appuie sur Accueil",
    "navigation.nextStory.context": "Histoire suivante selon l’histoire source",
    "metadata.version.default": "v1 par défaut à la génération",
    "metadata.save.held": "Un export est en cours. La saisie est conservée ; clique de nouveau sur « Appliquer » une fois l’export terminé.",
    "metadata.save.stale": "Le projet a changé pendant l’application. Vérifie les valeurs avant de réessayer.",
    "metadata.save.refused": "La modification a été refusée et rien n’a été écrit. La saisie est conservée.",
    "metadata.save.notApplied": "La modification n’a pas été appliquée. La saisie est conservée.",
    "story.sequence.confirmDelete": "Supprimer l’étape « {{name}} » ?",
    "menu.continuation.description": "Suite du parcours importée depuis {{name}}{{step}}.",
    "menu.graph.description": "Graphe interactif d’origine inclus dans ce pack extrait : {{stages}}, {{actions}}.",
    "multi.audio.failed": "{{name}} : impossible d’ajouter la synthèse vocale XTTS à la file",
    "story.sequence.continuation": "Cette étape mène vers la continuation importée « {{name}} »{{source}}.",
    "image.reference.use": "Utiliser l’image déjà présente dans {{label}}",
    "media.nativeMenu.label": "graphe natif : {{name}}",
    "media.native.audio": "Audio {{group}} : {{name}}",
    "media.native.image": "Image {{group}} : {{name}}",
    "media.menu.audio": "Audio menu : {{name}}",
    "media.menu.image": "Image menu : {{name}}",
    "media.zip.archive": "ZIP : {{name}}",
    "media.story.audio": "Audio histoire : {{name}}",
    "media.story.titleAudio": "Titre audio : {{name}}",
    "media.story.image": "Image histoire : {{name}}",
    "media.story.endAudio": "Audio fin histoire : {{name}}",
    "media.sequence.audio": "Audio fin histoire {{number}} : {{name}}",
    "media.sequence.image": "Image fin histoire {{number}} : {{name}}",
    "media.home.audio": "Audio fin histoire home : {{name}}",
    "media.home.image": "Image fin histoire home : {{name}}",
    "count.stages.label_one": "{{count}} Écran",
    "count.stages.label_many": "{{count}} Écrans",
    "count.stages.label_other": "{{count}} Écrans",
    "count.actions.label_one": "{{count}} liste de choix",
    "count.actions.label_many": "{{count}} listes de choix",
    "count.actions.label_other": "{{count}} listes de choix",
    "menu.delete.contents_one": "Le dossier sera retiré du projet avec {{count}} élément qu’il contient. Les médias resteront dans l’onglet Médias.",
    "menu.delete.contents_many": "Le dossier sera retiré du projet avec les {{count}} éléments qu’il contient. Les médias resteront dans l’onglet Médias.",
    "menu.delete.contents_other": "Le dossier sera retiré du projet avec les {{count}} éléments qu’il contient. Les médias resteront dans l’onglet Médias.",
    "multi.color.mixed_one": "{{count}} élément sélectionné — choisis une couleur.",
    "multi.color.mixed_many": "Couleurs différentes sur {{count}} éléments — choisis-en une pour les uniformiser.",
    "multi.color.mixed_other": "Couleurs différentes sur {{count}} éléments — choisis-en une pour les uniformiser.",
    "multi.color.description_one": "Pastille affichée à gauche du nom dans l’arbre ({{count}} élément).",
    "multi.color.description_many": "Pastille affichée à gauche du nom dans l’arbre ({{count}} éléments).",
    "multi.color.description_other": "Pastille affichée à gauche du nom dans l’arbre ({{count}} éléments).",
    "endPlayback.mixed.waiting_one": "{{count}} histoire attend un appui sur OK",
    "endPlayback.mixed.auto_one": "{{count}} continue automatiquement",
    "endPlayback.mixed.stays_one": " · {{count}} reste sur le message",
    "navigation.root.short": "Menu racine",
    "nativeGraph.count.stages_one": "<strong>{{count}}</strong><unit>Écran</unit>",
    "nativeGraph.count.stages_many": "<strong>{{count}}</strong><unit>Écrans</unit>",
    "nativeGraph.count.stages_other": "<strong>{{count}}</strong><unit>Écrans</unit>",
    "nativeGraph.count.actions_one": "<strong>{{count}}</strong><unit>liste de choix</unit>",
    "nativeGraph.count.actions_many": "<strong>{{count}}</strong><unit>listes de choix</unit>",
    "nativeGraph.count.actions_other": "<strong>{{count}}</strong><unit>listes de choix</unit>",
    "nativeGraph.control.wheel": "Molette",
    "nativeGraph.control.autoplay": "Lecture automatique",
    "nativeGraph.control.pause": "Pause",
    "nativeGraph.control.ok": "OK",
    "nativeGraph.control.home": "Accueil",
    "media.stage.fallback": "Écran",
  };
  // Retirées volontairement avec l'ancien nœud Lien (type `ref`) : absentes, pas modifiées.
  const removedWithLegacyLink = new Set(Object.keys(baseCatalogue).filter(key => key.startsWith('ref.')));
  assert.equal(removedWithLegacyLink.size, 11);
  for (const key of [...removedWithLegacyLink, 'ref.target.unknown', 'diagram.route.reference', 'diagram.legend.links']) assert.equal(Object.hasOwn(resources.fr.tree, key), false, key);
  for (const [key, text] of Object.entries(baseCatalogue)) if (!removedWithLegacyLink.has(key)) assert.equal(resources.fr.tree[key], lot413[key] ?? text, key);
  const catalogue = Object.fromEntries(['fr', 'en', 'it'].map(l => [l, { tree: resources[l].tree }]));
  const neutral = new Set(['nodeType.zip', 'display.option.aria', 'context.disabled.aria']);
  assert.ok(addedKeys.length > 150);
  assert.deepEqual(checkCatalogues(catalogue, { tree: metadata }).errors, []);
  assert.equal(checkCatalogues(catalogue, { tree: metadata }).warnings.filter(w => w.includes('diagram.stories.unit')).length, 0);
  for (const key of addedKeys) {
    assert.ok(metadata[key].context.includes(key), key);
    if (metadata[key].maxLength !== undefined) assert.ok(Number.isInteger(metadata[key].maxLength) && metadata[key].maxLength > 0);
    for (const language of ['en', 'it']) {
      if (resources[language].tree[key] === undefined) { assert.equal(language, 'en'); assert.ok(key.endsWith('_many')); continue; }
      assert.equal(metadata[key][language].status, 'ai-reviewed'); assert.equal(metadata[key][language].sourceHash, sourceHash(resources.fr.tree[key]));
      // Relecture Opus : mots identiques dans la langue cible, déclarés aussi dans TREE_NEUTRAL_KEYS.
      if (['color.orange.label', 'diagram.focus.short'].includes(key)) continue;
      // Lot 4.13 : neutres d’une seule langue (TREE_LANGUAGE_NEUTRAL_KEYS).
      if ({ en: ['nativeGraph.control.pause', 'nativeGraph.control.ok'], it: ['context.file.audio', 'nativeGraph.control.ok'] }[language].includes(key)) continue;
      if (neutral.has(key)) { assert.ok(!/\p{L}/u.test(resources.fr.tree[key].replace(/{{.*?}}/g, '')) || resources.fr.tree[key] === 'ZIP'); continue; }
      assert.notEqual(resources[language].tree[key], resources.fr.tree[key]);
      const mutated = structuredClone(catalogue); mutated[language].tree[key] = resources.fr.tree[key];
      assert.ok(checkCatalogues(mutated, { tree: metadata }).errors.some(e => e.includes(`${language}/tree:${key} règle d’or`)), `${language}/${key}`);
    }
  }
  assert.equal(resources.fr.common['project.saveAs.fallbackLabel'], 'Enregistrer sous…');
});

test('pluriels du lot : 0, 1, 2, un million ; catégories, codes/paramètres et logique protégée identique à BASE', async () => {
  const engine = createTestI18n();
  for (const language of ['fr', 'en', 'it']) {
    await engine.changeLanguage(language);
    for (const base of addedKeys.filter(k => k.endsWith('_one')).map(k => k.slice(0, -4))) for (const count of [0, 1, 2, 1_000_000]) {
      const params = { count, label: '_AUTHOR_COLOR_' }, category = new Intl.PluralRules(language).select(count);
      assert.ok(Object.hasOwn(resources[language].tree, `${base}_${category}`));
      const value = engine.t('tree:' + base, params); assert.ok(value.includes(String(count))); assert.doesNotMatch(value, /{{|tree:/);
    }
  }
  assert.equal(engine.t('tree:diagram.sequence.stepCount', { lng: 'en', count: 1 }), 'End sequence · 1 step');
  assert.equal(engine.t('tree:diagram.sequence.stepCount', { lng: 'it', count: 1 }), 'Sequenza finale · 1 fase');
  // Comparaison textuelle exhaustive du miroir, sauf l’import et le repli autorisés.
  const changed = readFileSync('src/store/generatedNavigation.js', 'utf8')
    .replace("import { translateTree as t } from '../i18n/treePresentation.js';\n", '')
    .replace("firstEntry.name || t('tree:navigation.name.fallback')", "firstEntry.name || '(sans nom)'");
  assert.equal(changed, originalSources.get('src/store/generatedNavigation.js'));
  const { validateMenuDepthPlacement, MAX_MENU_DEPTH, ProjectMenuDepthError } = await import('../src/store/projectModel/menuDepth.js');
  const chain = count => count ? { id: 'm' + count, type: 'menu', children: count > 1 ? [chain(count - 1)] : [] } : story;
  const rejected = validateMenuDepthPlacement({ rootEntries: [] }, null, [chain(MAX_MENU_DEPTH + 1)]);
  assert.equal(rejected.code, 'VALIDATION_MENU_DEPTH_LIMIT'); assert.equal(rejected.attemptedDepth, MAX_MENU_DEPTH + 1); assert.equal(rejected.maxDepth, MAX_MENU_DEPTH);
  const error = new ProjectMenuDepthError(rejected);
  assert.equal(error.code, 'VALIDATION_MENU_DEPTH_LIMIT'); assert.deepEqual(error.params, { observedDepth: MAX_MENU_DEPTH + 1, maxDepth: MAX_MENU_DEPTH });
  assert.notEqual(validateMenuDepthPlacement({ rootEntries: [] }, null, [chain(1)]).code, 'VALIDATION_MENU_DEPTH_LIMIT');
});

test('React monté FR → EN → IT : popover/menu ouverts, tables précréées, titres auteur et sérialisation/undo intacts', async () => {
  assert.equal(fixture.base, BASE);
  const dom = installMountedDom(); window.innerWidth = 1200; window.innerHeight = 900;
  const server = await serverFor(); const host = dom.document.createElement('div');
  Object.getPrototypeOf(host).getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });
  Object.defineProperty(Object.getPrototypeOf(host), 'clientWidth', { configurable: true, get: () => 1000 });
  Object.defineProperty(Object.getPrototypeOf(host), 'clientHeight', { configurable: true, get: () => 800 });
  const previousResize = globalThis.ResizeObserver, previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.cancelAnimationFrame = clearTimeout;
  dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const modules = await components(server);
    const colorsModule = await server.ssrLoadModule('/src/components/tree/nodeColorFilter.js');
    const colors = colorsModule.buildUsedNodeColors(['#e24b4a', '#e24b4a']);
    const layout = await server.ssrLoadModule('/src/components/diagram/flowDiagramLayout.js');
    const { useTreeTranslation } = await server.ssrLoadModule('/src/i18n/useTreeTranslation.jsx');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    let store;
    const actions = [{ label: { key: 'tree:context.node.copy' }, fn: noop, shortcut: 'Ctrl+C' }];
    function Mounted() {
      store = useProjectStore(); useTreeTranslation();
      const index = modules.model.buildProjectIndex(store.readProject());
      return React.createElement(React.Fragment, null,
        React.createElement(modules.TreeDisplayPopover, { open: true }),
        React.createElement(modules.ContextMenu, { x: 0, y: 0, actions }),
        React.createElement(modules.NodeColorFilterChips, { colors, selectedColors: new Set() }),
        React.createElement(modules.DiagramSearch, { project: store.readProject(), projectIndex: index }),
        React.createElement('p', null, layout.TYPE_LABELS.root),
        React.createElement('p', null, store.readProject().rootEntries[0]?.name),
        React.createElement(modules.TreePanel, { project: store.readProject(), projectIndex: index, projectType: 'pack', selectedId: 'root', selectedIds: new Set(['root']), validationIssues: [] }),
        React.createElement(modules.actions.ProjectActionsContext.Provider, { value: {} }, React.createElement(modules.CompleteDiagramTree, { project: store.readProject(), projectIndex: index, selectedId: 'root', selectedIds: new Set(['root']), showHint: true })));
    }
    await act(async () => { root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Mounted))); });
    await act(async () => { store.setProjectType('pack'); store.addMenu(null); store.updateMenu(store.readProject().rootEntries[0].id, { name: author }); store.markPristine(); });
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark();
    const dialog = dom.document.body.querySelector('.tree-display-popover'), menu = host.querySelector('.ctx-menu'); assert.ok(dialog); assert.ok(menu);
    for (const [language, color, rootLabel] of [['fr', 'Rouge', 'Menu racine'], ['en', 'Red', 'Top menu'], ['it', 'Rosso', 'Menu iniziale']]) {
      await act(async () => { await engine.changeLanguage(language); });
      assert.equal(dom.document.body.querySelector('.tree-display-popover'), dialog); assert.equal(host.querySelector('.ctx-menu'), menu);
      assert.ok(dialog.textContent.includes(engine.t('tree:display.badges.label'))); assert.ok(menu.textContent.includes(engine.t('tree:context.node.copy')));
      assert.equal(colors[0].label, color); assert.equal(layout.TYPE_LABELS.root, rootLabel);
      assert.ok(renderedText(host).includes(color)); assert.ok(host.textContent.includes(author));
      assert.ok(host.querySelector('.tree')); assert.ok(host.querySelector('.fd-complete-stage'));
      assert.ok(host.textContent.includes(engine.t('tree:diagram.settings.hint')));
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
    }
  } finally { await act(async () => root.unmount()); await server.close(); dom.restore();
    if (previousResize === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previousResize;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previousCancel;
  }
});


test('présentateur des cibles : parité FR avec les helpers BASE, noms auteur jamais retraduits en EN/IT', async () => {
  const current = await serverFor(), original = await serverFor(true);
  i18next.init(createTestI18n().options);
  try {
    const { presentTreeNavigationTargetName } = await current.ssrLoadModule('/src/i18n/treePresentation.js');
    const old = await original.ssrLoadModule('/src/store/generatedNavigation.js');
    const index = { entryById: new Map([['a', { name: 'Racine' }], ['b', { name: 'Histoire suivante' }]]) };
    for (const target of [null, 'root', 'next_story', '__contextual_next_story__', 'a', 'b', 'missing', 'story:a', 'story_play:a', 'story_home_step:b']) {
      // Lot 4.13 : la cible « root » s’affiche « Menu racine » (le nom d’auteur « Racine » reste intact).
      assert.equal(presentTreeNavigationTargetName(target, index), applyLot413(old.getGeneratedNavigationTargetName(target, index), target === 'root' ? [[/^Racine$/, 'Menu racine']] : []), String(target));
    }
    for (const language of ['en', 'it']) {
      await i18next.changeLanguage(language);
      assert.equal(presentTreeNavigationTargetName('a', index), 'Racine');
      assert.equal(presentTreeNavigationTargetName('b', index), 'Histoire suivante');
      assert.notEqual(presentTreeNavigationTargetName('root', index), 'Racine');
      assert.notEqual(presentTreeNavigationTargetName('next_story', index), 'Histoire suivante');
      assert.notEqual(presentTreeNavigationTargetName('missing', index), 'destination introuvable');
    }
  } finally { await current.close(); await original.close(); }
});


test('tous les fichiers autorisés sont protégés par no-literal-string en error', async () => {
  const eslint = new ESLint();
  for (const filePath of files) {
    const [result] = await eslint.lintText("export const fixture = 'Mon histoire';", { filePath });
    const errors = result.messages.filter(message => message.ruleId === 'i18next/no-literal-string');
    assert.ok(errors.length > 0, filePath); assert.ok(errors.every(message => message.severity === 2), filePath);
  }
});

test('unité du groupe replié réellement rendue : FR historique et accord EN/IT pour 0, 1, 2, un million', async () => {
  const server = await serverFor(); i18next.init(createTestI18n().options);
  try {
    const { StructureLevelSummaryNode } = await server.ssrLoadModule('/src/components/diagram/diagram/StructureLevelSummaryNode.jsx');
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      for (const count of [0, 1, 2, 1_000_000]) {
        const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: i18next }, React.createElement(StructureLevelSummaryNode, { entry: { id: 'g', storyCount: count } })));
        const number = html.match(/class="fd-structure-summary-count">([^<]*)</)?.[1];
        const unit = html.match(/class="fd-structure-summary-label">([^<]*)</)?.[1];
        assert.equal(number, String(count));
        assert.equal(unit, language === 'fr' ? (count <= 1 ? 'histoire' : 'histoires') : language === 'en' ? count === 1 ? 'story' : 'stories' : count === 1 ? 'storia' : 'storie');
        assert.doesNotMatch(html, /tree:|\[object Object\]|{{/);
      }
    }
  } finally { await server.close(); }
});

test('vrai dialogue de refus ouvert : profondeur et collage, codes/paramètres, FR → EN → IT sans dirty/undo', async () => {
  const dom = installMountedDom(); const server = await serverFor();
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    const { ErrorDialogProvider, useErrorDialog } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const depth = await server.ssrLoadModule('/src/store/projectModel/menuDepth.js');
    const { makeDepthProject } = await server.ssrLoadModule('/scripts/fixtures/projectDepthFixtures.js');
    let store; const refusals = [];
    function Mounted() {
      store = useProjectStore();
      const { showErrorDialog } = useErrorDialog();
      React.useEffect(() => {
        if (!store.mutationError) return;
        refusals.push(store.mutationError);
        showErrorDialog(depth.getMenuMutationDialog(store.mutationError));
        store.clearMutationError();
      }, [showErrorDialog, store.clearMutationError, store.mutationError]);
      return null;
    }
    await act(async () => { root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(ErrorDialogProvider, null, React.createElement(Mounted)))); });
    for (const kind of ['depth', 'cycle']) {
      await act(async () => { await engine.changeLanguage('fr'); store.loadProject(makeDepthProject(kind === 'depth' ? depth.MAX_MENU_DEPTH : 3)); store.markPristine(); });
      const before = JSON.stringify(store.readProject()), history = store.readHistoryMark(), pristine = store.isPristine();
      let rejection;
      await act(async () => {
        if (kind === 'depth') { assert.equal(store.addMenu('folder-' + depth.MAX_MENU_DEPTH), null); }
        else rejection = store.cutPasteEntriesToMenu(['folder-1'], 'folder-2');
      });
      assert.equal(store.mutationError, null, 'l’erreur a été consommée, seules les références restent dans la demande de dialogue');
      const refusal = refusals.at(-1);
      assert.equal(refusal.code, kind === 'depth' ? 'VALIDATION_MENU_DEPTH_LIMIT' : 'menu_cycle');
      if (kind === 'depth') {
        assert.deepEqual(refusal.messageRef, { key: 'tree:depth.limit.reached', params: { maxDepth: depth.MAX_MENU_DEPTH } });
        assert.equal(refusal.attemptedDepth, depth.MAX_MENU_DEPTH + 1); assert.equal(refusal.maxDepth, depth.MAX_MENU_DEPTH);
        assert.notEqual(refusal.code, 'menu_cycle');
      }
      if (kind === 'cycle') {
        assert.notEqual(rejection.code, 'VALIDATION_MENU_DEPTH_LIMIT');
        assert.equal(rejection.code, 'menu_cycle'); assert.equal(rejection.allowed, false);
        assert.deepEqual(rejection.titleRef, { key: 'tree:depth.paste.title' });
        assert.deepEqual(rejection.messageRef, { key: 'tree:depth.paste.message' });
      }
      const dialog = dom.document.body.querySelector('.dialog-panel'); assert.ok(dialog);
      const texts = kind === 'depth' ? [
        ['fr', 'Limite d’imbrication', `Limite de ${depth.MAX_MENU_DEPTH} Dossiers imbriqués atteinte.`],
        ['en', 'Nesting limit', `You’ve reached the limit of ${depth.MAX_MENU_DEPTH} nested folders.`],
        ['it', 'Limite di annidamento', `Hai raggiunto il limite di ${depth.MAX_MENU_DEPTH} cartelle annidate.`],
      ] : [
        ['fr', 'Collage impossible', 'Un Dossier ne peut pas être collé dans lui-même ni dans l’un de ses sous-dossiers. Il est toujours coupé : choisis un autre emplacement.'],
        ['en', 'Cannot paste', 'You can’t paste a folder into itself or one of its subfolders. It is still ready to move. Choose another location to paste it.'],
        ['it', 'Impossibile incollare', 'Non puoi incollare una cartella in sé stessa o in una delle sue sottocartelle. Puoi ancora spostarla: scegli un’altra posizione in cui incollarla.'],
      ];
      for (const [language, title, message] of texts) {
        await act(async () => { await engine.changeLanguage(language); });
        assert.equal(dom.document.body.querySelector('.dialog-panel'), dialog);
        assert.equal(dialog.querySelector('h2').textContent, title); assert.equal(dialog.querySelector('.dialog-message').textContent, message);
        assert.doesNotMatch(dialog.textContent, /tree:|\[object Object\]|{{/);
        assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), history); assert.equal(store.isPristine(), pristine);
      }
      // Le retour legacy contient encore sa phrase FR, mais le présentateur transporte la référence intacte.
      if (kind === 'cycle') assert.equal(depth.getMenuMutationDialog(rejection).message, rejection.messageRef);
      await act(async () => { click(dialog.querySelector('.dialog-actions').querySelector('button')); });
    }
  } finally { await act(async () => root.unmount()); await server.close(); dom.restore(); }
});
