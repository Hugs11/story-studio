// Formes IPC des gestes d'auteur de l'Éditeur avancé.
//
// Ce module ne mute rien et n'ouvre jamais le payload : il assemble la demande
// que `applyAdvancedGesture` transmet à Rust, qui seul décode, valide et rend le
// payload suivant. Les chemins d'auteur (`path`, `optionId`) sont des **jetons
// opaques** venus du DTO de lecture : ils sont recopiés tels quels, jamais
// recomposés ni découpés ici.
//
// Les builders existent pour que l'interface n'écrive pas ces objets à la main.
// Une faute de frappe sur un nom de geste ou sur une forme de présence ne
// produirait pas un refus typé : elle produirait un refus de désérialisation,
// beaucoup plus loin de la cause.

// Les cinq contrôles du dialecte, dans leur ordre.
export const ADVANCED_CONTROL_KEYS = Object.freeze([
  'wheel',
  'ok',
  'home',
  'pause',
  'autoplay',
]);

export const ADVANCED_TRANSITION_SLOTS = Object.freeze(['ok', 'home']);

// Les quatre métadonnées que le document de graphe porte réellement. La fiche
// du pack Libre en affiche davantage — auteur, âge, producteur, bonus —, mais
// ceux-là ne servent côté Libre qu'à composer le nom du fichier exporté : ils
// n'ont pas d'équivalent dans le document, et Rust refuse un champ inconnu
// plutôt que de le perdre en silence.
const ADVANCED_METADATA_KEYS = Object.freeze([
  'title',
  'version',
  'description',
  'uuid',
  'packIdentity',
]);
export const ADVANCED_MEDIA_FIELDS = Object.freeze(['audio', 'image']);

// `-1` est `Random` dans le dialecte STUdio v1. Il n'est jamais
// rabattu vers `0`, et la sentinelle est nommée plutôt que recopiée.
export const RANDOM_OPTION_INDEX = -1;

function fail(message) {
  throw new TypeError(message);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} doit être une chaîne non vide.`);
  return value;
}

function requireRank(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} doit être un rang entier positif ou nul.`);
  return value;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} doit être l'un de : ${allowed.join(', ')}.`);
  return value;
}

// Les trois formes de présence (absent, `null`, valeur), sous la forme que Rust décode.
export const presence = Object.freeze({
  value: (value) => ({ form: 'set', value }),
  null: () => ({ form: 'null' }),
  absent: () => ({ form: 'absent' }),
});

// Les destinations d'une occurrence d'option. `createdStage` n'a de sens que
// dans une création de Stage ; ailleurs, Rust la refuse plutôt que de deviner.
export const optionTarget = Object.freeze({
  stage: (uuid) => ({ target: 'stage', uuid: requireText(uuid, 'uuid') }),
  null: () => ({ target: 'null' }),
  createdStage: () => ({ target: 'created-stage' }),
});

// La décision d'auteur exigée quand un retrait prive une transition de sa
// destination. `optionIndex` s'exprime dans la roue **résultante**.
export const selectionResolution = Object.freeze({
  select: (optionIndex) => ({ form: 'select', optionIndex }),
  random: () => ({ form: 'select', optionIndex: RANDOM_OPTION_INDEX }),
  removeAsNull: () => ({ form: 'null' }),
  removeAsAbsent: () => ({ form: 'absent' }),
});

export const optionResolution = Object.freeze({
  retarget: (uuid) => ({ form: 'retarget', uuid: requireText(uuid, 'uuid') }),
  null: () => ({ form: 'null' }),
  remove: () => ({ form: 'remove' }),
});

function selectionDecision({ stageUuid, slot, resolution }) {
  return {
    stageUuid: requireText(stageUuid, 'stageUuid'),
    slot: requireOneOf(slot, ADVANCED_TRANSITION_SLOTS, 'slot'),
    resolution,
  };
}

function node(kind, id) {
  return { kind: requireOneOf(kind, ['stage', 'action'], 'kind'), id: requireText(id, 'id') };
}

export const graphNode = Object.freeze({
  stage: (uuid) => node('stage', uuid),
  action: (id) => node('action', id),
});

export const advancedGestures = Object.freeze({
  // --- Contrôles : chaque booléen indépendamment -----
  setStageControls(stageUuid, members) {
    const named = Object.keys(members ?? {});
    if (named.length === 0) fail('Nommer au moins un contrôle à modifier.');
    named.forEach((key) => requireOneOf(key, ADVANCED_CONTROL_KEYS, 'contrôle'));
    return {
      gesture: 'set-stage-controls',
      stageUuid: requireText(stageUuid, 'stageUuid'),
      update: { form: 'members', members },
    };
  },
  // Les mêmes membres posés sur plusieurs Écrans d'une sélection : une seule
  // étape d'undo. Un Écran sans objet de contrôles fait refuser la demande
  // entière, comme il le ferait seul.
  setStagesControls(stageUuids, members) {
    if (!Array.isArray(stageUuids) || stageUuids.length === 0) fail('Désigner au moins un Écran.');
    const named = Object.keys(members ?? {});
    if (named.length === 0) fail('Nommer au moins un contrôle à modifier.');
    named.forEach((key) => requireOneOf(key, ADVANCED_CONTROL_KEYS, 'contrôle'));
    return {
      gesture: 'set-stages-controls',
      stageUuids: stageUuids.map((uuid) => requireText(uuid, 'stageUuid')),
      update: { form: 'members', members },
    };
  },
  // Le choix explicite des cinq valeurs : la seule façon de compléter un objet
  // absent, `null` ou partiel sans qu'un défaut soit inventé.
  completeStageControls(stageUuid, { wheel, ok, home, pause, autoplay }) {
    return {
      gesture: 'set-stage-controls',
      stageUuid: requireText(stageUuid, 'stageUuid'),
      update: { form: 'complete', wheel, ok, home, pause, autoplay },
    };
  },

  // --- Transitions --------------------------------------------------------
  setStageTransition(stageUuid, slot, update, activateControl = false) {
    return {
      gesture: 'set-stage-transition',
      stageUuid: requireText(stageUuid, 'stageUuid'),
      slot: requireOneOf(slot, ADVANCED_TRANSITION_SLOTS, 'slot'),
      update,
      ...(activateControl ? { activateControl: true } : {}),
    };
  },
  // Raccord graphique direct vers une Action vide : Rust réserve sa première
  // occurrence d'option et pose la transition dans une seule transaction.
  connectStageToEmptyAction(stageUuid, slot, actionNode, activateControl = false) {
    return {
      gesture: 'connect-stage-to-empty-action',
      stageUuid: requireText(stageUuid, 'stageUuid'),
      slot: requireOneOf(slot, ADVANCED_TRANSITION_SLOTS, 'slot'),
      actionNode: requireText(actionNode, 'actionNode'),
      ...(activateControl ? { activateControl: true } : {}),
    };
  },
  transitionTo: (actionNode, optionIndex) => ({
    form: 'set',
    actionNode: requireText(actionNode, 'actionNode'),
    optionIndex,
  }),

  // --- Options : l'identité d'une occurrence est son rang ------------------
  insertActionOption(actionId, index, target) {
    return {
      gesture: 'insert-action-option',
      actionId: requireText(actionId, 'actionId'),
      index: requireRank(index, 'index'),
      target,
    };
  },
  setActionOptionTarget(actionId, ordinal, target) {
    return {
      gesture: 'set-action-option-target',
      actionId: requireText(actionId, 'actionId'),
      ordinal: requireRank(ordinal, 'ordinal'),
      target,
    };
  },
  // La demande porte une permutation des rangs courants, pas une liste de
  // cibles : envoyer des cibles fusionnerait deux occurrences de même
  // destination, exactement ce que le panneau rend visible.
  reorderActionOptions(actionId, newPositionOfOld) {
    if (!Array.isArray(newPositionOfOld)) fail('newPositionOfOld doit être un tableau de rangs.');
    newPositionOfOld.forEach((rank) => requireRank(rank, 'newPositionOfOld[]'));
    return {
      gesture: 'reorder-action-options',
      actionId: requireText(actionId, 'actionId'),
      newPositionOfOld,
    };
  },
  removeActionOption(actionId, ordinal, selections = []) {
    return {
      gesture: 'remove-action-option',
      actionId: requireText(actionId, 'actionId'),
      ordinal: requireRank(ordinal, 'ordinal'),
      selections: selections.map(selectionDecision),
    };
  },

  // --- Médias -------------------------------------------------------------
  // Remplacement global : même référence, nouveau fichier, **tous** ses écrans.
  repointMedia(assetRef, { path = null, present = false } = {}) {
    return {
      gesture: 'repoint-media',
      assetRef: requireText(assetRef, 'assetRef'),
      location: { path, present },
    };
  },
  // Média d'un seul écran. Un emplacement fourni exige une référence libre ;
  // sans emplacement, la référence doit déjà être liée et elle est partagée.
  setStageMedia(stageUuid, field, update) {
    return {
      gesture: 'set-stage-media',
      stageUuid: requireText(stageUuid, 'stageUuid'),
      field: requireOneOf(field, ADVANCED_MEDIA_FIELDS, 'field'),
      update,
    };
  },
  stageMedia: (assetRef, location = null) => ({
    form: 'set',
    assetRef: requireText(assetRef, 'assetRef'),
    ...(location ? { location } : {}),
  }),

  // --- Créations ----------------------------------------------------------
  //
  // La position est un champ **frère** de la création, jamais un membre de la
  // requête : c'est la convention que `createLinkedNode` a posée, et elle tient
  // à ce que placer un nœud est un geste de vue là où le créer est un geste de
  // document. Les deux partent ensemble pour ne faire qu'un pas d'annulation.
  //
  // Absente, le nœud naît où la disposition le met — c'est le cas de la barre
  // d'outils, qui ne désigne aucun point. Un clic droit sur le canvas, lui, en
  // désigne un, et il est en **coordonnées de graphe**.
  createStage(stage, position = null) {
    return { gesture: 'create-stage', stage, ...(position ? { position } : {}) };
  },
  // Une Action peut naître détachée ; son raccord est un geste
  // distinct, `setStageTransition`, jamais un effet de bord de la création.
  createAction(action = {}, position = null) {
    return { gesture: 'create-action', action, ...(position ? { position } : {}) };
  },

  createConstruction(construction) {
    return { gesture: 'create-construction', construction };
  },
  createLinkedNode(linked) {
    return { gesture: 'create-linked-node', linked };
  },
  // Collage d'un sous-graphe : N Écrans, M Actions et leurs raccords internes
  // en **un** geste, donc un seul pas d'annulation. Le collage est clos sur
  // lui-même : ses options et ses transitions désignent ses propres nœuds par
  // leur **rang**, jamais par un uuid — un uuid collé désignerait le modèle.
  pasteSubgraph(subgraph) {
    return { gesture: 'paste-subgraph', subgraph };
  },

  // --- Nom et présentation ------------------------------------------------
  setNodeName(target, update) {
    return { gesture: 'set-node-name', node: target, update };
  },
  // Les chemins viennent du DTO et restent opaques. Une sélection multiple
  // produit un seul geste, donc une seule étape d'annulation.
  setNodeColor(paths, color) {
    if (!Array.isArray(paths) || paths.length === 0) fail('Nommer au moins un nœud à colorer.');
    paths.forEach((path) => requireText(path, 'paths[]'));
    return { gesture: 'set-node-color', paths, color: color ?? null };
  },

  // --- Retraits : refus inventorié, ou plan explicite en une transaction ---
  deleteStage(stageUuid, plan = null) {
    return {
      gesture: 'delete-stage',
      stageUuid: requireText(stageUuid, 'stageUuid'),
      ...(plan ? { plan } : {}),
    };
  },
  stageRemovalPlan({ options = [], selections = [] } = {}) {
    return {
      options: options.map(({ actionId, ordinal, resolution }) => ({
        actionId: requireText(actionId, 'actionId'),
        ordinal: requireRank(ordinal, 'ordinal'),
        resolution,
      })),
      selections: selections.map(selectionDecision),
    };
  },
  // Retrait d'un lot de nœuds en **un** geste, donc un seul pas d'annulation.
  // Le plan porte sur les seules références qui **survivent** au retrait :
  // celles venues d'un nœud que le geste retire aussi disparaissent avec lui et
  // n'ont rien à décider.
  deleteSubgraph(subgraph) {
    return { gesture: 'delete-subgraph', subgraph };
  },
  deleteAction(actionId, plan = null) {
    return {
      gesture: 'delete-action',
      actionId: requireText(actionId, 'actionId'),
      ...(plan ? { plan } : {}),
    };
  },
  actionRemovalPlan(transitions = []) {
    return {
      transitions: transitions.map(({ stageUuid, slot, update }) => ({
        stageUuid: requireText(stageUuid, 'stageUuid'),
        slot: requireOneOf(slot, ADVANCED_TRANSITION_SLOTS, 'slot'),
        update,
      })),
    };
  },

  // --- Entrée -------------------------------------------------------------
  // `packIdentity` ne suit pas l'entrée : elle est acquise une fois et reste
  // stable à travers la réassignation.
  setSquareOne(stageUuid) {
    return { gesture: 'set-square-one', stageUuid: requireText(stageUuid, 'stageUuid') };
  },

  // --- Métadonnées de tête -------------------------------------------------
  // Titre, version, description et racine `uuid` du document. Seuls les champs
  // **nommés** partent : un membre absent de `members` n'est pas touché, ce qui
  // est la moitié JS de la conservation des informations non visées.
  //
  // Un changement explicite d'UUID met à jour l'identité du pack livré et,
  // pour un document importé, sa racine `uuid` dans la même transaction.
  setDocumentMetadata(members) {
    const named = Object.keys(members ?? {});
    if (named.length === 0) fail('Nommer au moins une métadonnée à modifier.');
    named.forEach((key) => requireOneOf(key, ADVANCED_METADATA_KEYS, 'métadonnée'));
    return { gesture: 'set-document-metadata', update: { ...members } };
  },

  // --- Positions ----------------------------------------------------------
  // Déplacement d'auteur : le projet est modifié, le geste entre dans l'undo.
  setAuthoredPosition(nodeRef, position) {
    return { gesture: 'set-authored-position', node: nodeRef, position };
  },
  // Le glisser d'une sélection : tous les nœuds entraînés, une seule étape
  // d'undo. Chaque entrée est `{ node, position }`, comme une disposition.
  setAuthoredPositions(positions) {
    if (!Array.isArray(positions) || positions.length === 0) {
      fail('Un déplacement de groupe porte au moins un nœud.');
    }
    return { gesture: 'set-authored-positions', positions };
  },
  // Conservation d'une disposition de lecture : elle rejoint
  // `context.editorPositions` et ne touche pas au document.
  applyViewLayout(positions) {
    if (!Array.isArray(positions) || positions.length === 0) {
      fail('Une disposition conservée porte au moins un nœud.');
    }
    return { gesture: 'apply-view-layout', positions };
  },
  // Promotion explicite dans les métadonnées d'auteur. `outOfRange` est requis :
  // créer une valeur hors borne exige une décision explicite.
  applyLayoutToAuthoring(nodes, outOfRange) {
    return {
      gesture: 'apply-layout-to-authoring',
      nodes: nodes ?? [],
      outOfRange: requireOneOf(outOfRange, ['scale', 'omit', 'refuse'], 'outOfRange'),
    };
  },

  // --- Décisions d'export -------------------------------------------------
  setPositionExportDisposition(nodeRef, disposition) {
    return {
      gesture: 'set-position-export-disposition',
      node: nodeRef,
      disposition: requireOneOf(
        disposition,
        ['scale-to-short-range', 'omit-explicitly', 'preserve-raw-accept-dantsu-loss'],
        'disposition',
      ),
    };
  },
  // `member` est recopié depuis `OpaqueMemberView` : chemin, clé et occurrence.
  setOpaqueExportDisposition(member, disposition) {
    return {
      gesture: 'set-opaque-export-disposition',
      member: {
        path: requireText(member?.path, 'member.path'),
        key: requireText(member?.key, 'member.key'),
        sourceOccurrence: requireRank(member?.sourceOccurrence, 'member.sourceOccurrence'),
      },
      disposition: requireOneOf(
        disposition,
        ['preserve-untested', 'remove-explicitly', 'promote-after-proof', 'never-emit-standard'],
        'disposition',
      ),
    };
  },
  // Perte volontaire et irréversible de métadonnées source : Rust
  // refuse un groupe dont la forme lui est inconnue.
  flattenKnownGroup(groupId) {
    return { gesture: 'flatten-known-group', groupId: requireText(groupId, 'groupId') };
  },
});

// Les noms de gestes acceptés par `apply_advanced_gesture`, pour qu'une
// interface puisse les énumérer sans les retaper.
export const ADVANCED_GESTURE_NAMES = Object.freeze([
  'set-stage-controls',
  'set-stages-controls',
  'set-stage-transition',
  'connect-stage-to-empty-action',
  'insert-action-option',
  'set-action-option-target',
  'reorder-action-options',
  'remove-action-option',
  'repoint-media',
  'set-stage-media',
  'create-stage',
  'create-action',
  'create-construction',
  'create-linked-node',
  'paste-subgraph',
  'delete-stage',
  'delete-action',
  'delete-subgraph',
  'set-document-metadata',
  'set-node-name',
  'set-node-color',
  'set-square-one',
  'set-authored-position',
  'set-authored-positions',
  'apply-view-layout',
  'apply-layout-to-authoring',
  'set-position-export-disposition',
  'set-opaque-export-disposition',
  'flatten-known-group',
]);
