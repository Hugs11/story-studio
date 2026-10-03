// La vue d'essai de l'Éditeur avancé, écrite **comme Rust la rend**.
//
// Elle est partagée par les suites du socle et de l'espace de
// travail : une seule graphie du DTO, pour qu'un champ ajouté au
// contrat de lecture n'ait qu'un endroit à suivre. Aucun moteur d'affichage
// n'est chargé ici, et c'est la démonstration que la frontière tient.

export function presence(value) {
  return value === undefined
    ? { presence: 'absent', value: null }
    : value === null
      ? { presence: 'null', value: null }
      : { presence: 'value', value };
}

export function stage(uuid, overrides = {}) {
  return {
    path: `/stageNodes/@uuid=${uuid}#0`,
    uuid,
    occurrence: 0,
    uniqueId: true,
    name: presence(undefined),
    fallbackLabel: '',
    stageType: presence(undefined),
    squareOne: presence(undefined),
    groupId: presence(undefined),
    controls: {
      presence: 'absent',
      wheel: presence(undefined),
      ok: presence(undefined),
      home: presence(undefined),
      pause: presence(undefined),
      autoplay: presence(undefined),
      complete: false,
    },
    audio: { presence: 'absent', assetRef: null },
    image: { presence: 'absent', assetRef: null },
    okTransition: { presence: 'absent', actionId: null, actionPath: null, selection: null, withinBounds: false, selectedOptionId: null, resolvedStagePath: null },
    homeTransition: { presence: 'absent', actionId: null, actionPath: null, selection: null, withinBounds: false, selectedOptionId: null, resolvedStagePath: null },
    sourcePosition: null,
    layout: { x: 0, y: 0, source: 'fallback', origin: null },
    provenance: { uuid: 'source-studio', name: 'source-studio', position: 'source-studio' },
    ...overrides,
  };
}

export function action(id, options, overrides = {}) {
  return {
    path: `/actionNodes/@id=${id}#0`,
    id,
    occurrence: 0,
    uniqueId: true,
    name: presence(undefined),
    fallbackLabel: 'Action node',
    actionType: presence(undefined),
    groupId: presence(undefined),
    options: options.map((target, ordinal) => ({
      optionId: `/actionNodes/@id=${id}#0/options#${ordinal}`,
      ordinal,
      target: {
        presence: target === null ? 'null' : 'value',
        stageUuid: target,
        stagePath: target === null ? null : `/stageNodes/@uuid=${target}#0`,
        dangling: false,
      },
    })),
    sourcePosition: null,
    layout: { x: 0, y: 96, source: 'fallback', origin: null },
    provenance: { id: 'source-studio', name: 'source-studio', position: 'source-studio' },
    ...overrides,
  };
}

export function sampleView() {
  const entry = stage('entry', {
    name: presence('Entrée'),
    squareOne: presence(true),
    audio: { presence: 'value', assetRef: 'commun.mp3' },
    layout: { x: 0, y: 0, source: 'authored', origin: 'source-studio' },
    okTransition: {
      presence: 'value',
      actionId: 'choix',
      actionPath: '/actionNodes/@id=choix#0',
      selection: { kind: 'fixed', index: 0 },
      withinBounds: true,
      selectedOptionId: '/actionNodes/@id=choix#0/options#0',
      resolvedStagePath: '/stageNodes/@uuid=cible#0',
    },
  });
  const cible = stage('cible', {
    name: presence('Cible'),
    audio: { presence: 'value', assetRef: 'commun.mp3' },
    layout: { x: 240, y: 0, source: 'authored', origin: 'source-studio' },
  });
  const isole = stage('isole', {
    name: presence('Isolé'),
    layout: { x: 480, y: 160, source: 'fallback', origin: null },
  });
  const choix = action('choix', ['cible', 'cible']);
  return {
    viewVersion: 1,
    documentFingerprint: 'sha256:abc',
    documentOrigin: 'imported-studio',
    defaultValueOrigin: 'source-studio',
    packIdentity: { origin: 'square-one-stage', value: 'pack-1' },
    entry: { status: 'unique', stagePath: entry.path, candidates: [entry.path] },
    counts: { stages: 3, actions: 1, options: 2, edges: 3 },
    stages: [entry, cible, isole],
    actions: [choix],
    edges: [
      { edgeId: `${entry.path}::ok`, kind: 'stage-ok', from: entry.path, to: choix.path, optionId: null, ordinal: 0, selection: { kind: 'fixed', index: 0 }, dangling: false },
      { edgeId: `${choix.path}/options#0`, kind: 'action-option', from: choix.path, to: cible.path, optionId: `${choix.path}/options#0`, ordinal: 0, selection: null, dangling: false },
      { edgeId: `${choix.path}/options#1`, kind: 'action-option', from: choix.path, to: cible.path, optionId: `${choix.path}/options#1`, ordinal: 1, selection: null, dangling: false },
    ],
    mediaRefs: [{
      assetRef: 'commun.mp3',
      usages: [
        { nodePath: entry.path, field: 'audio' },
        { nodePath: cible.path, field: 'audio' },
      ],
    }],
    groups: [],
    opaqueMembers: [],
    diagnostics: [{
      family: 'authoring',
      level: 'ACTION_REQUIRED',
      severity: null,
      code: 'CONTROL_SETTINGS_INCOMPLETE',
      path: `${entry.path}/controlSettings`,
      nodePath: entry.path,
      message: 'Les cinq booléens doivent être renseignés.',
      resolutions: ['complete-control-settings'],
    }],
  };
}
