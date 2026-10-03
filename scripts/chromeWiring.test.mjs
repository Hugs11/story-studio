// Les branchements du chrome.
//
// Ce que ces tests gardent est étroit et volontairement peu ambitieux : le
// chrome — barre du haut, barre d'outils, bande basse — annonce des commandes,
// et chacune doit être reliée à un gestionnaire, dans les **deux** éditeurs.
// Rien ici ne regarde une apparence, une couleur ou une position.
//
// Pourquoi ils existent. La pastille du pack de la barre du haut a cessé de se
// rendre : `AppShell` tendait `packMetadata` à une barre qui lisait
// `packRecap`. Le gestionnaire d'ouverture de la fiche était juste ; il n'avait
// plus de déclencheur. Aucune des 103 suites existantes ne pouvait le voir — ce
// sont des modules purs, aucune ne monte d'écran. C'est cohérent avec le choix
// de déléguer l'œil à la recette de sortie, et c'est exactement ce qui a laissé
// vivre le défaut.
//
// Ce que le banc peut dire, et ce qu'il ne peut pas : voir `chromeBench.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  commandControl,
  elementByAttribute,
  elementByClass,
  elementsByAttribute,
  mountSurface,
  paintedCommandIds,
} from './chromeBench.mjs';

const { createElement } = await import('react');
const { AppShell } = await import('../src/components/AppShell.jsx');
const { ProjectMenuPopover } = await import('../src/components/layout/ProjectMenuPopover.jsx');
const { ValidationPill } = await import('../src/components/layout/ValidationPill.jsx');
const { AdvancedIssuesPanel } = await import('../src/components/AdvancedWorkspace/DiagnosticsPanel.jsx');
const { StructureActionsBar } = await import('../src/components/structure/StructureActionsBar.jsx');
const graphSearchModule = await import('../src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx');
const { GraphNodeListActions } = graphSearchModule;
const { GraphSurfaceControls } = await import('../src/components/AdvancedGraphCanvas/GraphSurfaceControls.jsx');
const {
  MEDIA_TOOL_ACTIONS,
  mediaToolActionIds,
} = await import('../src/store/mediaToolSurface.js');
const { buildToolbarInventory, TOOLBAR_GROUPS, toolbarGroup } = await import('../src/store/toolbarModel.js');
const { WORKSPACE_MODE_ADVANCED, WORKSPACE_MODE_HIERARCHICAL } = await import('../src/store/projectWorkState.js');
const {
  DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER,
  DEFAULT_WORKSPACE_PANEL_ORDER,
} = await import('../src/workspace/panelLayout.js');

const EDITORS = [
  ['éditeur par menus', WORKSPACE_MODE_HIERARCHICAL],
  ['éditeur graphe', WORKSPACE_MODE_ADVANCED],
];

// Le gestionnaire que chaque commande de l'inventaire doit atteindre. La table
// est la promesse de la barre, écrite une fois : une commande qui perdrait son
// branchement, ou le prendrait sur le voisin, tombe ici.
const HANDLER_OF = {
  newProject: 'onNewProject',
  openProject: 'onOpenProject',
  openPack: 'onOpenPack',
  saveProject: 'onSaveProject',
  saveProjectAs: 'onSaveProjectAs',
  continueInGraph: 'onContinueInGraph',
  undo: 'onUndo',
  redo: 'onRedo',
  toggleTree: 'onToggleTree',
  toggleSettings: 'onToggleSettings',
  toggleDiagram: 'onToggleDiagram',
  toggleNodeList: 'onToggleNodeList',
  toggleInspector: 'onToggleInspector',
  createStage: 'onCreateStage',
  createAction: 'onCreateAction',
  createConstruction: 'onCreateConstruction',
  openPackOptions: 'onPackOptionsOpenChange',
  toggleValidation: 'onValidationOpenChange',
  generate: 'onGenerate',
  openPreferences: 'onOpenPreferences',
};

// Quatre contrôles portent un identifiant peint différent de celui de
// l'inventaire. Ce n'est pas un oubli : ces valeurs-là sont lues par des
// sélecteurs de `Toolbar.css`, donc les aligner sur l'inventaire changerait
// l'apparence. La correspondance vit ici plutôt que dans le style.
const PAINTED_AS = {
  toggleTree: 'toggle-tree',
  toggleSettings: 'toggle-settings',
  toggleDiagram: 'toggle-diagram',
  toggleNodeList: 'toggle-node-list',
  toggleInspector: 'toggle-inspector',
  openPackOptions: 'pack-options',
};

const paintedId = (id) => PAINTED_AS[id] ?? id;

// Les commandes du groupe « fichier » vivent dans le tiroir du menu Projet, que
// la barre ouvre par son propre état. Le banc n'a pas de DOM pour le déplier :
// il monte ce tiroir ouvert, comme surface à part entière, dans son propre test.
const drawerIds = (inventory) => new Set(toolbarGroup(inventory, TOOLBAR_GROUPS.FILE).map((entry) => entry.id));
// La commande Préférences est peinte dans le popover Options, pas comme un
// bouton de premier niveau. Son chemin est exercé séparément, popover ouvert.
const OPTIONS_POPOVER_COMMAND_IDS = new Set(['openPreferences']);

function witness() {
  const called = [];
  const handler = (...args) => called.push(args);
  handler.called = called;
  return handler;
}

// Un jeu de gestionnaires témoins, un par propriété citée dans `HANDLER_OF`,
// plus ceux dont le chrome a besoin pour se monter.
function witnesses(names) {
  return Object.fromEntries(names.map((name) => [name, witness()]));
}

const TOOLBAR_HANDLERS = [...new Set(Object.values(HANDLER_OF))];
const BOTTOM_BAR_HANDLERS = ['onOpenMedia', 'onOpenRenderQueue', 'onOpenAiQueue'];

// Une seule issue bloquante pour éprouver le compteur et la sélection dans les
// montages communs. Un autre test couvre l'ouverture honnête à zéro.
const BLOCKING_ISSUE = { id: 'issue-1', status: 'error', text: 'Un écran sans son', nodeId: 'n1' };
const ADVANCED_DIAGNOSTIC = {
  family: 'authoring',
  level: 'ACTION_REQUIRED',
  severity: null,
  code: 'POSITION_OUT_OF_RANGE_ACTION_REQUIRED',
  path: '/stageNodes/@uuid=u1#0/position',
  nodePath: '/stageNodes/@uuid=u1#0',
  message: 'La position demande une décision.',
  resolutions: ['scale-position-to-short-range'],
};

function shellProps(workspaceMode, { titleBar: titleBarOverrides = {}, toolbar: toolbarOverrides = null } = {}) {
  const inventory = buildToolbarInventory({
    workspaceMode,
    shortcutLabels: {},
    canUndo: true,
    canRedo: true,
    hasValidationIssues: true,
  });
  const toolbarHandlers = witnesses(TOOLBAR_HANDLERS);
  const bottomBarHandlers = witnesses(BOTTOM_BAR_HANDLERS);
  const onOpenPackMetadata = witness();

  return {
    inventory,
    toolbarHandlers,
    bottomBarHandlers,
    onOpenPackMetadata,
    props: {
      mediaTransfer: {},
      projectContextValue: {},
      projectActions: {},
      projectOpen: true,
      titleBar: {
        projectName: 'Mon projet',
        packRecap: { title: 'Mon pack', line: '3 histoires · 3+' },
        isDirty: false,
        hasSavePath: true,
        showProjectMeta: true,
        onOpenPackMetadata,
        onOpenCredits: witness(),
        ...titleBarOverrides,
      },
      toolbar: {
        inventory,
        shortcutLabels: {},
        issueKind: workspaceMode === WORKSPACE_MODE_ADVANCED ? 'advanced' : 'hierarchical',
        panels: workspaceMode === WORKSPACE_MODE_ADVANCED
          ? { showGraph: true, showNodeList: true, showInspector: true }
          : { showTree: true, showSettings: false, showDiagram: false },
        panelOrder: workspaceMode === WORKSPACE_MODE_ADVANCED
          ? DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER
          : DEFAULT_WORKSPACE_PANEL_ORDER,
        validationIssues: [BLOCKING_ISSUE],
        advancedIssues: workspaceMode === WORKSPACE_MODE_ADVANCED
          ? { diagnostics: [ADVANCED_DIAGNOSTIC] }
          : null,
        globalOptions: {},
        // Le montage générique garde les tiroirs fermés ; les commandes qu'ils
        // contiennent sont éprouvées séparément avec le tiroir concerné ouvert.
        packOptionsOpen: false,
        validationOpen: false,
        ...toolbarHandlers,
        ...(toolbarOverrides ?? {}),
      },
      workspace: {},
      bottomPanel: { open: false },
      appModalsProps: {
        modals: { isOpen: () => false },
        packMetadata: { open: false },
        sdGenerate: { open: false },
        saveProgress: null,
        saveAsProgress: null,
        importing: null,
        unpacking: null,
        triageRequest: null,
        missingMedia: [],
        importNotice: null,
      },
      bottomBar: {
        statusText: 'Prêt',
        projectOpen: true,
        open: false,
        mediaLibraryCount: 4,
        renderQueueActiveCount: 0,
        renderQueueHasResults: false,
        aiQueueActiveCount: 0,
        ...bottomBarHandlers,
      },
    },
  };
}

test('la liste Libre compte exactement ses lignes et nomme leur gravité', () => {
  const { html } = mountSurface(createElement(ValidationPill, {
    validationIssues: [
      BLOCKING_ISSUE,
      { id: 'issue-2', status: 'warning', text: 'Menu — Image manquante' },
    ],
    open: true,
    onOpenChange: witness(),
  }));

  assert.match(html, /validation-pill-count">2</);
  assert.match(html, /Tous \(2\)/);
  assert.match(html, /Erreurs \(1\)/);
  assert.match(html, /Avertissements \(1\)/);
  assert.match(html, />Erreur</);
  assert.match(html, />Avertissement</);
});

test('la liste reste ouvrable et explicite quand son compteur vaut zéro', () => {
  const { html } = mountSurface(createElement(ValidationPill, {
    validationIssues: [],
    open: true,
    onOpenChange: witness(),
  }));

  assert.match(html, /validation-pill-count">0</);
  assert.match(html, /Tous \(0\)/);
  assert.match(html, /Aucun élément dans ce filtre/);
  assert.doesNotMatch(html, /Pack prêt/);
});

test('côté graphe, la pastille à corriger reste un popover hors du triptyque', () => {
  const { html } = mountSurface(createElement(ValidationPill, {
    issueKind: 'advanced',
    advancedIssues: { diagnostics: [ADVANCED_DIAGNOSTIC] },
    open: true,
    onOpenChange: witness(),
  }));

  assert.match(html, /validation-pill-dd/);
  const source = readFileSync(
    new URL('../src/components/layout/ValidationPill.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /import\('\.\.\/AdvancedWorkspace\/DiagnosticsPanel\.jsx'\)/);
});

test('la liste graphe ne montre que les blocages et conserve leur réparation', () => {
  const onFocusPath = witness();
  const onGesture = witness();
  const context = {
    blockingIssues: [{
      id: 'blocking:position',
      category: 'Décision requise',
      message: 'La position de ce nœud doit être adaptée avant la génération.',
      nodePath: '/stageNodes/@uuid=u1#0',
      diagnostic: ADVANCED_DIAGNOSTIC,
    }],
    view: { diagnostics: [ADVANCED_DIAGNOSTIC], opaqueMembers: [], groups: [] },
    index: {
      byPath: new Map([[
        '/stageNodes/@uuid=u1#0',
        { kind: 'stage', node: { uuid: 'u1' } },
      ]]),
    },
    disabled: false,
    onFocusPath,
    onGesture,
    onOpenForm: witness(),
    readiness: { status: 'idle', summary: null, error: null, stale: false },
    exportState: null,
    stagePaths: [],
    working: false,
  };
  const { html, elements } = mountSurface(createElement(AdvancedIssuesPanel, { context }));

  assert.doesNotMatch(html, /Toutes \(1\)/);
  assert.match(html, /Décision requise/);
  assert.match(html, /Corriger/);
  assert.match(html, /Mettre à l’échelle/);

  const focus = elements.find((element) => element.props?.children === 'Corriger');
  const repair = elements.find((element) => (
    typeof element.props?.children === 'string'
    && element.props.children.startsWith('Mettre à l’échelle')
  ));
  focus.props.onClick();
  repair.props.onClick();
  assert.deepEqual(onFocusPath.called, [['/stageNodes/@uuid=u1#0']]);
  assert.equal(onGesture.called.length, 1);
  assert.equal(onGesture.called[0][0].gesture, 'set-position-export-disposition');
});

test('le triptyque est Graphe, Inspecteur et liste ; les diagnostics restent hors workspace', () => {
  const source = readFileSync(
    new URL('../src/components/AdvancedWorkspace/AdvancedWorkspace.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /advanced-panel--graph/);
  assert.match(source, /advanced-panel--inspector/);
  assert.match(source, /advanced-panel--nodes/);
  assert.doesNotMatch(source, /advanced-panel--diagnostics/);
  assert.doesNotMatch(source, /<AdvancedIssuesPanel\b/);
  assert.doesNotMatch(source, /<ExportPanel\b/);
  assert.match(source, /onIssuesContext/);
});

function mountShell(workspaceMode, overrides) {
  const fixture = shellProps(workspaceMode, overrides);
  return { ...fixture, ...mountSurface(createElement(AppShell, fixture.props)) };
}

for (const [editor, workspaceMode] of EDITORS) {
  test(`${editor} : la pastille du pack se rend et ouvre la fiche`, () => {
    const { elements, onOpenPackMetadata } = mountShell(workspaceMode);

    const pastille = elementByClass(elements, 'chrome-titlebar-pack-recap');
    assert.ok(pastille, 'la barre du haut ne peint pas la pastille du pack');
    assert.equal(typeof pastille.props.onClick, 'function');
    assert.equal(pastille.props.disabled, false);

    pastille.props.onClick();
    assert.equal(onOpenPackMetadata.called.length, 1);
  });

  test(`${editor} : la pastille dit le nom du pack, pas un nom inventé`, () => {
    const { elements } = mountShell(workspaceMode);

    const titre = elementByClass(elements, 'chrome-titlebar-pack-title');
    assert.ok(titre, 'la pastille ne peint pas le nom du pack');
    assert.equal(titre.props.children, 'Mon pack');
  });

  test(`${editor} : sans récapitulatif, la pastille disparaît au lieu de mentir`, () => {
    const { elements } = mountShell(workspaceMode, { titleBar: { packRecap: null } });

    assert.equal(elementByClass(elements, 'chrome-titlebar-pack-recap'), null);
  });

  test(`${editor} : chaque commande de l'inventaire atteint son gestionnaire`, () => {
    const { elements, inventory, toolbarHandlers } = mountShell(workspaceMode);
    const peintes = paintedCommandIds(elements);
    const tiroir = drawerIds(inventory);

    for (const entry of inventory) {
      if (tiroir.has(entry.id) || OPTIONS_POPOVER_COMMAND_IDS.has(entry.id)) continue;

      const controle = commandControl(elements, paintedId(entry.id));
      assert.ok(
        controle,
        `la commande « ${entry.id} » est annoncée par l'inventaire mais n'est peinte nulle part (peintes : ${peintes.join(', ')})`,
      );
      assert.equal(
        typeof controle.props.onClick,
        'function',
        `la commande « ${entry.id} » est peinte sans gestionnaire`,
      );

      const attendu = toolbarHandlers[HANDLER_OF[entry.id]];
      const avant = attendu.called.length;
      controle.props.onClick();
      assert.equal(
        attendu.called.length,
        avant + 1,
        `le clic sur « ${entry.id} » n'atteint pas ${HANDLER_OF[entry.id]}`,
      );
    }
  });

  test(`${editor} : la carte Préférences du popover Options atteint son gestionnaire`, () => {
    const { elements, toolbarHandlers } = mountShell(workspaceMode, {
      toolbar: { packOptionsOpen: true },
    });
    const preferences = elementByClass(elements, 'pack-options-gateway--app');

    assert.ok(preferences, 'le popover Options ne peint pas la carte Préférences');
    assert.equal(preferences.props.type, 'button');
    assert.equal(typeof preferences.props.onClick, 'function');

    preferences.props.onClick();
    assert.equal(toolbarHandlers.onOpenPreferences.called.length, 1);
    assert.deepEqual(toolbarHandlers.onPackOptionsOpenChange.called, [[false]]);
  });

  test(`${editor} : le tiroir du menu Projet branche toutes ses commandes`, () => {
    const { inventory, toolbarHandlers } = shellProps(workspaceMode);
    const fileGroup = toolbarGroup(inventory, TOOLBAR_GROUPS.FILE);
    assert.ok(fileGroup.length > 0, "l'inventaire n'annonce aucune commande de fichier");

    const { elements } = mountSurface(createElement(ProjectMenuPopover, {
      open: true,
      onOpenChange: witness(),
      shortcutLabels: {},
      commands: fileGroup,
      onNewProject: toolbarHandlers.onNewProject,
      onOpenProject: toolbarHandlers.onOpenProject,
      onOpenPack: toolbarHandlers.onOpenPack,
      onSaveProject: toolbarHandlers.onSaveProject,
      onSaveProjectAs: toolbarHandlers.onSaveProjectAs,
      onContinueInGraph: toolbarHandlers.onContinueInGraph,
      trigger: () => null,
    }));

    for (const entry of fileGroup) {
      const controle = commandControl(elements, entry.id);
      assert.ok(controle, `la commande « ${entry.id} » n'est pas peinte dans le tiroir`);
      assert.equal(typeof controle.props.onClick, 'function');

      const attendu = toolbarHandlers[HANDLER_OF[entry.id]];
      const avant = attendu.called.length;
      controle.props.onClick();
      assert.equal(
        attendu.called.length,
        avant + 1,
        `le clic sur « ${entry.id} » n'atteint pas ${HANDLER_OF[entry.id]}`,
      );
    }
  });

  test(`${editor} : les trois boutons de la bande basse atteignent leur gestionnaire`, () => {
    const { elements, bottomBarHandlers } = mountShell(workspaceMode);

    const boutons = elements.filter((element) => {
      const painted = element.props?.className;
      return typeof painted === 'string' && painted.startsWith('rq-bottombar-btn');
    });
    assert.equal(boutons.length, BOTTOM_BAR_HANDLERS.length);

    for (const [index, name] of BOTTOM_BAR_HANDLERS.entries()) {
      assert.equal(typeof boutons[index].props.onClick, 'function');
      boutons[index].props.onClick();
      assert.equal(bottomBarHandlers[name].called.length, 1, `la bande basse n'atteint pas ${name}`);
    }
  });
}


// ── Le tiroir d'options du pack, un seul pour les deux éditeurs ──────────────
//
// Ces tests montent le tiroir **ouvert** pour lire ce qu'il peint. La liste des
// options audio gardent les mêmes libellés, ordre et défauts dans les trois
// projets. Auto-next est propre à l'éditeur par menus. L'ouverture réelle
// au survol reste à vérifier dans la recette de sortie.

const PACK_OPTION_TITLES = ['Harmoniser le volume', 'Silence début / fin'];

function packOptionRows(elements) {
  return elements
    .filter((element) => element.props?.className === 'pack-options-control-title')
    .map((element) => element.props.children);
}

function autoNextToggle(elements) {
  return elements.find((element) => (
    typeof element.props?.ariaLabel === 'string' && element.props.ariaLabel.startsWith('Auto-next.')
  )) ?? null;
}

function silenceSegments(elements) {
  return elements.filter((element) => (
    typeof element.props?.className === 'string'
    && element.props.className.startsWith('pack-options-segment')
  ));
}

function mountPackOptions(workspaceMode, { projectType, globalOptions = {} }) {
  return mountShell(workspaceMode, {
    toolbar: { packOptionsOpen: true, projectType, globalOptions },
  });
}

test('le tiroir réserve Auto-next aux menus et conserve les options audio dans le même ordre', () => {
  const libre = mountPackOptions(WORKSPACE_MODE_HIERARCHICAL, { projectType: 'pack' });
  assert.deepEqual(packOptionRows(libre.elements), [...PACK_OPTION_TITLES, 'Auto-next']);
  for (const projectType of ['advanced', 'simple']) {
    const mode = projectType === 'advanced' ? WORKSPACE_MODE_ADVANCED : WORKSPACE_MODE_HIERARCHICAL;
    const { elements } = mountPackOptions(mode, { projectType });
    assert.deepEqual(packOptionRows(elements), PACK_OPTION_TITLES);
  }
});

test('les valeurs pré-cochées sont les mêmes des deux côtés sans réglage d’auteur', () => {
  // Un projet Libre neuf porte `normalize` et `harmonize` par son schéma ; un
  // projet graphe ne porte rien du tout. Les deux doivent montrer la même chose.
  const libre = mountPackOptions(WORKSPACE_MODE_HIERARCHICAL, {
    projectType: 'pack',
    globalOptions: { silenceMode: 'normalize', harmonizeLoudness: true },
  });
  const graphe = mountPackOptions(WORKSPACE_MODE_ADVANCED, { projectType: 'advanced', globalOptions: {} });

  const actif = (elements) => silenceSegments(elements)
    .filter((segment) => segment.props['aria-pressed'] === true)
    .map((segment) => segment.props.children);
  assert.deepEqual(actif(libre.elements), ['Ajuster']);
  assert.deepEqual(actif(graphe.elements), ['Ajuster']);

  const harmonise = (elements) => elements.find((element) => (
    element.props?.ariaLabel === 'Harmoniser le volume des audios vers -14 LUFS à la génération.'
  ));
  assert.equal(harmonise(libre.elements).props.on, true);
  assert.equal(harmonise(graphe.elements).props.on, true);
});

for (const projectType of ['advanced', 'simple']) {
  test(`auto-next reste absent du projet ${projectType} même avec une ancienne valeur active`, () => {
    const mode = projectType === 'advanced' ? WORKSPACE_MODE_ADVANCED : WORKSPACE_MODE_HIERARCHICAL;
    const { elements } = mountPackOptions(mode, { projectType, globalOptions: { autoNext: true } });
    assert.equal(autoNextToggle(elements), null);
    assert.deepEqual(packOptionRows(elements), PACK_OPTION_TITLES);
    assert.ok(!elements.some((element) => element.props?.className === 'pack-options-well-title'
      && Array.isArray(element.props.children) && element.props.children.includes('Lecture ')));
  });
}

test('auto-next reste offert sur un pack de l’éditeur par menus', () => {
  const { elements } = mountPackOptions(WORKSPACE_MODE_HIERARCHICAL, { projectType: 'pack' });
  const toggle = autoNextToggle(elements);
  assert.ok(toggle);
  assert.ok(!toggle.props.disabled);
});

// ── La file de rendu sert les deux natures ───────────────────────────────────
//
// Le travail de fabrication d'un pack graphe a quitté le tiroir de son éditeur
// pour la file de rendu, et son compte rendu détaillé a déménagé **avec lui**.
// Deux branchements se vérifient ici, et rien d'autre : que chaque carte reçoive
// les raccords vers l'éditeur graphe, et que le compte rendu détaillé peigne ce
// que seule cette chaîne sait dire.

const { RenderQueuePanel } = await import('../src/components/RenderQueuePanel/RenderQueuePanel.jsx');
const { AdvancedJobReport } = await import('../src/components/production/AdvancedJobReport.jsx');
const { WORK_NATURE } = await import('../src/store/production/renderQueueWork.js');

const queueJob = (fields) => ({
  id: 'j1',
  nature: WORK_NATURE.FREE,
  projectName: 'Le Renard',
  outputFolder: '/sorties',
  createdAt: 0,
  status: 'done',
  cancelRequested: false,
  logs: [],
  resultPath: null,
  warnings: [],
  gateObservations: [],
  errorMessage: null,
  result: null,
  refusal: null,
  ownership: 'current',
  readinessSummary: null,
  ...fields,
});

const ARCHIVE = {
  zipPath: '/sorties/graphe.zip',
  assetCount: 2,
  transformations: [],
  converted: false,
  deduplicated: 0,
  warnings: [],
  hasThumbnail: true,
  conversions: [],
  destinations: [],
};

// Les cartes créées par le panneau, reconnues à la propriété qu'elles seules
// portent. Le banc lit ce que le panneau **tend** à ses cartes ; il ne déplie
// aucune carte, faute de DOM pour la cliquer.
const jobCards = (elements) => elements.filter((element) => element.props?.job !== undefined);

test('la file tend à chaque carte les raccords de l’éditeur graphe', () => {
  const advanced = {
    stagePaths: [{ uuid: 'u1', path: '/stageNodes/@uuid=u1#0' }],
    onFocusPath: () => {},
    onOpenDiagnostics: () => {},
    onReview: () => {},
  };
  const { elements } = mountSurface(createElement(RenderQueuePanel, {
    jobs: [
      queueJob({ id: 'libre', resultPath: '/sorties/libre.zip' }),
      queueJob({ id: 'graphe', nature: WORK_NATURE.ADVANCED, result: ARCHIVE, resultPath: ARCHIVE.zipPath }),
    ],
    onRemove: () => {},
    onCancel: () => {},
    onClearDone: () => {},
    onClose: () => {},
    advanced,
  }));

  const cards = jobCards(elements);
  assert.equal(cards.length, 2);
  for (const card of cards) assert.equal(card.props.advanced, advanced);
});

test('sans projet graphe ouvert, les cartes ne reçoivent aucun raccord', () => {
  const { elements } = mountSurface(createElement(RenderQueuePanel, {
    jobs: [queueJob({ nature: WORK_NATURE.ADVANCED, result: ARCHIVE, resultPath: ARCHIVE.zipPath })],
    onRemove: () => {},
    onCancel: () => {},
    onClearDone: () => {},
    onClose: () => {},
    advanced: null,
  }));
  assert.equal(jobCards(elements)[0].props.advanced, null);
});

test('un succès graphe ne redouble pas le compte rendu commun et garde seulement la simulation', () => {
  const { html } = mountSurface(createElement(AdvancedJobReport, {
    job: queueJob({ nature: WORK_NATURE.ADVANCED, result: ARCHIVE, resultPath: ARCHIVE.zipPath }),
    onReview: () => {},
  }));
  assert.match(html, /Simuler le pack produit/);
  assert.doesNotMatch(html, /Archive produite|média\(s\) préparé\(s\)|Détails de diagnostic/);
  assert.doesNotMatch(html, /\/sorties\/graphe\.zip/);
});

test('l’action de simulation disparaît quand aucun éditeur graphe ne peut l’accueillir', () => {
  const { html } = mountSurface(createElement(AdvancedJobReport, {
    job: queueJob({ nature: WORK_NATURE.ADVANCED, result: ARCHIVE, resultPath: ARCHIVE.zipPath }),
    onReview: null,
  }));
  // Le chemin reste dans le rapport commun ; le détail Graphe n'a plus rien à
  // ajouter quand son seul geste n'est pas disponible.
  assert.equal(html, '');
});

test('un refus typé garde ses médias manquants, il n’est ni résumé ni remplacé', () => {
  const { html } = mountSurface(createElement(AdvancedJobReport, {
    job: queueJob({
      nature: WORK_NATURE.ADVANCED,
      status: 'error',
      refusal: {
        kind: 'media-unavailable',
        preparationKind: null,
        title: 'Médias indisponibles',
        message: '1 référence',
        entries: [{ assetRef: 'a1b2c3.mp3', cause: 'not-found', lastKnownPath: '/medias/a1b2c3.mp3', stageIds: ['u1'] }],
        conflicts: [],
        disagreements: [],
        diagnostics: [],
        integrityErrors: [],
        cancelled: false,
        residue: false,
        path: null,
        codecError: null,
      },
    }),
    stagePaths: [{ uuid: 'u1', path: '/stageNodes/@uuid=u1#0' }],
    onFocusPath: () => {},
  }));
  // Le titre et le message sont dans le rapport commun ; le détail ne les
  // répète pas et ne montre pas le code interne du refus.
  assert.doesNotMatch(html, /Médias indisponibles|<code>media-unavailable|<code>not-found|1 référence/);
  assert.match(html, /1 média est introuvable/);
  assert.match(html, /a1b2c3\.mp3/);
  assert.match(html, /\/medias\/a1b2c3\.mp3/);
  // L'Écran concerné reste atteignable depuis la file : la correspondance des
  // chemins lui a été tendue, elle n'est pas déduite d'un index qu'elle n'a pas.
  assert.match(html, /u1<\/button>/);
});

test('une annulation graphe ne peint aucun détail, comme dans le Libre', () => {
  const { html } = mountSurface(createElement(AdvancedJobReport, {
    job: queueJob({
      nature: WORK_NATURE.ADVANCED,
      status: 'canceled',
      refusal: { kind: 'export-cancelled', title: 'Export annulé', message: '', cancelled: true, residue: false },
    }),
  }));
  assert.equal(html, '');
});

test('sans correspondance de chemins, l’identifiant reste lisible mais n’est plus cliquable', () => {
  const { html } = mountSurface(createElement(AdvancedJobReport, {
    job: queueJob({
      nature: WORK_NATURE.ADVANCED,
      status: 'error',
      refusal: {
        kind: 'media-unavailable',
        title: 'Médias indisponibles',
        message: '1 référence',
        entries: [{ assetRef: 'a1b2c3.mp3', cause: 'not-found', lastKnownPath: '/m/a.mp3', stageIds: ['u1'] }],
        conflicts: [], disagreements: [], diagnostics: [], integrityErrors: [],
        cancelled: false, residue: false, path: null, codecError: null, preparationKind: null,
      },
    }),
    stagePaths: null,
    onFocusPath: null,
  }));
  assert.match(html, /<code>u1<\/code>/);
});

test('un travail Libre ne reçoit jamais le compte rendu de l’autre chaîne', () => {
  const { html } = mountSurface(createElement(AdvancedJobReport, {
    job: queueJob({ resultPath: '/sorties/libre.zip', result: null, refusal: null }),
  }));
  assert.equal(html, '');
});

// ── Les outils de son, des deux côtés ────────────────────────────────────────
//
// Le banc éprouve ici ce qu'aucune suite pure ne peut voir : que la barre est
// bel et bien montée dans l'éditeur graphe, et que chacun de ses boutons y
// atteint un gestionnaire. Le modèle commun (`mediaToolSurface`) dit ce qui
// doit y être ; ces tests-ci disent que c'est peint et relié.

// Le gestionnaire que chaque action de la barre doit atteindre.
const MEDIA_TOOL_HANDLER_OF = {
  [MEDIA_TOOL_ACTIONS.IMPORT_STORY]: 'onAddStory',
  [MEDIA_TOOL_ACTIONS.ADD_FOLDER]: 'onAddFolder',
  [MEDIA_TOOL_ACTIONS.IMPORT_FOLDER]: 'onImportFolder',
  [MEDIA_TOOL_ACTIONS.IMPORT_MEDIA]: 'onImportMedia',
  [MEDIA_TOOL_ACTIONS.IMPORT_PODCAST]: 'onImportPodcast',
  [MEDIA_TOOL_ACTIONS.IMPORT_YOUTUBE]: 'onImportYoutube',
  [MEDIA_TOOL_ACTIONS.RECORD]: 'onRecord',
  [MEDIA_TOOL_ACTIONS.GENERATE_TTS]: 'onGenerateStoryTts',
  [MEDIA_TOOL_ACTIONS.SIMULATOR]: 'onLaunchSimulator',
};

const MEDIA_TOOL_HANDLERS = [...new Set(Object.values(MEDIA_TOOL_HANDLER_OF))];

// Une largeur que rien ne contraint. Elle est tendue parce que le banc n'a pas
// de DOM et ne peut donc rien mesurer : sans elle, la barre se replierait dans
// son menu « … », qui n'est pas rendu tant qu'il est fermé, et ces tests-ci
// verraient une absence là où il n'y a qu'un repli. Le repli lui-même — et la
// largeur à laquelle chaque barre y tient — est éprouvé par
// `structureActionLayout.test.mjs`, qui n'a besoin d'aucun rendu.
const BAR_WIDTH = 1000;

function mountMediaToolBar(workspaceMode) {
  const handlers = witnesses(MEDIA_TOOL_HANDLERS);
  const mounted = mountSurface(createElement(StructureActionsBar, {
    variant: 'panel',
    workspaceMode,
    availableInlineSize: BAR_WIDTH,
    ...handlers,
  }));
  const painted = elementsByAttribute(mounted.elements, 'data-media-tool')
    .map((element) => element.props['data-media-tool']);
  return { ...mounted, handlers, painted };
}

for (const [editor, workspaceMode] of EDITORS) {
  test(`${editor} : la barre média peint exactement les actions qui ont un objet`, () => {
    const { painted } = mountMediaToolBar(workspaceMode);

    assert.deepEqual(painted, [...mediaToolActionIds(workspaceMode)]);
  });

  test(`${editor} : chaque action de la barre média atteint son gestionnaire`, () => {
    const { elements, handlers } = mountMediaToolBar(workspaceMode);

    for (const id of mediaToolActionIds(workspaceMode)) {
      const control = elementByAttribute(elements, 'data-media-tool', id);
      assert.ok(control, `${id} n'est pas peint`);
      control.props.onClick();

      const expected = MEDIA_TOOL_HANDLER_OF[id];
      assert.equal(handlers[expected].called.length, 1, `${id} n'atteint pas ${expected}`);
      for (const [name, handler] of Object.entries(handlers)) {
        if (name !== expected) assert.equal(handler.called.length, 0, `${id} a réveillé ${name}`);
      }
      handlers[expected].called.length = 0;
    }
  });
}

test('les quatre outils de son sont atteignables depuis un projet graphe', () => {
  const { painted } = mountMediaToolBar(WORKSPACE_MODE_ADVANCED);

  for (const tool of ['import-podcast', 'import-youtube', 'record', 'generate-tts']) {
    assert.ok(painted.includes(tool), `${tool} reste inatteignable côté graphe`);
  }
});

test('la barre du graphe ne peint aucune action d’arbre, même déguisée', () => {
  const { html, painted } = mountMediaToolBar(WORKSPACE_MODE_ADVANCED);

  for (const treeAction of ['import-story', 'add-folder', 'import-folder']) {
    assert.ok(!painted.includes(treeAction), `${treeAction} n'a pas d'objet sur un graphe`);
  }
  assert.doesNotMatch(html, /dossier/i);
});

test('l’écoute porte le même bouton et le même libellé des deux côtés', () => {
  const graph = mountMediaToolBar(WORKSPACE_MODE_ADVANCED);
  const tree = mountMediaToolBar(WORKSPACE_MODE_HIERARCHICAL);

  for (const { elements } of [graph, tree]) {
    const control = elementByAttribute(elements, 'data-media-tool', MEDIA_TOOL_ACTIONS.SIMULATOR);
    assert.ok(control, 'l’écoute n’est pas peinte');
    assert.equal(control.props['aria-label'], 'Lancer le simulateur');
  }
});

test('côté Libre, la barre garde ses huit actions et ses libellés', () => {
  const { html, painted } = mountMediaToolBar(WORKSPACE_MODE_HIERARCHICAL);

  assert.equal(painted.length, 8);
  assert.match(html, /Importer audio, ZIP ou 7z/);
  assert.match(html, /Créer un dossier/);
  assert.match(html, /Importer un dossier/);
  assert.match(html, /Lancer le simulateur/);
});

function mountGraphSurfaceTools(surfaceTools) {
  return mountSurface(createElement(GraphSurfaceControls, {
    engineRef: { current: null },
    hostRef: { current: null },
    index: null,
    viewport: { zoom: 1 },
    overviewOpen: false,
    surfaceTools,
  }));
}

test('le L du graphe monte les outils média sur le canvas', () => {
  const mediaTools = {
    ...witnesses(['onImportMedia', 'onImportPodcast', 'onImportYoutube', 'onRecord', 'onGenerateStoryTts']),
    canRecord: true,
    canGenerateStoryTts: true,
  };
  const onSimulate = witness();
  const onSearch = witness();
  const { elements } = mountGraphSurfaceTools({
    ...mediaTools,
    onSimulate: () => onSimulate(null),
    onSearch,
  });

  const bar = elements.find((element) => element.props?.variant === 'canvas');
  assert.ok(bar, 'la barre média n’est pas montée sur le graphe');
  assert.equal(bar.props.workspaceMode, WORKSPACE_MODE_ADVANCED);
  assert.equal(bar.props.onImportMedia, mediaTools.onImportMedia);
  assert.equal(bar.props.onImportPodcast, mediaTools.onImportPodcast);
  assert.equal(bar.props.onImportYoutube, mediaTools.onImportYoutube);
  assert.equal(bar.props.onRecord, mediaTools.onRecord);
  assert.equal(bar.props.onGenerateStoryTts, mediaTools.onGenerateStoryTts);

  // L'écoute part de l'Écran d'entrée, comme depuis l'ancienne liste.
  bar.props.onLaunchSimulator();
  assert.deepEqual(onSimulate.called, [[null]]);
  const searchButton = elementByAttribute(elements, 'aria-label', 'Rechercher dans les nœuds du graphe');
  searchButton.props.onClick();
  assert.equal(onSearch.called.length, 1);
});

test('la barre de la liste graphe réutilise le déclencheur de recherche du Libre', () => {
  const onSearch = witness();
  const onClose = witness();
  const { elements } = mountSurface(createElement(GraphNodeListActions, {
    onSearch,
    onClose,
  }));
  const searchButton = elementByAttribute(
    elements,
    'aria-label',
    'Rechercher dans la liste des nœuds',
  );
  const closeButton = elementByAttribute(elements, 'aria-label', 'Masquer la liste des nœuds');

  assert.equal(searchButton.props.className, 'tree-display-trigger tree-search-trigger');
  searchButton.props.onClick();
  closeButton.props.onClick();
  assert.equal(onSearch.called.length, 1);
  assert.equal(onClose.called.length, 1);
});

test('le large bouton d’écoute propre au graphe a disparu', () => {
  const source = readFileSync(
    new URL('../src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /advanced-search__launch/);
  assert.doesNotMatch(source, /Écouter le projet/);
});

// Tant que la vue du graphe n'est pas lue, il n'y a rien à écouter. L'écoute
// s'efface alors — la barre ne peint pas d'action sans gestionnaire —, et les
// outils de son, eux, restent offerts : ils ne dépendent pas de la vue.
test('sans écoute possible, le L du graphe garde ses outils', () => {
  const mediaTools = {
    ...witnesses(['onImportMedia', 'onImportPodcast', 'onImportYoutube', 'onRecord', 'onGenerateStoryTts']),
    canRecord: true,
    canGenerateStoryTts: true,
  };
  const { elements } = mountGraphSurfaceTools({
    onSimulate: null,
    ...mediaTools,
    onSearch: witness(),
  });

  const bar = elements.find((element) => element.props?.variant === 'canvas');
  assert.ok(bar, 'la barre média n’est pas montée sur le graphe');
  assert.equal(bar.props.onLaunchSimulator, null);
  assert.equal(bar.props.onRecord, mediaTools.onRecord);
});

test('la liste du graphe garde sa recherche sans doubler les outils du L', () => {
  const { elements } = mountSurface(createElement(GraphNodeListActions, {
    onSearch: witness(),
    onClose: witness(),
  }));

  assert.equal(elementsByAttribute(elements, 'data-media-tool').length, 0);
});

test('l’espace graphe prend ses outils au contexte, il ne les recopie pas', () => {
  const source = readFileSync(
    new URL('../src/components/AdvancedWorkspace/AdvancedWorkspace.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /useProjectActions\(\)/);
  assert.match(source, /onImportMediaLibrary/);
  // Aucun outil refabriqué ici : les modales et les funnels restent ouverts par
  // l'hôte, comme côté Libre.
  assert.doesNotMatch(source, /modals\.open/);
});

// ── Retour d'un geste d'édition graphe ──────────────────────────────────────

const { ReportNotice } = await import('../src/components/AdvancedWorkspace/GestureFeedback.jsx');

test('une création ne s’annonce pas : le nœud créé est déjà sélectionné sur le graphe', () => {
  for (const report of [
    { created: { stageUuid: 's1' } },
    { created: { actionId: 'a1' } },
    { created: { stageUuid: 's1' }, construction: { stages: ['s1', 's2'], actions: ['a1'], connected: false } },
  ]) {
    const { html } = mountSurface(createElement(ReportNotice, { entry: { report }, onDismiss: () => {} }));
    assert.equal(html, '');
  }
});

test('un geste qui retire des raccords le dit toujours, même s’il a créé un nœud', () => {
  const { html } = mountSurface(createElement(ReportNotice, {
    entry: {
      report: {
        created: { stageUuid: 's1' },
        references: { selections: [{ decided: true, after: null }] },
      },
    },
    onDismiss: () => {},
  }));
  assert.match(html, /1 raccord\(s\) ont été retirés/);
  assert.doesNotMatch(html, /Créé|Montrer/);
});
