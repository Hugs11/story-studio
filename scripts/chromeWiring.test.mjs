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
import { commandKeyLabel } from '../src/utils/platformKeys.js';

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
const { TitleBar } = await import('../src/components/layout/TitleBar.jsx');
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
  returnToCatalogue: 'onReturnToCatalogue',
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
};

const paintedId = (id) => PAINTED_AS[id] ?? id;

// Les commandes du groupe « fichier » vivent dans le tiroir du menu Projet, que
// la barre ouvre par son propre état. Le banc n'a pas de DOM pour le déplier :
// il monte ce tiroir ouvert, comme surface à part entière, dans son propre test.
const drawerIds = (inventory) => new Set(toolbarGroup(inventory, TOOLBAR_GROUPS.FILE).map((entry) => entry.id));

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

test('les Préférences restent accessibles depuis la barre de titre à l’accueil', () => {
  const onOpenPreferences = witness();
  const { elements } = mountSurface(createElement(TitleBar, {
    projectName: '',
    showProjectMeta: false,
    onOpenPreferences,
  }));
  const preferences = elementByClass(elements, 'chrome-titlebar-preferences');
  assert.ok(preferences);
  assert.match(preferences.props['aria-label'], new RegExp(`Préférences de l’application.*${commandKeyLabel()}\\+,`));
  preferences.props.onClick();
  assert.equal(onOpenPreferences.called.length, 1);
});

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
        onOpenPreferences: toolbarHandlers.onOpenPreferences,
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

test('la liste Libre réunit tous les blocages sans filtre de gravité', () => {
  const { html } = mountSurface(createElement(ValidationPill, {
    validationIssues: [
      BLOCKING_ISSUE,
      { id: 'issue-2', status: 'warning', text: 'Menu — Image manquante' },
    ],
    open: true,
    onOpenChange: witness(),
  }));

  assert.match(html, /validation-pill-count">2</);
  assert.match(html, /2 éléments empêchent la génération/);
  assert.match(html, /Image manquante/);
  assert.doesNotMatch(html, /Filtrer par gravité|>Erreur<|>Avertissement</);
  assert.equal((html.match(/class="validation-pill-item /g) ?? []).length, 2);
});

test('la liste reste ouvrable et explicite quand son compteur vaut zéro', () => {
  const { html } = mountSurface(createElement(ValidationPill, {
    validationIssues: [],
    open: true,
    onOpenChange: witness(),
  }));

  assert.match(html, /validation-pill-count">0</);
  assert.match(html, /Le pack peut être généré/);
  assert.match(html, /Aucun élément à corriger/);
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

function issuesContext(blockingIssues, extra = {}) {
  return {
    blockingIssues,
    view: { diagnostics: [], opaqueMembers: [], groups: [] },
    index: { byPath: new Map() },
    disabled: false,
    onFocusPath: witness(),
    onGesture: witness(),
    onOpenForm: witness(),
    readiness: { status: 'idle', summary: null, error: null, stale: false },
    exportState: null,
    stagePaths: [],
    working: false,
    ...extra,
  };
}

test('un problème global et un problème d’Écran au même nodePath ne fusionnent pas', () => {
  const nodePath = '/stageNodes/@uuid=u1#0';
  const { html } = mountSurface(createElement(AdvancedIssuesPanel, {
    context: issuesContext([
      { id: 'a', category: 'Pack', message: 'Un seul départ.', nodePath, nodeLabel: null, diagnostic: null },
      { id: 'b', category: 'Écran', message: 'Position.', nodePath, nodeLabel: 'Écran « Début »', diagnostic: null },
    ]),
  }));

  assert.match(html, /validation-pill-group-label">Pack<\/span><span class="validation-pill-group-count">· 1</);
  assert.match(html, /validation-pill-group-label">Écran « Début »<\/span><span class="validation-pill-group-count">· 1</);
});

test('seule la résolution destructive des éléments à corriger porte btn-danger-outline', () => {
  const nodePath = '/stageNodes/@uuid=u1#0';
  const diagnostic = {
    ...ADVANCED_DIAGNOSTIC,
    code: 'ENRICHED_GROUP_INCOHERENT',
    nodePath,
    resolutions: ['repair-known-group', 'flatten-known-group'],
  };
  const { html } = mountSurface(createElement(AdvancedIssuesPanel, {
    context: issuesContext(
      [{ id: 'g', category: 'Groupe', message: 'Groupe incohérent.', nodePath, nodeLabel: 'Écran « Début »', diagnostic }],
      {
        view: {
          diagnostics: [diagnostic],
          opaqueMembers: [],
          groups: [{ groupId: 'g-1', kind: 'story', stagePaths: [nodePath], actionPaths: [] }],
        },
        index: {
          byPath: new Map([[nodePath, {
            kind: 'stage',
            node: { uuid: 'u1', groupId: { presence: 'value', value: 'g-1' } },
          }]]),
        },
      },
    ),
  }));

  const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)];
  const flatten = buttons.filter(([, , label]) => label.startsWith('Aplatir'));
  assert.equal(flatten.length, 1);
  assert.match(flatten[0][1], /btn-danger-outline/);
  const others = buttons.filter(([, , label]) => !label.startsWith('Aplatir'));
  assert.ok(others.length >= 1);
  for (const [, cls] of others) assert.doesNotMatch(cls, /btn-danger/);
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
      nodeLabel: 'Écran « Début »',
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
  assert.match(html, /Écran « Début »/);
  assert.match(html, /<details class="validation-pill-details"><summary/);
  assert.doesNotMatch(html, /data-severity|btn-danger/);
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
      if (tiroir.has(entry.id) || entry.id === 'openPreferences') continue;

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

  test(`${editor} : le bouton Préférences de la barre de titre atteint son gestionnaire`, () => {
    const { elements, toolbarHandlers } = mountShell(workspaceMode, {
    });
    const preferences = elementByClass(elements, 'chrome-titlebar-preferences');
    assert.ok(preferences, 'la barre de titre ne peint pas Préférences');
    assert.equal(typeof preferences.props.onClick, 'function');
    preferences.props.onClick();
    assert.equal(toolbarHandlers.onOpenPreferences.called.length, 1);
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
      onReturnToCatalogue: toolbarHandlers.onReturnToCatalogue,
      onOpenProject: toolbarHandlers.onOpenProject,
      onOpenPack: toolbarHandlers.onOpenPack,
      onSaveProject: toolbarHandlers.onSaveProject,
      onSaveProjectAs: toolbarHandlers.onSaveProjectAs,
      onContinueInGraph: toolbarHandlers.onContinueInGraph,
      trigger: () => null,
    }));

    assert.ok(!elementByClass(elements, 'project-menu-head'), 'le menu commence directement par ses commandes');
    assert.ok(elementByAttribute(elements, 'role', 'menu').props['aria-label'], 'le menu conserve son nom accessible');

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
  assert.match(html, /Simuler le pack généré/);
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

test('la liste du graphe ouverte porte les outils média et le simulateur', () => {
  const tools = {
    ...witnesses(['onImportMedia', 'onImportPodcast', 'onImportYoutube', 'onRecord', 'onGenerateStoryTts', 'onSimulate']),
    canRecord: true,
    canGenerateStoryTts: true,
  };
  const { elements } = mountSurface(createElement(GraphNodeListActions, {
    onSearch: witness(),
    onClose: witness(),
    surfaceTools: tools,
  }));

  const bar = elements.find((element) => element.props?.variant === 'panel');
  assert.ok(bar, 'la barre de la liste n’est pas montée');
  assert.equal(bar.props.onRecord, tools.onRecord);
  assert.equal(bar.props.onImportMedia, tools.onImportMedia);
  assert.equal(bar.props.onLaunchSimulator, tools.onSimulate);
});

test('les outils du graphe vont à la liste quand elle est ouverte, au L sinon', () => {
  const workspace = readFileSync(
    new URL('../src/components/AdvancedWorkspace/AdvancedWorkspace.jsx', import.meta.url),
    'utf8',
  );
  assert.match(workspace, /surfaceTools=\{showNodeList \? null : \{/);
});

test('la barre d’actions du diagramme n’apparaît que sans arbre', () => {
  const view = readFileSync(
    new URL('../src/workspace/WorkspaceView.jsx', import.meta.url),
    'utf8',
  );
  assert.match(view, /showActionsBar=\{showDiagram && !showTree\}/);
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
  assert.match(html, /1 raccord a été retiré/);
  assert.doesNotMatch(html, /Créé|Montrer/);
});

test('le CSS des actions à corriger : mise en page pour tous, couleurs sauf danger et désactivé', () => {
  const css = readFileSync(
    new URL('../src/components/layout/ValidationPill.css', import.meta.url),
    'utf8',
  );
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `règle absente : ${selector}`);
    return css.slice(start, css.indexOf('}', start));
  };
  const layout = rule('.validation-pill-details-actions .btn-xs');
  for (const declaration of ['white-space: normal', 'overflow-wrap: anywhere', 'height: auto', 'min-height: 26px', 'text-align: left']) {
    assert.ok(layout.includes(declaration), `mise en page : ${declaration}`);
  }
  assert.doesNotMatch(layout, /color|background/);

  const colors = rule('.validation-pill-details-actions .btn-xs:not(.btn-danger-outline):not(:disabled)');
  assert.match(colors, /color: var\(--warning-text\)/);
  assert.match(colors, /border-color: var\(--warning-border\)/);
  assert.doesNotMatch(colors, /white-space|height/);
  assert.match(
    css,
    /\.validation-pill-details-actions \.btn-xs:not\(\.btn-danger-outline\):not\(:disabled\):hover,\s*\.validation-pill-details-actions \.btn-xs:not\(\.btn-danger-outline\):not\(:disabled\):active \{/,
  );
});

for (const [label, title, projectName, hasSavePath, expected] of [
  ['titre du pack', 'Mon titre', 'Projet', true, 'Mon titre'],
  ['titre effacé, projet enregistré', '', 'Fichier projet', true, 'Fichier projet'],
  ['titre absent, jamais enregistré', '', 'Ancien nom local', false, 'Sans titre'],
]) {
  test(`bandeau commun : ${label}`, () => {
    const { elements } = mountSurface(createElement(TitleBar, {
      projectName, hasSavePath, projectFilePath: hasSavePath ? '/projets/Fichier projet.mbah' : null, packRecap: { title, line: 'v1' }, onOpenPackMetadata() {},
    }));
    assert.equal(elementByClass(elements, 'chrome-titlebar-pack-title').props.children, expected);
  });
}


for (const [workspaceMode, editor] of [['hierarchical', 'menus'], ['advanced', 'graphe']]) {
  test(`${editor} : le fichier sert au titre de repli, la puce Projet conserve projectName`, () => {
    const { elements } = mountShell(workspaceMode, { titleBar: {
      projectName: 'Nom du projet', projectFilePath: '/projets/Nom du fichier.mbah',
      hasSavePath: true, packRecap: { title: '', line: 'v1' },
    } });
    assert.equal(elementByClass(elements, 'chrome-titlebar-pack-title').props.children, 'Nom du fichier');
    assert.equal(elementByClass(elements, 'chrome-titlebar-project').props.children, 'Nom du projet');
  });
}
