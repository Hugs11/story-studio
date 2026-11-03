import { translateGraph as t } from '../../i18n/graphPresentation.js';
// Ce qu'une résolution de diagnostic demande réellement à l'auteur.
//
// Règle tenue ici et vérifiée par les tests : **pas de dialogue sans
// chemin de résolution réel**. Chaque résolution rendue par Rust est donc
// traduite en l'une de trois natures, et une résolution sans traduction n'est
// pas offerte comme un bouton mort.
//
// - `gesture`  : la décision est une valeur, le geste part tel quel.
// - `form`     : la décision est un choix d'auteur que le geste ne peut pas
//                deviner — compléter les cinq contrôles, raccorder ou retirer
//                une Action orpheline. L'interface ouvre l'éditeur concerné.
// - `reveal`   : il n'existe pas de geste dédié ; la seule chose honnête est de
//                montrer le nœud et de laisser les gestes ordinaires agir.
//
// `UNTESTED` n'est pas un refus et un diagnostic n'est pas une erreur de
// génération : les trois familles restent distinctes, et aucune n'est rabattue
// sur les autres.

import { advancedGestures, graphNode, presence } from '../projectModel/advancedGestures.js';
import { ACTION_KIND, STAGE_KIND } from '../advancedGraphView/graphViewModel.js';

export const RESOLUTION_GESTURE = 'gesture';
export const RESOLUTION_FORM = 'form';
export const RESOLUTION_REVEAL = 'reveal';

const BLOCKING_COPY = Object.freeze({
  STAGE_ID_EMPTY: ['graph:diagnostics.structure.category', 'graph:diagnostics.stageId.empty'],
  DUPLICATE_STAGE_ID: ['graph:diagnostics.structure.category', 'graph:diagnostics.stageId.duplicate'],
  ACTION_ID_EMPTY: ['graph:diagnostics.structure.category', 'graph:diagnostics.actionId.empty'],
  DUPLICATE_ACTION_ID: ['graph:diagnostics.structure.category', 'graph:diagnostics.actionId.duplicate'],
  SQUARE_ONE_COUNT: ['graph:diagnostics.structure.category', 'graph:diagnostics.entry.count'],
  TRANSITION_ACTION_MISSING: ['graph:diagnostics.structure.category', 'graph:diagnostics.transition.missing'],
  OPTION_TARGET_NULL: ['graph:diagnostics.structure.category', 'graph:diagnostics.option.null'],
  OPTION_TARGET_MISSING: ['graph:diagnostics.structure.category', 'graph:diagnostics.option.missing'],
  OPTION_SELECTION_INVALID: ['graph:diagnostics.structure.category', 'graph:diagnostics.selection.invalid'],
  ENRICHED_GROUP_INCOHERENT: ['graph:diagnostics.decision.category', 'graph:diagnostics.group.incoherent'],
  ORPHAN_ACTION_AUTHORED_CONTENT: ['graph:diagnostics.structure.category', 'graph:diagnostics.action.orphan'],
  // Posé par une coupe, jamais déduit du document : un Écran sans destination
  // est indiscernable d'un Écran de fin, et un projet neuf en est un.
  TRANSITION_SEVERED_BY_REMOVAL: ['graph:diagnostics.structure.category', 'graph:diagnostics.transition.severed'],
  POSITION_DISPOSITION_STALE: ['graph:diagnostics.decision.category', 'graph:diagnostics.position.stale'],
  POSITION_OUT_OF_RANGE_ACTION_REQUIRED: ['graph:diagnostics.decision.category', 'graph:diagnostics.position.range'],
  OPAQUE_EXTENSION_DISPOSITION_STALE: ['graph:diagnostics.decision.category', 'graph:diagnostics.opaque.stale'],
  OPAQUE_EXTENSION_DISPOSITION_REQUIRED: ['graph:diagnostics.decision.category', 'graph:diagnostics.opaque.required'],
  CONTROL_SETTINGS_INCOMPLETE: ['graph:diagnostics.controls.category', 'graph:diagnostics.controls.incomplete'],
  // Règles de navigation de la Lunii (`port_rules.rs`), les mêmes qu'au
  // générateur par menus : la Lunii s'y bloque ou y montre un faux menu racine.
  HOME_LOOPS_TO_SELF: ['graph:diagnostics.navigation.category', 'graph:diagnostics.home.loop'],
  OK_LOOPS_TO_SELF: ['graph:diagnostics.navigation.category', 'graph:diagnostics.ok.loop'],
  OK_WITHOUT_USABLE_DESTINATION: ['graph:diagnostics.navigation.category', 'graph:diagnostics.ok.missing'],
  NO_USABLE_EXIT: ['graph:diagnostics.navigation.category', 'graph:diagnostics.exit.absent'],
  ENTRY_STAGE_AS_OPTION: ['graph:diagnostics.navigation.category', 'graph:diagnostics.entry.option'],
});

function blockingCopy(row) {
  return BLOCKING_COPY[row.code]
    ?? [row.source === 'decode' ? 'graph:diagnostics.document.category' : 'graph:diagnostics.structure.category',
      row.source === 'decode'
        ? 'graph:diagnostics.decode.invalid'
        : 'graph:diagnostics.structure.invalid'];
}

function fallbackNodePath(row, index) {
  if (row.code !== 'SQUARE_ONE_COUNT') return null;
  return [...(index?.byPath?.values?.() ?? [])]
    .find((entry) => entry.kind === STAGE_KIND)?.path ?? null;
}

function affectedNodeLabel(nodePath, index) {
  const entry = nodePath ? index?.byPath?.get(nodePath) : null;
  const label = entry?.label?.label;
  if (!label) return null;
  const kind = entry.kind === STAGE_KIND ? t('graph:type.stage.label')
    : entry.kind === ACTION_KIND ? t('graph:type.action.label') : t('graph:diagnostics.node.kind');
  return t('graph:diagnostics.node.label', { kind, name: label });
}

// La liste utilisateur ne reprend que les portes qui bloquent réellement la
// production. Les diagnostics informatifs restent disponibles aux logs et au
// moteur, mais ne deviennent jamais des choses « à corriger ».
export function buildAdvancedBlockingIssues({
  summary, diagnostics = [], usage = null, index = null, readinessError = null,
}) {
  /* eslint-disable i18next/no-literal-string -- Clé technique opaque composée de code, NUL et chemin ; aucun texte affiché. */
  const diagnosticByKey = new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.code}\u0000${diagnostic.path}`,
    diagnostic,
  ]));
  const issues = (summary?.blocking ?? []).map((row, position) => {
    const diagnostic = diagnosticByKey.get(`${row.code}\u0000${row.path}`) ?? null;
    /* eslint-enable i18next/no-literal-string */
    const [category, message] = blockingCopy(row);
    return {
      id: `blocking:${row.source}:${row.code}:${row.path}:${position}`,
      get category() { return t(category); },
      get message() { return t(message); },
      // Le chemin de secours sert à guider la réparation d'une erreur du
      // document ; il ne désigne pas un nœud fautif.
      get nodeLabel() { return affectedNodeLabel(diagnostic?.nodePath, index); },
      // L'absence d'Écran d'entrée concerne le document entier. On conduit
      // tout de même l'auteur vers un Écran existant pour qu'il puisse agir.
      nodePath: diagnostic?.nodePath ?? fallbackNodePath(row, index),
      diagnostic,
    };
  });

  if (readinessError) {
    issues.push({
      id: 'readiness:failed',
      get category() { return t('graph:diagnostics.document.category'); },
      get message() { return t('graph:diagnostics.readiness.failed'); },
      nodeLabel: null,
      nodePath: null,
      diagnostic: null,
    });
  }

  for (const entry of usage?.values?.() ?? []) {
    if (entry.unreferenced || (entry.bound && !entry.missing)) continue;
    const firstUsage = entry.usages?.[0] ?? null;
    const nodePath = firstUsage?.nodePath ?? null;
    const label = nodePath ? index?.byPath.get(nodePath)?.label?.label : null;
    const fieldKey = firstUsage?.field === 'image' ? 'graph:diagnostics.media.image' : 'graph:diagnostics.media.audio';
    issues.push({
      id: `media:${entry.assetRef}`,
      get category() { return t('graph:diagnostics.media.category'); },
      get nodeLabel() { return affectedNodeLabel(nodePath, index); },
      get message() { return label
        ? t('graph:diagnostics.media.named', { field: t(fieldKey), name: label })
        : t('graph:diagnostics.media.unnamed', { field: t(fieldKey) }); },
      nodePath,
      diagnostic: null,
    });
  }
  return issues;
}

const POSITION_DISPOSITIONS = Object.freeze({
  'scale-position-to-short-range': {
    disposition: 'scale-to-short-range',
    label: 'graph:diagnostics.position.scale',
  },
  'omit-position': {
    disposition: 'omit-explicitly',
    label: 'graph:diagnostics.position.omit',
  },
  'preserve-raw-accept-dantsu-loss': {
    disposition: 'preserve-raw-accept-dantsu-loss',
    label: 'graph:diagnostics.position.preserve',
  },
});

const OPAQUE_DISPOSITIONS = Object.freeze({
  'preserve-opaque-untested': {
    disposition: 'preserve-untested',
    label: 'graph:diagnostics.opaque.preserve',
  },
  'remove-opaque-explicitly': {
    disposition: 'remove-explicitly',
    label: 'graph:diagnostics.opaque.remove',
  },
  'promote-opaque-after-proof': {
    disposition: 'promote-after-proof',
    label: 'graph:diagnostics.opaque.promote',
  },
});

function nodeRefOf(index, nodePath) {
  const entry = nodePath ? index?.byPath.get(nodePath) : null;
  if (!entry) return null;
  return entry.kind === STAGE_KIND
    ? graphNode.stage(entry.node.uuid)
    : graphNode.action(entry.node.id);
}

// Le chemin que porte le diagnostic d'un membre opaque : celui de son porteur,
// suivi de sa clé en segment de pointeur JSON — la composition même de
// `diagnose_opaque_members`. Le `path` du DTO, lui, ne désigne que le porteur.
function opaqueMemberDiagnosticPath(member) {
  const segment = String(member?.key ?? '').replaceAll('~', '~0').replaceAll('/', '~1');
  return `${member.path}/${segment}`;
}

function opaqueMemberOf(view, path) {
  // Le membre est retrouvé par **comparaison exacte** du chemin. Les membres
  // d'une même clé se distinguent par `sourceOccurrence`, que le DTO porte :
  // en choisir un par défaut poserait la décision sur la mauvaise valeur.
  return (view?.opaqueMembers ?? []).filter((member) => opaqueMemberDiagnosticPath(member) === path);
}

function groupOf(view, index, nodePath) {
  const entry = nodePath ? index?.byPath.get(nodePath) : null;
  const groupId = entry?.node?.groupId?.presence === 'value' ? entry.node.groupId.value : null;
  if (groupId === null) return null;
  return (view?.groups ?? []).find((group) => group.groupId === groupId) ?? null;
}

// Les résolutions offertes pour un diagnostic, dans l'ordre où Rust les a
// rendues. Une résolution dont la cible ne se retrouve pas dans la vue courante
// est **omise** : offrir un bouton qui refuserait serait pire que ne rien
// offrir.
export function resolutionsForDiagnostic({ diagnostic, view, index }) {
  const offered = [];
  // Un pack malformé à zéro ou plusieurs racines s'ouvre dans le graphe :
  // l'intégrité ne bloque qu'à la production, et retirer une racine est
  // refusé. Rust n'émet aucune résolution pour les codes d'intégrité ; celle-ci
  // est la seule façon d'en sortir, et elle n'existe que pendant l'erreur — le
  // graphe n'offre plus de commande permanente de racine. `set-square-one`
  // pose l'Écran choisi et retire toutes les autres racines.
  if (diagnostic.code === 'SQUARE_ONE_COUNT') {
    const hasStage = (index?.entries ?? []).some((entry) => entry.kind === STAGE_KIND);
    if (hasStage) {
      offered.push({
        id: 'choose-square-one',
        nature: RESOLUTION_FORM,
        get label() { return t('graph:diagnostics.entry.choose'); },
        form: 'square-one',
        path: null,
      });
    }
  }
  for (const resolution of diagnostic.resolutions ?? []) {
    const position = POSITION_DISPOSITIONS[resolution];
    if (position) {
      const node = nodeRefOf(index, diagnostic.nodePath);
      if (!node) continue;
      offered.push({
        id: resolution,
        nature: RESOLUTION_GESTURE,
        get label() { return t(position.label); },
        gesture: advancedGestures.setPositionExportDisposition(node, position.disposition),
      });
      continue;
    }

    const opaque = OPAQUE_DISPOSITIONS[resolution];
    if (opaque) {
      const members = opaqueMemberOf(view, diagnostic.path);
      for (const member of members) {
        offered.push({
          id: `${resolution}#${member.sourceOccurrence}`,
          nature: RESOLUTION_GESTURE,
          get label() { return members.length > 1
            ? t('graph:diagnostics.opaque.occurrence', { decision: t(opaque.label), member: member.key, ordinal: member.sourceOccurrence })
            : t('graph:diagnostics.opaque.member', { decision: t(opaque.label), member: member.key }); },
          gesture: advancedGestures.setOpaqueExportDisposition(member, opaque.disposition),
        });
      }
      continue;
    }

    if (resolution === 'flatten-known-group') {
      const group = groupOf(view, index, diagnostic.nodePath);
      if (!group) continue;
      offered.push({
        id: resolution,
        nature: RESOLUTION_GESTURE,
        get label() { return t('graph:diagnostics.group.flatten', { name: group.groupId }); },
        destructive: true,
        gesture: advancedGestures.flattenKnownGroup(group.groupId),
      });
      continue;
    }

    if (resolution === 'repair-known-group') {
      const group = groupOf(view, index, diagnostic.nodePath);
      offered.push({
        id: resolution,
        nature: RESOLUTION_REVEAL,
        // Réparer un groupe, c'est en rétablir la forme avec les gestes
        // ordinaires : aucun geste ne le fait d'un coup, et prétendre
        // le contraire serait inventer une commande.
        get label() { return t('graph:diagnostics.group.reveal'); },
        paths: group ? [...group.stagePaths, ...group.actionPaths] : [diagnostic.nodePath],
      });
      continue;
    }

    if (resolution === 'complete-control-settings') {
      const entry = diagnostic.nodePath ? index?.byPath.get(diagnostic.nodePath) : null;
      if (entry?.kind !== STAGE_KIND) continue;
      offered.push({
        id: resolution,
        nature: RESOLUTION_FORM,
        // Compléter est un choix explicite des cinq valeurs. Les déduire ici
        // reviendrait à écrire `false` à la place de l'auteur.
        get label() { return t('graph:diagnostics.controls.complete'); },
        form: 'controls',
        path: diagnostic.nodePath,
      });
      continue;
    }

    if (resolution === 'clear-home-transition' || resolution === 'disable-home') {
      const entry = diagnostic.nodePath ? index?.byPath.get(diagnostic.nodePath) : null;
      if (entry?.kind !== STAGE_KIND) continue;
      offered.push(resolution === 'clear-home-transition'
        ? {
          id: resolution,
          nature: RESOLUTION_GESTURE,
          // Sans destination, Accueil revient au début du pack : le retour
          // Lunii par défaut.
          get label() { return t('graph:diagnostics.home.clear'); },
          gesture: advancedGestures.setStageTransition(entry.node.uuid, 'home', presence.null()),
        }
        : {
          id: resolution,
          nature: RESOLUTION_GESTURE,
          get label() { return t('graph:diagnostics.home.disable'); },
          gesture: advancedGestures.setStageControls(entry.node.uuid, { home: presence.value(false) }),
        });
      continue;
    }

    if (resolution === 'make-ending' || resolution === 'enable-home') {
      const entry = diagnostic.nodePath ? index?.byPath.get(diagnostic.nodePath) : null;
      if (entry?.kind !== STAGE_KIND) continue;
      // La fin validée sur la Lunii : Accueil sans destination ramène au
      // début. Aucune destination OK n'est jamais créée ici.
      offered.push(resolution === 'make-ending'
        ? {
          id: resolution,
          nature: RESOLUTION_GESTURE,
          get label() { return t('graph:diagnostics.ending.make'); },
          gesture: advancedGestures.setStageControls(entry.node.uuid, {
            ok: presence.value(false),
            autoplay: presence.value(false),
            home: presence.value(true),
          }),
        }
        : {
          id: resolution,
          nature: RESOLUTION_GESTURE,
          get label() { return t('graph:diagnostics.home.enable'); },
          gesture: advancedGestures.setStageControls(entry.node.uuid, { home: presence.value(true) }),
        });
      continue;
    }

    if (resolution === 'connect-or-remove-orphan') {
      const entry = diagnostic.nodePath ? index?.byPath.get(diagnostic.nodePath) : null;
      if (entry?.kind !== ACTION_KIND) continue;
      offered.push({
        id: resolution,
        nature: RESOLUTION_FORM,
        get label() { return t('graph:diagnostics.action.connect'); },
        form: 'orphan-action',
        path: diagnostic.nodePath,
      });
      continue;
    }
  }
  return offered;
}

// Le regroupement par nœud que l'interface affiche. Les diagnostics sans nœud
// — ceux qui portent sur le document entier — restent visibles dans leur propre
// groupe plutôt que d'être rattachés arbitrairement au premier écran venu.
export function groupDiagnosticsByNode(diagnostics = []) {
  const byNode = new Map();
  const documentWide = [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic.nodePath) {
      documentWide.push(diagnostic);
      continue;
    }
    const list = byNode.get(diagnostic.nodePath) ?? [];
    list.push(diagnostic);
    byNode.set(diagnostic.nodePath, list);
  }
  return { byNode, documentWide };
}
