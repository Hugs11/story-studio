// Enveloppe du projet avancé : le seul endroit qui la fabrique et la modifie.
//
// Le payload d'auteur est une chaîne opaque. Aucune fonction de ce
// module ne l'ouvre, ne le réémet ni ne le compare autrement qu'à l'octet : une
// mutation d'auteur remplace la chaîne entière, produite par Rust. Une mutation
// de vue ne touche que `editorState`, une liaison média que sa liste. C'est ce
// qui garantit qu'aucune écriture d'auto-layout ne peut promouvoir une position
// projetée en position d'auteur : la seule porte est
// `apply_editor_position_to_authoring`, en Rust, et le code JavaScript ne l'appelle pas.

import { bumpPackVersion } from '../../utils/packConvention.js';
import { archiveNamingFields } from '../advancedExport/archiveName.js';
import { getUnpackedPackDetails } from '../unpackProject.js';
import { advancedGestures, presence } from './advancedGestures.js';
import { ProjectFormatError, readProjectEnvelope } from './envelope.js';
import { readMediaBindings } from './mediaBindings.js';
import { DERIVED_CONSTRUCTION_CREATION_ENABLED } from '../advancedAuthoring/constructions.js';

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

const ADVANCED_SCHEMA_VERSION = 4;
const ADVANCED_AUTHORING_MODE = 'advanced';
const ADVANCED_PROJECT_TYPE = 'advanced';
// Version du bloc de vue, indépendante du payload et du fichier (interface de
// l'éditeur avancé).
const EDITOR_STATE_VERSION = 1;

function defaultEditorState() {
  return { version: EDITOR_STATE_VERSION };
}

// Construction de l'enveloppe avancée à partir d'un payload **déjà acquis**.
// Ce module n'acquiert rien : générer une identité est le geste unique de
// l'acquisition, et le répéter ici en fabriquerait une seconde.
export function createAdvancedProject({
  payload,
  projectName = '',
  packMetadata = null,
  editorState = null,
  mediaBindings = [],
  // Vignette catalogue : média d'**enveloppe**, comme côté hiérarchique, et
  // non média du document. Absente, la couverture du pack reste dérivée de
  // l'image de l'Écran d'entrée, qui est le comportement d'origine.
  thumbnailImage = null,
} = {}) {
  const project = {
    schemaVersion: ADVANCED_SCHEMA_VERSION,
    authoringMode: ADVANCED_AUTHORING_MODE,
    projectType: ADVANCED_PROJECT_TYPE,
    projectName,
    ...(packMetadata ? { packMetadata } : {}),
    ...(thumbnailImage ? { thumbnailImage } : {}),
    rootEntries: [],
    authoring: {
      payload,
      editorState: editorState ?? defaultEditorState(),
      mediaBindings,
    },
  };
  // La porte d'enveloppe juge ce que ce module produit : un constructeur ne se
  // dispense pas de la vérification qu'un fichier reçu doit subir.
  readProjectEnvelope(project);
  return project;
}

export function readAuthoringPayload(project) {
  const payload = project?.authoring?.payload;
  return typeof payload === 'string' ? payload : null;
}

export function readEditorState(project) {
  const state = project?.authoring?.editorState;
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
}

function withAuthoring(project, fields) {
  return { ...project, authoring: { ...project.authoring, ...fields } };
}

// Mutation d'auteur : la chaîne entière est remplacée par celle que Rust vient
// de produire. Une chaîne identique rend un projet identique en signature.
export function withAuthoringPayload(project, payload) {
  return withAuthoring(project, { payload });
}

// Mutation de vue : viewport, sélection, replis, point de reprise. Jamais une
// position d'auteur, qui vit dans le payload et n'est lisible que par Rust.
export function withEditorState(project, editorState) {
  return withAuthoring(project, { editorState });
}

export function withMediaBindings(project, mediaBindings) {
  return withAuthoring(project, { mediaBindings });
}

// Acquisition d'un document créé dans Story Studio : **un** appel, donc un seul
// tirage d'identité pour toute la vie du projet. Ni la sauvegarde, ni la
// relecture, ni l'annulation ne repassent par là — elles transportent la chaîne
// acquise. C'est l'appelant, et lui seul, qui garantit l'unicité en n'appelant
// cette fonction qu'à la création d'un projet.
export async function acquireCreatedAdvancedProject({
  title = '',
  projectName = '',
  invokeCommand = invokeTauri,
} = {}) {
  const payload = await invokeCommand('create_advanced_document', { title });
  // Un nouveau projet graphe nomme son archive par convention, comme un projet
  // par menus : l'âge (3+ par défaut) est alors écrit dans `story.json`.
  return createAdvancedProject({
    payload,
    projectName: projectName || title,
    packMetadata: archiveNamingFields({ namingMode: 'convention', minAge: '3' }),
  });
}

// Acquisition d'un projet avancé depuis un pack STUdio ou un dossier FS : **un**
// appel, comme pour un document créé, et donc un seul tirage d'identité.
//
// Rust dépose les assets du pack dans `assetsDir` et rend, avec le payload, les
// liaisons produites depuis les références réelles du document. Elles ne sont ni
// fabriquées ni complétées ici : JavaScript n'ouvre pas le payload, il ne saurait
// pas quelles références il porte. Un asset absent de l'archive revient avec son
// chemin et le statut `missing` — il reste lié, donc retrouvable.
export async function acquireImportedAdvancedProject({
  packPath,
  assetsDir,
  workspaceDir,
  projectName = '',
  invokeCommand = invokeTauri,
} = {}) {
  const acquired = await invokeCommand('acquire_advanced_pack_document', {
    zipPath: packPath,
    destDir: assetsDir,
    workspaceDir,
  });
  // La porte d'enveloppe juge les liaisons reçues comme elle jugerait celles d'un
  // fichier : le producteur n'est pas dispensé de la forme fermée du contrat.
  return createAdvancedProject({
    payload: acquired.payload,
    projectName,
    mediaBindings: acquired.mediaBindings,
    thumbnailImage: acquired.thumbnailImage ?? null,
  });
}

// Le bloc que « Vérifier un pack » écrivait dans les packs corrigés, jusqu'à la
// 0.9.9. Aucun lecteur ne l'interprète ; il reste une extension opaque pour le
// dialecte, mais c'est la nôtre : la trancher n'est pas une décision d'auteur.
const OWN_LEGACY_EXTENSION_KEY = 'storyStudioMetadata';

// Ce que l'atterrissage d'un pack repris règle avant l'installation du projet,
// par les gestes d'auteur ordinaires — donc sous la même validation Rust que la
// fiche et les diagnostics, mais sans entrer dans l'historique d'annulation :
// l'auteur ne peut pas « annuler » l'atterrissage.
//
// - Un pack repris est une nouvelle révision : sa version devient celle
//   d'origine + 1 (2 sans version), la règle même de la chaîne Libre.
// - Le bloc que Story Studio a lui-même écrit est préservé tel quel, au lieu
//   de bloquer la génération sur une question que l'auteur n'a pas à se poser.
// - Le titre est lu comme côté Libre (`getUnpackedPackDetails`) : un titre de
//   convention (« 3+]Titre[by_Auteur_V5 ») rend son titre lisible au document,
//   et son âge, son auteur… aux champs de nommage de l'enveloppe, en
//   convention. L'export recompose alors la convention une seule fois.
export async function prepareImportedAdvancedProject(project, {
  invokeCommand = invokeTauri,
  packPath = '',
} = {}) {
  const view = await invokeCommand('read_advanced_graph_view', {
    payload: readAuthoringPayload(project),
  });
  const version = view?.metadata?.version;
  const current = version?.presence === 'value' ? version.value : null;
  const title = view?.metadata?.title;
  const documentTitle = title?.presence === 'value' ? String(title.value ?? '') : '';
  const { packMetadata: imported } = getUnpackedPackDetails({
    result: { title: documentTitle, packVersion: current },
    zipPath: packPath,
  });
  // Un document sans titre (projection FS) le reste : la production lui en
  // donne un de secours, sans l'inscrire dans le document d'auteur.
  const readableTitle = documentTitle.trim() ? imported.title : '';
  const metadata = {
    version: presence.value(bumpPackVersion(current)),
    ...(readableTitle && readableTitle !== documentTitle ? { title: presence.value(readableTitle) } : {}),
  };
  const gestures = [
    advancedGestures.setDocumentMetadata(metadata),
    ...(view?.opaqueMembers ?? [])
      .filter((member) => member.scope === 'root' && member.key === OWN_LEGACY_EXTENSION_KEY)
      .map((member) => advancedGestures.setOpaqueExportDisposition(member, 'preserve-untested')),
  ];
  let prepared = project;
  for (const gesture of gestures) {
    ({ project: prepared } = await applyAdvancedGesture(prepared, gesture, { invokeCommand }));
  }
  return {
    ...prepared,
    packMetadata: { ...(prepared.packMetadata ?? {}), ...archiveNamingFields(imported) },
  };
}

// Qualification d'export du payload **courant**, recalculée à chaque demande.
// Rien n'est mémorisé ici : le résultat n'entre ni dans le projet, ni dans le
// fichier, ni dans la signature de travail. Une édition change donc la
// readiness sans qu'un ancien `SUPPORTED` puisse survivre.
export async function assessAdvancedProjectReadiness(project, {
  invokeCommand = invokeTauri,
} = {}) {
  const payload = readAuthoringPayload(project);
  if (payload === null) return null;
  return invokeCommand('assess_advanced_payload_readiness', { payload });
}

// Geste d'auteur : éditer une transition, remplacer un média externe, créer ou
// retirer un Stage ou une Action.
//
// Payload et liaisons sont remplacés **ensemble** par ce que Rust vient de
// produire : ils dérivent du même document muté, et JavaScript n'ouvre toujours
// pas la chaîne — il ne saurait pas quelles références le geste a touchées.
// L'état d'éditeur n'est pas concerné : une position d'auteur ne rejoint le
// document que par `apply_editor_position_to_authoring`, en Rust.
//
// Le rapport ressort à côté du projet. Il porte les ancrages retirés ou
// retargetés et l'état des liaisons ; la readiness, elle, reste à demander sur
// le projet rendu, où elle est recalculée et jamais mémorisée.
export async function applyAdvancedGesture(project, gesture, { invokeCommand = invokeTauri } = {}) {
  if (gesture?.gesture === 'create-construction' && !DERIVED_CONSTRUCTION_CREATION_ENABLED) {
    throw new Error('La création de constructions dérivées est indisponible.');
  }
  const payload = readAuthoringPayload(project);
  if (payload === null) {
    throw new ProjectFormatError(
      'ADVANCED_CODEC_REQUIRED',
      '/authoring/payload',
      'absent',
      "un projet avancé porteur d'un payload d'auteur",
    );
  }
  const outcome = await invokeCommand('apply_advanced_gesture', {
    payload,
    mediaBindings: readMediaBindings(project),
    gesture,
  });
  const next = withMediaBindings(withAuthoringPayload(project, outcome.payload), outcome.mediaBindings);
  // La porte d'enveloppe juge ce que ce module produit, comme elle juge un
  // fichier reçu : un geste n'est pas dispensé de la forme fermée du contrat.
  readProjectEnvelope(next);
  return { project: next, report: outcome.report };
}
