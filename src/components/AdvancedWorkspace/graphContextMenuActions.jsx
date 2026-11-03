import { translateGraph as t } from '../../i18n/graphPresentation.js';
// Les actions du menu contextuel du graphe à plat.
//
// Pendant de `treeContextMenuActions.jsx` pour la surface avancée, et construit
// sur la même forme d'action — `{ icon, label, fn, disabledReason, danger }` —
// pour que le composant `ContextMenu` partagé n'ait rien à apprendre.
//
// **Deux règles tiennent ce fichier.**
//
// 1. *Une entrée par geste qui existe réellement.* Les actions
//    impossibles sont absentes, ou désactivées avec une raison
//    explicite. Le renommage reste volontairement dans l'inspecteur et au
//    double-clic, comme dans le Libre ; la couleur réutilise sa palette.
// 2. *Le clic droit n'est jamais le seul accès.* Les actions offertes ici
//    existent aussi dans l'inspecteur ou sur la surface. Ce menu est un
//    raccourci sur la carte, pas une fonction qu'on ne trouverait nulle part
//    ailleurs.

import {
  ClipboardPaste,
  Copy,
  Network,
  Package,
  Play,
  Scissors,
  SquareStack,
  Trash2,
  Waypoints,
} from '../icons/LucideLocal';
import { STAGE_KIND } from '../../store/advancedGraphView/graphViewModel.js';
import { actionDestinations } from './ListenFromActionDialog.jsx';
import { NodeColorPicker } from '../tree/NodeColorPicker.jsx';

export function buildGraphContextActions({
  inspected,
  index = null,
  editingDisabled = false,
  onSimulateFrom = null,
  // Sur une Action, la simulation passe par un choix de destination : la
  // commande reçue ici **ouvre ce choix**, elle ne lance pas le simulateur.
  onListenFromAction = null,
  selectedPaths = [],
  onCopy = null,
  onCut = null,
  onDuplicate = null,
  onSetColor = null,
  onViewConnections = null,
  onDelete = null,
  // Relire les raccourcis à l’affichage : une action peut survivre au changement de langue.
  shortcutLabels = {},
}) {
  if (!inspected) return [];
  const isStage = inspected.kind === STAGE_KIND;
  const actions = [];

  // La simulation est une **lecture** : elle n'écrit rien dans le document, et
  // reste donc offerte pendant qu'un geste ou un export suspend l'édition.
  // C'est la commande de `AdvancedWorkspace`, pas un second simulateur.
  if (isStage && onSimulateFrom) {
    actions.push({
      icon: <Play />,
      get label() { return t('graph:context.preview.label'); },
      fn: () => onSimulateFrom(inspected.path),
    });
  }

  // Sur une Action, la simulation exige de choisir d'abord une destination
  // exploitable, en respectant les occurrences et leur ordre. L'entrée ouvre
  // donc ce choix ; elle ne lance rien, et ne devine aucun départ implicite.
  if (!isStage && onListenFromAction) {
    const ready = actionDestinations(index, inspected.path)
      .filter((one) => one.state === 'ready');
    actions.push({
      icon: <Play />,
      get label() { return t('graph:context.preview.label'); },
      fn: () => onListenFromAction(inspected.path),
      get disabledReason() { return ready.length === 0
        ? t('graph:context.preview.disabled')
        : null; },
    });
  }

  if (onViewConnections) {
    actions.push({
      icon: <Network />,
      get label() { return t('graph:context.connections.label'); },
      fn: () => onViewConnections(inspected.path),
    });
  }

  // Ce sur quoi un geste de sélection agit : la sélection entière quand le nœud
  // visé lui appartient, le seul nœud visé sinon. C'est la règle du Libre, et
  // elle vaut pour la couleur comme pour le presse-papier — sans quoi un clic
  // droit dans une sélection de six nœuds n'en copierait qu'un.
  const targets = selectedPaths.includes(inspected.path) && selectedPaths.length > 1
    ? selectedPaths
    : [inspected.path];

  // Les mêmes trois dessins que l'arbre, pour les mêmes trois gestes : le clic
  // droit du graphe n'a pas à réapprendre un vocabulaire que l'auteur connaît.
  if ((onDuplicate || onCopy || onCut) && actions.length > 0 && actions.at(-1) !== 'sep') {
    actions.push('sep');
  }
  if (onDuplicate) {
    actions.push({
      icon: <SquareStack />,
      get label() { return targets.length > 1 ? t('graph:context.duplicate.count', { count: targets.length }) : t('graph:context.duplicate.single'); },
      fn: () => onDuplicate(targets),
      get shortcut() { return shortcutLabels.selectionDuplicate ?? null; },
      get disabledReason() { return editingDisabled
        ? t('graph:context.editing.busy')
        : null; },
    });
  }
  // Copier est une **lecture** : elle n'écrit rien dans le document, et reste
  // donc offerte pendant qu'un geste ou un export suspend l'édition.
  if (onCopy) {
    actions.push({
      icon: <Copy />,
      get label() { return targets.length > 1 ? t('graph:context.copy.count', { count: targets.length }) : t('graph:context.copy.single'); },
      fn: () => onCopy(targets),
      get shortcut() { return shortcutLabels.selectionCopy ?? null; },
    });
  }

  // Couper emporte le nœud **et** la plomberie qui le visait : ce qui survit
  // passe à `null`, et l'auteur le retrouve dans « Éléments à corriger ». C'est
  // ce qui la distingue de « Retirer… », qui demande le sort de chaque
  // référence et permet de recibler au lieu de casser.
  if (onCut) {
    const entry = targets.some((path) => {
      const node = index?.byPath.get(path)?.node;
      return node?.squareOne?.presence === 'value' && node.squareOne.value === true;
    });
    actions.push({
      icon: <Scissors />,
      get label() { return targets.length > 1 ? t('graph:context.cut.count', { count: targets.length }) : t('graph:context.cut.single'); },
      fn: () => onCut(targets),
      get shortcut() { return shortcutLabels.selectionCut ?? null; },
      get disabledReason() { return entry
        ? t('graph:remove.selection.entry')
        : editingDisabled
          ? t('graph:context.editing.busy')
          : null; },
    });
  }

  if (onSetColor) {
    const colors = targets
      .map((path) => index?.byPath.get(path)?.node?.personalColor ?? null);
    const distinct = [...new Set(colors)];
    const currentColor = distinct.length === 1 ? distinct[0] : '__mixed__';
    actions.push('sep');
    actions.push({
      type: 'node',
      render: () => (
        <NodeColorPicker
          label={targets.length > 1 ? t('graph:context.color.count', { count: targets.length }) : t('graph:context.color.single')}
          currentColor={currentColor}
          disabled={editingDisabled}
          onChange={(color) => onSetColor(targets, color)}
        />
      ),
    });
  }

  if (onDelete) {
    if (actions.at(-1) !== 'sep') actions.push('sep');
    // Comme Copier et Couper, Retirer vise la sélection entière quand le nœud
    // visé en fait partie. Un seul nœud passe par le parcours de retrait qui
    // inventorie ses références ; plusieurs, par une confirmation qui les
    // liste. Aucun ne se retire en silence.
    actions.push({
      icon: <Trash2 />,
      get label() { return targets.length > 1 ? t('graph:context.remove.count', { count: targets.length }) : t('graph:action.menu.remove'); },
      fn: () => onDelete(targets),
      danger: true,
      get shortcut() { return shortcutLabels.selectionDelete ?? null; },
      get disabledReason() { return editingDisabled
        ? t('graph:context.editing.busy')
        : null; },
    });
  }

  return actions;
}

// Les actions du clic droit **hors** de tout nœud.
//
// Elles n'agissent sur aucun nœud existant : c'est ce qui les distingue des
// précédentes, et ce qui autorise un menu là où le clic droit ne montrait rien.
// Le point qu'elles portent est en coordonnées de graphe, donc insensible à la
// caméra entre le clic et la validation du dialogue.
//
// « Coller ici » n'apparaît que lorsque le presse-papier porte quelque chose :
// la règle 1 de ce fichier veut une entrée par geste qui existe réellement, et
// une entrée morte serait un piège. Elle porte le même point que les créations,
// et y pose le coin haut-gauche du motif copié.
export function buildGraphSurfaceActions({
  graphPoint,
  editingDisabled = false,
  onCreateStage = null,
  onCreateAction = null,
  onPaste = null,
  clipboard = null,
  shortcutLabels = {},
}) {
  if (!graphPoint) return [];
  const actions = [];
  if (onCreateStage) {
    actions.push({
      icon: <Package />,
      get label() { return t('graph:context.create.stage'); },
      get shortcut() { return shortcutLabels.graphCreateStage ?? null; },
      get disabledReason() { return editingDisabled ? t('graph:context.editing.disabled') : null; },
      fn: () => onCreateStage(graphPoint),
    });
  }
  if (onCreateAction) {
    actions.push({
      icon: <Waypoints />,
      get label() { return t('graph:context.create.action'); },
      get shortcut() { return shortcutLabels.graphCreateAction ?? null; },
      get disabledReason() { return editingDisabled ? t('graph:context.editing.disabled') : null; },
      fn: () => onCreateAction(graphPoint),
    });
  }
  if (onPaste && clipboard) {
    const count = (clipboard.stages?.length ?? 0) + (clipboard.actions?.length ?? 0);
    actions.push('sep');
    actions.push({
      icon: <ClipboardPaste />,
      get label() { return count > 1 ? t('graph:context.paste.count', { count }) : t('graph:context.paste.single'); },
      get shortcut() { return shortcutLabels.selectionPaste ?? null; },
      get disabledReason() { return editingDisabled ? t('graph:context.editing.disabled') : null; },
      fn: () => onPaste(graphPoint),
    });
  }
  return actions;
}
