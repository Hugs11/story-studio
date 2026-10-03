// L'espace de travail de l'Éditeur avancé.
//
// C'est le prototype de lecture devenu un lieu d'édition : même
// session de vue, même canvas, même liste de recherche — et un inspecteur
// d'édition pour le nœud sélectionné.
//
// Ce composant n'ouvre jamais le payload et ne fabrique aucun chemin d'auteur :
// il assemble des gestes à partir de ce que le DTO lui a donné, et les confie à
// la session d'édition. Trois règles s'y voient :
//
// - **un geste validé = une étape d'undo**, tenue par le store, pas ici ;
// - **un glisser est local** jusqu'à son relâchement, puis part en un seul
//   geste ; un refus rend au nœud sa position du document ;
// - **la vue seule ne salit rien** : panoramique, zoom, sélection et focus
//   passent par la session de vue, qui n'écrit pas dans le projet.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import GraphCanvasStage from '../AdvancedGraphCanvas/GraphCanvasStage.jsx';
import { DEFAULT_EDGE_VISIBILITY } from '../AdvancedGraphCanvas/engines/engineContract.js';
import GraphSearchPanel, { GraphNodeListActions } from '../AdvancedGraphCanvas/GraphSearchPanel.jsx';
import { useAdvancedGraphView } from '../AdvancedGraphCanvas/useAdvancedGraphView.js';
import { shouldOpenSettingsForSelection } from '../../store/selectionOpensSettings.js';
import { ACTION_KIND, STAGE_KIND } from '../../store/advancedGraphView/graphViewModel.js';
import { nextDefaultNodeName, pruneReservedNames } from '../../store/advancedAuthoring/defaultNodeNames.js';
import { NO_FOLD, needsInitialLayout, parcoursLayout } from '../../store/advancedGraphView/graphParcoursLayout.js';
import {
  advancedGestures,
  graphNode,
  optionTarget,
  presence,
} from '../../store/projectModel/advancedGestures.js';
import { buildMediaUsageIndex, describeAdvancedMediaUsages } from '../../store/advancedAuthoring/mediaUsage.js';
import { advancedEntryImageRef } from '../../store/packMetadataModel.js';
import { buildAdvancedBlockingIssues } from '../../store/advancedAuthoring/diagnosticResolutions.js';
import { planStageMediaAssignment } from '../../store/advancedAuthoring/mediaDrop.js';
import {
  NODE_CASCADE_STEP_X,
  NODE_CASCADE_STEP_Y,
  freeNodeSpot,
  pruneReservedSpots,
  releaseReservedSpots,
} from '../../store/advancedAuthoring/nodePlacement.js';
import { subgraphRemovalPlan } from '../../store/advancedAuthoring/authoringPlans.js';
import { graphShortcutFor } from '../../store/advancedAuthoring/graphShortcuts.js';
import { getCurrentShortcuts } from '../../store/keyboardShortcuts.js';
import { useShortcutLabels } from '../../store/ShortcutLabelsContext.js';
import { GRAPH_ZOOM_STEP } from '../../store/advancedGraphView/graphGeometry.js';
import {
  describeGraphSelection,
  pasteLandingPoints,
  pasteSubgraphGesture,
  readGraphClipboard,
  writeGraphClipboard,
} from '../../store/advancedAuthoring/graphClipboard.js';
import {
  buildExistingGraphLinkGesture,
  isGraphLinkAutoApplyable,
  layoutEntriesFromPositions,
} from '../../store/advancedAuthoring/graphLinkDraft.js';
import { documentFlatGraph } from '../../tabs/EmulatorTab/flatGraph.js';
import { readAuthoringPayload } from '../../store/projectModel/authoring.js';
import { discardMediaCopies } from '../../store/projectIO.js';
import { useMediaTransfer } from '../../store/MediaTransferContext.js';
import { useProjectActions } from '../../store/ProjectActionsContext.js';
import { inspectNode } from '../../store/advancedGraphView/graphViewModel.js';
import {
  connectionNeighborhood,
  extendPlaybackTrace,
  playbackPresentation,
  PRESENTATION_CONNECTIONS,
} from '../../store/advancedGraphView/graphPresentation.js';
import { useRevealHistory } from '../AdvancedGraphCanvas/useRevealHistory.js';
import { GESTURE_APPLIED, GESTURE_REFUSED } from '../../hooks/useAdvancedAuthoring.js';
import { GESTURE_BUSY, documentUntouchedBy } from '../../store/advancedAuthoring/authoringSession.js';
import { useAdvancedReadiness } from '../../hooks/useAdvancedReadiness.js';
import {
  ADVANCED_INSPECTOR_WIDTH_DEFAULT,
  ADVANCED_INSPECTOR_WIDTH_MAX,
  ADVANCED_INSPECTOR_WIDTH_MIN,
  ADVANCED_NODE_LIST_WIDTH_DEFAULT,
  ADVANCED_NODE_LIST_WIDTH_MAX,
  ADVANCED_NODE_LIST_WIDTH_MIN,
  ADVANCED_WORKSPACE_PANEL_IDS,
  DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER,
  getAdvancedWorkspaceResizeBoundaries,
  getVisibleAdvancedWorkspacePanelOrder,
} from '../../workspace/panelLayout.js';
import { PanelSortContext, SortablePanelItem } from '../../workspace/PanelSortContext.jsx';
import { PanelResizeHandle } from '../structure/PanelResizeHandle.jsx';
import { useInspectorScrollMemory } from './useInspectorScrollMemory.js';
import {
  Fullscreen, ChevronDown, Waypoints, Wrench, X,
} from '../icons/LucideLocal.jsx';
import { SUSPENDED_BY_EXPORT, SUSPENDED_BY_GESTURE } from '../../store/toolbarModel.js';
import { CommandButton } from '../layout/Toolbar.jsx';
import { ActionEditor } from './ActionEditor.jsx';
import { ZipReviewPanel } from './ZipReviewPanel.jsx';
import { DocumentSimulationPanel } from './DocumentSimulationPanel.jsx';
import { CreateConstructionDialog } from './CreateConstructionDialog.jsx';
import { DeleteNodeDialog } from './DeleteNodeDialog.jsx';
import { DeleteSelectionDialog } from './DeleteSelectionDialog.jsx';
import { useGraphArrangement } from './useGraphArrangement.js';
import { RefusalNotice, ReportNotice } from './GestureFeedback.jsx';
import { RemoveOptionDialog } from './RemoveOptionDialog.jsx';
import { StageEditor } from './StageEditor.jsx';
import { SquareOneRepairForm } from './SquareOneRepairForm.jsx';
import { ContextMenu } from '../TreePanel/ContextMenu.jsx';
import { ListenFromActionDialog } from './ListenFromActionDialog.jsx';
import { buildGraphContextActions, buildGraphSurfaceActions } from './graphContextMenuActions.jsx';
import { GraphSelectionEditor } from './GraphSelectionEditor.jsx';
import { GraphLinkDialog } from './GraphLinkDialog.jsx';
import { NewStageDefaultsDialog } from './NewStageDefaultsDialog.jsx';
import { readNewStageControls } from '../../store/advancedAuthoring/newStageControls.js';
import { DERIVED_CONSTRUCTION_CREATION_ENABLED } from '../../store/advancedAuthoring/constructions.js';
import '../AdvancedGraphCanvas/AdvancedGraphCanvas.css';
import '../editors/EditorPanel.css';
import './AdvancedWorkspace.css';

// Les essais d'un dépôt de média refusé parce qu'un autre geste est en vol :
// assez pour une génération groupée qui rend ses audios en rafale, borné pour
// qu'un verrou qui ne se lève pas ne fasse pas tourner la boucle sans fin.
const MEDIA_RETRY_LIMIT = 50;

// Les commandes d'un panneau vivent dans **son** en-tête, pas dans la barre du
// haut : créer un nœud est un geste du graphe, et l'éloigner de la surface qu'il
// sert obligeait l'auteur à traverser l'écran pour un geste qu'il fait souvent.
//
// Elles arrêtent le pointeur : l'en-tête est la poignée de déplacement du
// panneau, et un appui sur un bouton ne doit pas amorcer un glisser.
function AdvancedPanelHeader({ title, onClose = null, actions = null, dragHandleProps = {} }) {
  return (
    <header
      className={`advanced-panel-header${actions ? ' has-actions' : ''}`}
      {...dragHandleProps}
    >
      <strong className="advanced-panel-header__title">{title}</strong>
      {actions ? (
        <>
          <div
            className="advanced-panel-header__actions"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
          {/* Le contrepoids du titre. Deux côtés de même souplesse encadrant la
              rangée, c'est ce qui la met au **centre de l'en-tête** et non au
              centre de la place qui reste à droite du titre. */}
          <span className="advanced-panel-header__balance" aria-hidden="true" />
        </>
      ) : null}
      {onClose ? (
        <button
          type="button"
          className="advanced-panel-header__close"
          aria-label={`Fermer ${title.toLocaleLowerCase('fr')}`}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}

// Une commande d'en-tête. Elle emprunte le bouton **de la barre du haut**, avec
// son icône et son libellé : ces commandes en viennent, et rien de leur
// apparence ne doit changer du seul fait qu'elles ont déménagé. L'entrée est
// bâtie ici parce que l'inventaire de la barre ne les déclare plus.
function headerCommand(id, label, blockedReason, shortcut = null) {
  return {
    id,
    label,
    shortcut,
    available: !blockedReason,
    unavailableReason: blockedReason ?? '',
  };
}

export function AdvancedWorkspace({
  project,
  payload,
  projectDescriptor,
  projectEpoch,
  // Vrai quand ce projet vient d'être ouvert par « Modifier un pack » : seule
  // ouverture où un pack sans disposition est rangé seul.
  freshlyImported = false,
  authoring,
  exportState = null,
  bridge = null,
  // La barre est unique et vit au-dessus de cet espace. Les
  // commandes propres au graphe lui arrivent donc par une **demande** que cet
  // espace acquitte — le même grain que `pendingSimulateZipPath` ou que la
  // demande d'outil média —, et ce qu'elle doit afficher du document remonte
  // par `onDocumentInfo`. Aucune barre résiduelle n'est rendue ici.
  pendingCommand = null,
  onCommandConsumed = null,
  // Une demande de recentrage venue d'une autre surface — la médiathèque du
  // panneau du bas. Acquittée dès consommation, comme les commandes.
  pendingFocusPath = null,
  onFocusPathConsumed = null,
  onDocumentInfo = null,
  // La médiathèque commune vit dans le panneau du bas, qui est le frère
  // de cet espace et non son parent. Les usages d'un média — quels Écrans,
  // quels champs — ne sont connus que d'ici, où la vue et son index vivent.
  // Ils remontent donc par le même grain que `onDocumentInfo`.
  onMediaUsages = null,
  // Le compte rendu détaillé d'une fabrication se peint dans la file de
  // rendu, qui ne connaît pas la vue du graphe. Les chemins des Écrans lui sont
  // donc **tendus** — sans eux, un identifiant reste lisible mais ne conduit
  // plus au nœud.
  onStagePaths = null,
  // Vrai tant que la file porte un travail graphe demandé et pas encore
  // terminé. C'est la condition de suspension de l'édition, dérivée de la file
  // et jamais tenue ici.
  working = false,
  // Diagnostics, qualification et refus d'avant-moteur vivent dans la
  // pastille de la barre. L'espace publie leur contexte, mais ne peint plus
  // aucun tiroir sous le canvas.
  onIssuesContext = null,
  onOpenIssues = null,
  panelViewState = null,
  searchFocusTrigger = 0,
}) {
  const view = useAdvancedGraphView({ payload, projectDescriptor, projectEpoch, bridge });
  const { prepareMediaForProject, setGraphMediaTarget } = useMediaTransfer();
  // Les quatre outils de son et l'import de fichiers viennent du contexte
  // d'actions monté par `AppShell` autour des **deux** éditeurs. Ils ne sont ni
  // recopiés ni réemballés ici : seul leur point d'arrivée diffère, et cette
  // décision-là est prise chez l'hôte, pas dans cet espace.
  //
  // Non mémoïsé, pour la raison que `useProjectActionsValue` documente : le
  // contexte est reconstruit à chaque rendu, et `canRecord` avec lui. Un
  // `useMemo` figerait la disponibilité sans que rien ne le signale.
  const projectActions = useProjectActions();
  const mediaTools = {
    onImportMedia: projectActions.onImportMediaLibrary,
    onImportPodcast: projectActions.onImportPodcast,
    onImportYoutube: projectActions.onImportYoutube,
    onRecord: projectActions.onRecord,
    onGenerateStoryTts: projectActions.onGenerateStoryTts,
    canRecord: projectActions.canRecord,
    canGenerateStoryTts: projectActions.canGenerateStoryTts,
  };
  const focusRef = useRef(null);
  const graphCenterRef = useRef(null);
  // Les commandes de caméra de la scène et le point sous le pointeur, pour le
  // clavier (`GraphCanvasStage`).
  const cameraRef = useRef(null);
  // Les libellés effectifs des raccourcis, pour le menu contextuel du graphe.
  const shortcutLabels = useShortcutLabels();
  // Les places déjà distribuées que l'index ne montre pas encore. Voir
  // `nodePlacement.js` : un auteur qui enchaîne va plus vite que l'aller-retour
  // par Rust qui relit la vue.
  const reservedSpotsRef = useRef([]);
  const reservedNamesRef = useRef([]);
  const authoringRef = useRef(authoring);
  authoringRef.current = authoring;
  const [dialog, setDialog] = useState(null);
  // Le menu contextuel du graphe : la cible sous le pointeur et l'endroit où
  // poser le menu. La cible est **résolue par le moteur**, pas déduite de la
  // sélection.
  const [graphMenu, setGraphMenu] = useState(null);
  const [stageDefaultsMenu, setStageDefaultsMenu] = useState(null);
  const [reportSeen, setReportSeen] = useState(null);
  // La réparation d'un compte de racines faux, ouverte depuis « À corriger ».
  const [squareOneRepairOpen, setSquareOneRepairOpen] = useState(false);
  const [highlightControls, setHighlightControls] = useState(null);
  const [restoreToken, setRestoreToken] = useState(0);
  const [simulation, setSimulation] = useState(null);
  const [renamePath, setRenamePath] = useState(null);
  // L'Action dont le panneau doit ouvrir l'ajout d'une arrivée : le
  // « Raccorder » d'une Action orpheline, dans la liste des problèmes.
  const [wireRequestPath, setWireRequestPath] = useState(null);
  const [connectionView, setConnectionView] = useState(null);
  const [edgeVisibility, setEdgeVisibility] = useState(() => ({ ...DEFAULT_EDGE_VISIBILITY }));
  const [playbackView, setPlaybackView] = useState(null);
  const [nodeSearchActive, setNodeSearchActive] = useState(false);
  const [localSearchFocusTrigger, setLocalSearchFocusTrigger] = useState(0);

  const focusPath = useCallback((path, options) => focusRef.current?.(path, options), []);

  // Créer depuis l'en-tête ne désigne aucun point, là où un clic droit en
  // désigne un. Le nœud est donc posé au centre de ce que l'auteur regarde :
  // sans cela il naît où la disposition le met, et sur un gros pack il est
  // introuvable sans fouiller.
  const viewCenter = useCallback(() => graphCenterRef.current?.() ?? null, []);

  // La pastille est le témoin unique des blocages de production. Elle doit donc
  // rester juste même fermée ; la qualification reste une dérivée jetable et
  // n'est jamais mémorisée dans le projet.
  const readiness = useAdvancedReadiness({ project, enabled: true });

  const usage = useMemo(
    () => buildMediaUsageIndex(project, view.view),
    [project, view.view],
  );

  // Le seul chemin d'envoi d'un geste discret. Un refus ferme les dialogues :
  // leur brouillon a été consommé par la demande, et le message de refus porte
  // l'inventaire qui permet de recommencer sur des bases justes.
  const runGesture = useCallback(async (gesture, options) => {
    const outcome = await authoringRef.current.runGesture(gesture, options);
    if (outcome.status !== GESTURE_REFUSED) setDialog(null);
    return outcome;
  }, []);

  // **Créer d'abord, régler ensuite.**
  //
  // Un dialogue réclamait un pré-réglage — le nom, les cinq contrôles, une
  // première destination — avant que le nœud existe. C'était l'ordre inverse du
  // travail réel : on pose plusieurs nœuds, on les place, on les raccorde, et
  // on les remplit une fois la structure tenue. Le réglage vit dans
  // l'inspecteur, qui s'ouvre sur le nœud créé puisqu'il est sélectionné.
  //
  // Ce qui part est **exactement** ce que le dialogue envoyait quand on le
  // validait sans rien toucher : rien n'est inventé au passage, seule l'étape
  // qui le demandait disparaît.
  // La place réellement employée : celle qu'on a demandée si elle est libre,
  // sinon le premier cran libre de la cascade. Sans cela, dix créations depuis
  // l'en-tête empilaient dix cartes au centre de la vue.
  const placeAt = useCallback((position) => {
    if (!position) return null;
    const entries = view.index?.entries ?? [];
    const reserved = pruneReservedSpots(reservedSpotsRef.current, entries);
    const spot = freeNodeSpot(entries, position, { reserved });
    reservedSpotsRef.current = spot ? [...reserved, spot] : reserved;
    return spot;
  }, [view.index]);

  // Le nom par défaut, réservé comme la place : la vue n'est relue qu'après le
  // geste, et deux créations enchaînées recevraient sinon le même numéro.
  const reserveDefaultName = useCallback((kind) => {
    const reserved = pruneReservedNames(reservedNamesRef.current, view.index);
    const name = nextDefaultNodeName(view.index, kind, reserved);
    reservedNamesRef.current = [...reserved, name];
    return name;
  }, [view.index]);

  // Une réservation ne vaut que pour un geste qui pose son nœud. Refusé,
  // périmé, retenu par un export ou parti pendant un autre geste, il rend
  // ses places et ses noms : rien n'atterrira dessus pour les purger.
  const settleReservations = useCallback((outcome, { spots = [], names = [] }) => {
    if (outcome?.status !== GESTURE_APPLIED) {
      reservedSpotsRef.current = releaseReservedSpots(reservedSpotsRef.current, spots);
      reservedNamesRef.current = reservedNamesRef.current.filter((name) => !names.includes(name));
    }
    return outcome;
  }, []);

  const createStageAt = useCallback(async (position) => {
    const name = reserveDefaultName(STAGE_KIND);
    const spot = placeAt(position);
    const outcome = await runGesture(advancedGestures.createStage({
      name,
      // Les cinq booléens sont exigés de l'appelant. Le réglage
      // retenu par l'auteur les fournit tous, complétés s'il le faut.
      controls: { ...readNewStageControls() },
    }, spot));
    return settleReservations(outcome, { spots: spot ? [spot] : [], names: [name] });
  }, [placeAt, reserveDefaultName, runGesture, settleReservations]);

  const createActionAt = useCallback(async (position) => {
    const name = reserveDefaultName(ACTION_KIND);
    const spot = placeAt(position);
    const outcome = await runGesture(advancedGestures.createAction({
      id: null,
      name,
      // Une Action doit pouvoir être raccordée avant que son Écran suivant
      // existe : on réserve une première destination sans lui inventer de cible.
      options: [optionTarget.null()],
    }, spot));
    return settleReservations(outcome, { spots: spot ? [spot] : [], names: [name] });
  }, [placeAt, reserveDefaultName, runGesture, settleReservations]);

  // --- Presse-papier -------------------------------------------------------
  //
  // Le presse-papier lui-même vit dans un singleton de module
  // (`graphClipboard.js`) : il survit au démontage du panneau, ce qu'un état
  // React ne ferait pas. Aucun état local ne le double ici — le menu le relit à
  // chaque ouverture, et rien ne peut le changer pendant qu'il est ouvert.

  const copySelection = useCallback((paths) => {
    const description = describeGraphSelection(view.index, paths, project);
    if (!description) return null;
    return writeGraphClipboard(description);
  }, [project, view.index]);

  // Un motif se pose **en bloc** : la cascade s'applique à son ancre, jamais à
  // chaque carte. Décaler les cartes une à une détruirait exactement la forme
  // qu'on est venu copier. Les places occupées sont toutes retenues, parce que
  // ce sont toutes des places que la création suivante doit éviter.
  const placeBlockAt = useCallback((description, point) => {
    if (!point) return null;
    const entries = view.index?.entries ?? [];
    const reserved = pruneReservedSpots(reservedSpotsRef.current, entries);
    const anchor = freeNodeSpot(entries, point, { reserved });
    reservedSpotsRef.current = anchor
      ? [...reserved, ...pasteLandingPoints(description, anchor)]
      : reserved;
    return anchor;
  }, [view.index]);

  // N Écrans, M Actions et leur câblage en **un** geste, donc un seul pas
  // d'annulation. Un collage parti en N gestes laisserait un état à moitié collé
  // si l'un d'eux était refusé.
  const pasteAt = useCallback(async (point, description = readGraphClipboard()) => {
    if (!description) return null;
    const anchor = placeBlockAt(description, point);
    const spots = pasteLandingPoints(description, anchor);
    const gesture = pasteSubgraphGesture(description, anchor, project);
    if (!gesture) return settleReservations(null, { spots });
    return settleReservations(await runGesture(gesture), { spots });
  }, [placeBlockAt, project, runGesture, settleReservations]);

  // Dupliquer, c'est copier puis coller décalé — sans toucher au presse-papier :
  // l'auteur qui a copié un motif ailleurs le retrouve intact après avoir
  // dupliqué un nœud, comme dans le Libre. Le décalage est celui de la cascade,
  // et `freeNodeSpot` garantit ensuite que la copie ne se pose sur rien.
  const duplicateSelection = useCallback((paths) => {
    const description = describeGraphSelection(view.index, paths, project);
    if (!description) return null;
    return pasteAt({
      x: description.anchor.x + NODE_CASCADE_STEP_X,
      y: description.anchor.y + NODE_CASCADE_STEP_Y,
    }, description);
  }, [pasteAt, project, view.index]);

  // **Couper emporte la plomberie, et le dit.** Le plan met à `null` tout ce
  // qui survit et perdrait sa destination ; ce qui vient d'un nœud que la même
  // coupe emporte n'a rien à décider. Le tout part en un geste, donc en un seul
  // pas d'annulation.
  //
  // Le presse-papier est écrit **avant** l'envoi : après, les nœuds n'existent
  // plus et il n'y aurait plus rien à décrire. Un refus laisse donc une copie
  // de nœuds toujours en place, ce qui est exactement ce qu'un collage ferait
  // d'eux.
  const cutSelection = useCallback((paths) => {
    const description = describeGraphSelection(view.index, paths, project);
    const plan = subgraphRemovalPlan(view.index, paths);
    if (!description || !plan) return null;
    writeGraphClipboard(description);
    return runGesture(advancedGestures.deleteSubgraph(plan));
  }, [project, runGesture, view.index]);

  // Dépôt d'un média venu de la médiathèque.
  //
  // Côté Libre, ce geste écrit directement le champ de l'histoire. Ici il passe
  // par `set-stage-media` : une étape d'annulation, et le remplacement du
  // document par la session. Deux choses sont faites avant, dans cet ordre, et
  // chacune pour une raison précise.
  //
  // 1. La **copie dans l'espace de travail**, quand la préférence la demande.
  //    C'est la moitié disque du dépôt Libre, partagée telle quelle : le même
  //    fichier déposé des deux côtés est rangé au même endroit.
  // 2. Le **choix de la référence**, assemblé au moment de l'envoi et non au
  //    relâchement. Une référence encore libre est choisie contre la dernière
  //    valeur acceptée ; bâtie au rendu, elle pourrait désigner une référence
  //    qu'un geste accepté entre-temps vient de lier.
  //
  // Plusieurs fichiers déposés d'un coup : le premier, comme sur une histoire
  // de l'arbre. Un Écran porte un audio et une image, pas une file.
  //
  // Un dépôt peut arriver pendant un autre geste : les audios d'une génération
  // groupée reviennent de la file un par un, sans attendre l'auteur. Refusé
  // parce qu'un geste est en vol, il attend le repos et repart, au lieu de
  // perdre le média produit.
  const assignStageMedia = useCallback(async (stageUuid, kind, path) => {
    if (!path) return null;
    const build = (current) => {
      const plan = planStageMediaAssignment({
        project: current, stageUuid, kind, path,
      });
      // Un plan refusé ne part pas en geste vide : il est levé ici, dans le
      // `try` de la session, et ressort par la notice de refus comme n'importe
      // quel refus du codec. Le projet reste inchangé dans les deux cas.
      if (!plan.ok) throw Object.assign(new Error(plan.reason), { code: plan.code });
      return plan.gesture;
    };
    const current = authoringRef.current;
    let outcome = await current.runGestureFor('set-stage-media', build);
    for (let attempt = 0; outcome?.status === GESTURE_BUSY && attempt < MEDIA_RETRY_LIMIT; attempt += 1) {
      await current.whenIdle();
      outcome = await current.runGestureFor('set-stage-media', build);
    }
    return outcome;
  }, []);

  //
  // La copie précède le geste, qui a besoin du chemin final. Un geste qui n'est
  // pas appliqué — refusé, parti pendant un autre geste, retenu par un export,
  // périmé par un changement de projet — laisserait donc sur disque une copie
  // que rien ne désigne, et une de plus à chaque nouvel essai : elle est
  // retirée, avec ce que la copie a entraîné. Un geste appliqué puis annulé
  // garde la sienne, comme dans le Libre : Ctrl+Y en a besoin.
  const dropMediaOnStage = useCallback(async ({ stageUuid, kind, path, paths }) => {
    const source = (Array.isArray(paths) && paths.length > 0 ? paths[0] : path) || null;
    if (!source) return;
    const artifactCopies = [];
    const prepared = await prepareMediaForProject(source, { artifactCopies });
    const outcome = await assignStageMedia(stageUuid, kind, prepared);
    if (outcome?.status === GESTURE_APPLIED) return;
    await discardMediaCopies([{ from: source, to: prepared }, ...artifactCopies]);
  }, [assignStageMedia, prepareMediaForProject]);

  // Fin d'un glisser : **un seul** geste, avec les positions finales de tous
  // les nœuds entraînés — un seul quand l'auteur tire une carte, toute la
  // sélection quand il en tire une qui en fait partie. Les positions sont
  // bornées par le canvas avant d'arriver ici ; la butée est affichée
  // par l'étage de rendu.
  const commitPositions = useCallback(async (entries) => {
    const moved = entries.flatMap(({ path, x, y }) => {
      const entry = view.index?.byPath.get(path);
      if (!entry) return [];
      const node = entry.kind === STAGE_KIND
        ? graphNode.stage(entry.node.uuid)
        : graphNode.action(entry.node.id);
      return [{ path, node, position: { x, y } }];
    });
    if (moved.length === 0) return;
    const outcome = await authoring.coalesceGesture(
      `position:${moved.map(({ path }) => path).join('|')}`,
      () => (moved.length === 1
        ? advancedGestures.setAuthoredPosition(moved[0].node, moved[0].position)
        : advancedGestures.setAuthoredPositions(
          moved.map(({ node, position }) => ({ node, position })),
        )),
    );
    // Restauration visuelle : le document n'a pas bougé, donc le DTO non plus.
    // Sans ce rappel, le nœud resterait peint là où le pointeur l'a laissé —
    // après un refus comme pendant un export, qui tient le document.
    if (documentUntouchedBy(outcome)) setRestoreToken((token) => token + 1);
  }, [authoring, view.index]);

  // Attendre le nouvel index avant de révéler le nœud créé. Les chemins de
  // lecture viennent de Rust, jamais d'une concaténation d'ID.
  //
  // **Sélectionner, et pas seulement cadrer.** Un Écran neuf n'a ni nom, ni
  // vignette, ni raccord : au dézoom d'un gros pack, il est indiscernable du
  // fond, et le cadrer seul laissait l'auteur chercher au milieu de l'écran ce
  // qu'il venait de créer. Le halo de sélection est ce qui le rend trouvable —
  // c'est le même que celui d'un nœud cliqué, pour qu'il n'y ait rien de
  // nouveau à apprendre.
  //
  // Vaut pour toute création, pas seulement pour une construction dérivée :
  // c'est le nœud isolé qui se perd le plus facilement.
  //
  // Un collage, lui, crée N nœuds d'un coup : les sélectionner **tous** est ce
  // qui montre l'étendue de ce qui vient d'arriver, et ce qui rend le motif
  // déplaçable d'un seul glisser. Les constructions dérivées gardent leur nœud
  // d'entrée : elles ont une tête, un collage n'en a pas.
  const focusedCreation = useRef(null);
  useEffect(() => {
    const entry = authoring.lastReport;
    const created = entry?.report?.created;
    if (!created || focusedCreation.current === entry || !view.index) return;
    const pasted = entry.report.gesture === 'paste-subgraph' ? entry.report.construction : null;
    const stageUuids = new Set(pasted?.stages ?? (created.stageUuid ? [created.stageUuid] : []));
    const actionIds = new Set(
      pasted?.actions ?? (!created.stageUuid && created.actionId ? [created.actionId] : []),
    );
    const paths = view.index.entries
      .filter((candidate) => (candidate.kind === STAGE_KIND
        ? stageUuids.has(candidate.node.uuid)
        : actionIds.has(candidate.node.id)))
      .map((candidate) => candidate.path);
    if (paths.length === 0) return;
    focusedCreation.current = entry;
    view.noteSelection(paths, view.index, { focus: paths[0] });
    focusPath(paths[0]);
  }, [authoring.lastReport, view, focusPath]);

  // Lancer la simulation du projet en cours.
  //
  // Le graphe est assemblé **ici**, où la vue vit, puis figé : le simulateur
  // reçoit un instantané et non une vue qui se remplace sous ses pieds à chaque
  // frappe. Les liaisons média sont capturées avec lui : un remplacement
  // change ce qu'on entend sans toucher au payload.
  //
  // Rien n'est écrit : ni dans le document, ni dans l'état d'enregistrement.
  // Une simulation ne passe par aucun geste d'auteur, et c'est la raison pour
  // laquelle elle reste offerte pendant qu'un export tient le document.
  const startSimulation = useCallback((startPath = null) => {
    const graph = documentFlatGraph(view.view, project);
    if (!graph) return;
    // Une seule simulation à la fois. Les deux panneaux montent chacun un
    // simulateur flottant : ouverts ensemble, ils se superposeraient et
    // joueraient deux audios en même temps.
    exportState?.closeReview?.();
    setConnectionView(null);
    setPlaybackView({
      activePath: null,
      previousStagePath: null,
      trace: { nodePaths: [], edgeIds: [] },
      followCamera: true,
    });
    setSimulation({
      graph,
      // La trace doit rester fidèle à l'instantané simulé, même si l'auteur
      // modifie ensuite le document pendant que le simulateur reste ouvert.
      graphIndex: view.index,
      startId: startPath,
    });
  }, [exportState, project, view.view, view.index]);

  const closeSimulation = useCallback(() => {
    setSimulation(null);
    setPlaybackView(null);
  }, []);

  const showNodeConnections = useCallback((path) => {
    if (!view.index?.byPath.has(path)) return;
    setConnectionView({ path, levels: 1 });
    setGraphMenu(null);
  }, [view.index]);

  // L'Écran joué devient la sélection : le graphe n'a qu'une marque, et
  // l'inspecteur comme la liste suivent la lecture, comme dans le Libre. Un
  // Écran que le document courant ne porte plus — la simulation est un instantané —
  // laisse la sélection de l'auteur où elle est. La lecture n'entre pas dans
  // l'historique Précédent/Suivant : chaque pas l'y noierait.
  const handleActiveNodeChange = useCallback((stagePath, context) => {
    if (stagePath && view.index?.byPath.has(stagePath)) {
      view.noteSelection([stagePath], view.index, { focus: stagePath });
    }
    setPlaybackView((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        activePath: stagePath,
        previousStagePath: stagePath,
        trace: extendPlaybackTrace(
          simulation?.graphIndex ?? view.index,
          previous.trace,
          previous.previousStagePath,
          stagePath,
          context,
        ),
      };
    });
  }, [simulation?.graphIndex, view.index, view.noteSelection]);

  // L'autre moitié de l'exclusion : relire l'archive ferme la simulation du document.
  // La dépendance est l'horodatage de la relecture, pas l'objet — celui-ci est
  // reconstruit à chaque rendu pour recalculer sa fraîcheur.
  const reviewOpenedAt = exportState?.review?.at ?? null;
  useEffect(() => {
    if (reviewOpenedAt !== null) closeSimulation();
  }, [reviewOpenedAt, closeSimulation]);

  // Une vue de connexions ne survit pas au document qui l'a produite. Si son
  // centre disparaît après une édition, revenir simplement à la vue complète.
  useEffect(() => {
    if (connectionView && !view.index?.byPath.has(connectionView.path)) {
      setConnectionView(null);
    }
  }, [connectionView, view.index]);

  // Changer de projet change l'identité de tous les chemins. Aucun voisinage,
  // parcours joué ou filtre HOME de l'ancien document ne doit le traverser.
  useEffect(() => {
    setConnectionView(null);
    setSimulation(null);
    setPlaybackView(null);
    setEdgeVisibility({ ...DEFAULT_EDGE_VISIBILITY });
    setDialog(null);
    setSquareOneRepairOpen(false);
    // Les places et les noms réservés sont des coordonnées et des numéros de
    // l'ancien document : ils écarteraient pour rien les créations du nouveau.
    reservedSpotsRef.current = [];
    reservedNamesRef.current = [];
  }, [projectEpoch]);

  useEffect(() => {
    if (dialog?.kind === 'graph-link' && dialog.index !== view.index) setDialog(null);
  }, [dialog, view.index]);

  // Les commandes propres au graphe arrivent de la barre unique. Elles sont
  // acquittées **dès** leur consommation : une demande qui resterait posée se
  // rejouerait au rendu suivant, et rouvrirait le dialogue que l'auteur vient
  // de fermer.
  useEffect(() => {
    if (!pendingCommand) return;
    if ((pendingCommand === 'export' || pendingCommand === 'diagnostics') && exportState) {
      onOpenIssues?.();
    }
    onCommandConsumed?.();
  }, [pendingCommand, exportState, onCommandConsumed, onOpenIssues]);

  // Ce que le bandeau et la fiche du pack doivent lire du document : la vue en
  // est la seule source, et elle vit ici. Rien n'est recopié dans le projet —
  // une copie dans l'enveloppe serait exactement la seconde vérité.
  //
  // La mémoïsation n'est pas une optimisation, c'est la condition d'arrêt. Cet
  // objet est remonté par un effet, et l'hôte le range dans un état : reconstruit
  // à chaque rendu, il repartait à chaque rendu, l'état changeait d'identité, et
  // le rendu suivant le reconstruisait. `view.view` ne change que lorsque la
  // session de vue émet, donc cet objet non plus.
  const documentInfo = useMemo(
    () => (view.view
      ? {
          metadata: view.view.metadata,
          packIdentity: view.view.packIdentity,
          documentOrigin: view.view.documentOrigin,
          counts: view.view.counts,
          entryImageRef: advancedEntryImageRef(view.index),
          entryTitle: view.index?.entries?.find((entry) => (
            entry.kind === 'stage' && entry.node?.squareOne?.value === true
          ))?.node?.name?.value ?? '',
        }
      : null),
    [view.view, view.index],
  );
  useEffect(() => {
    onDocumentInfo?.(documentInfo);
  }, [onDocumentInfo, documentInfo]);
  useEffect(() => () => onDocumentInfo?.(null), [onDocumentInfo]);

  // Même mémoïsation, et pour la même raison qu'au-dessus : l'hôte range cette
  // liste dans un état, donc elle doit garder son identité tant que la vue ne
  // change pas. `null` tant que la vue n'est pas lue — la médiathèque en fait
  // « non calculé », jamais « aucun usage ».
  const mediaUsages = useMemo(
    () => describeAdvancedMediaUsages(view.view, view.index),
    [view.view, view.index],
  );
  useEffect(() => {
    onMediaUsages?.(mediaUsages);
  }, [onMediaUsages, mediaUsages]);
  useEffect(() => () => onMediaUsages?.(null), [onMediaUsages]);

  // Les chemins des Écrans, par identifiant. Même mémoïsation, et pour la même
  // raison : l'hôte les range dans un état. Ils ne décrivent rien de plus que
  // ce que la vue porte déjà — c'est une projection, jamais une seconde vérité.
  const stagePaths = useMemo(
    () => (view.index?.entries ?? [])
      .filter((entry) => entry?.node?.uuid)
      .map((entry) => ({ uuid: entry.node.uuid, path: entry.path })),
    [view.index],
  );
  useEffect(() => {
    onStagePaths?.(stagePaths);
  }, [onStagePaths, stagePaths]);
  useEffect(() => () => onStagePaths?.(null), [onStagePaths]);

  // Un geste en vol et un export en cours suspendent tous deux l'édition, mais
  // ils ne se disent pas pareil : l'un dure le temps d'un aller-retour, l'autre
  // le temps d'une archive. La désactivation, elle, est la même.
  const editingDisabled = authoring.busy || authoring.locked === true;
  // La même raison que celle que la barre du haut affichait pour ces commandes,
  // prise aux mêmes constantes : le bouton a bougé, pas le motif de son refus.
  const creationBlocked = editingDisabled
    ? (authoring.locked === true ? SUSPENDED_BY_EXPORT : SUSPENDED_BY_GESTURE)
    : null;
  // Appliquer un rangement, c'est écrire des positions d'auteur — comme le
  // fait déjà un glisser, et par la même porte.
  //
  // Le chemin passe par les deux gestes existants : la disposition rejoint
  // `context.editorPositions`, puis `apply-layout-to-authoring` la promeut.
  // La politique de bornes est `refuse` parce qu'elle ne peut pas se
  // déclencher : `parcoursLayout` rend des entiers déjà contenus dans le
  // domaine des positions d'auteur. La demander à l'auteur reviendrait à lui
  // poser une question dont nous connaissons déjà la réponse ; la fixer à
  // `refuse` garde malgré tout le refus franc si cette garantie venait à
  // sauter, au lieu d'un arrondi silencieux.
  //
  // Les deux gestes font deux entrées d'undo. La première annulation rend
  // déjà la disposition précédente, la seconde retire la trace d'éditeur.
  const applyLayout = useCallback(async (positions, options) => {
    if (!view.index || positions.length === 0) return false;
    // Un nœud à identifiant dupliqué n'est adressable par aucun geste : le
    // moteur natif refuse de choisir entre deux homonymes. L'écarter laisse
    // ranger tout le reste, là où l'inclure ferait refuser le rangement
    // entier pour un défaut que ce rangement ne prétend pas réparer.
    const addressable = positions.filter(
      (position) => view.index.byPath.get(position.path)?.node.uniqueId !== false,
    );
    if (addressable.length === 0) return false;
    const staged = await runGesture(advancedGestures.applyViewLayout(
      layoutEntriesFromPositions(view.index, addressable),
    ), options);
    if (staged.status === GESTURE_REFUSED) return false;
    const promoted = await runGesture(advancedGestures.applyLayoutToAuthoring([], 'refuse'), options);
    return promoted.status !== GESTURE_REFUSED;
  }, [runGesture, view.index]);
  // Le rangement que le bouton de la colonne et le raccourci partagent.
  const arrangement = useGraphArrangement({
    index: view.index,
    applyLayout,
    disabled: editingDisabled,
  });
  // Un pack importé sans disposition lisible — aucune position, ou toutes au
  // même point — est rangé seul quand « Modifier un pack » l'ouvre, par le
  // même chemin que le bouton. Jamais à la réouverture d'un `.mbah` : ce que
  // l'auteur a enregistré, même empilé, est ce qu'il retrouve.
  // Le rangement est enregistré avec le projet mais n'ouvre **aucune** étape
  // d'undo : un Ctrl+Z juste après l'ouverture ne doit pas ré-empiler le
  // graphe. Une seule tentative par projet ouvert : un refus ne boucle pas, et
  // l'auteur garde le bouton. L'index doit être celui de ce projet — pendant
  // un changement de projet, la vue sert encore un rendu l'ancien.
  const autoLayoutEpochRef = useRef(null);
  useEffect(() => {
    const index = view.index;
    if (!freshlyImported || !index || editingDisabled) return;
    if (view.ticket?.projectEpoch !== projectEpoch) return;
    if (autoLayoutEpochRef.current === projectEpoch) return;
    autoLayoutEpochRef.current = projectEpoch;
    if (!needsInitialLayout(index)) return;
    const { positions } = parcoursLayout(index, NO_FOLD);
    if (positions.size === 0) return;
    void applyLayout(
      [...positions].map(([path, position]) => ({ path, ...position })),
      { history: false },
    );
  }, [applyLayout, editingDisabled, freshlyImported, projectEpoch, view.index, view.ticket]);
  // L'historique des révélations volontaires, par le hook que le banc de
  // recette monte aussi : la recette exerce donc, dans WebKitGTK, le code que
  // l'application exécute. Il est **distinct de l'annulation d'édition** — il
  // ne défait aucun geste, il déplace une lecture.
  const { index: viewIndex, selection, noteSelection } = view;

  // La médiathèque est un panneau frère du graphe. Publier l'Écran inspecté
  // permet d'y affecter un média sélectionné sans viser une carte minuscule
  // dans un graphe très dézoomé. Le dépôt et ce bouton partagent le même geste.
  const selectedNodeCount = selection.stages.length + selection.actions.length;
  const mediaTarget = selectedNodeCount <= 1 && view.inspected?.kind === STAGE_KIND
    ? view.inspected : null;
  const mediaTargetUuid = mediaTarget?.node.uuid ?? null;
  const mediaTargetLabel = mediaTarget?.label.label ?? null;
  useEffect(() => {
    if (!mediaTargetUuid || editingDisabled || view.status !== 'ready') {
      setGraphMediaTarget(null);
      return undefined;
    }
    setGraphMediaTarget({
      uuid: mediaTargetUuid,
      label: mediaTargetLabel,
      assign: ({ kind, path }) => dropMediaOnStage({ stageUuid: mediaTargetUuid, kind, path }),
    });
    return () => setGraphMediaTarget(null);
  }, [dropMediaOnStage, editingDisabled, mediaTargetLabel, mediaTargetUuid, setGraphMediaTarget, view.status]);

  // Le pas-à-pas sélectionne le nœud qu'il rejoint : sans cela, la liste et
  // l'inspecteur le suivaient pendant que la carte du graphe restait allumée
  // sur le dernier nœud cliqué.
  const selectVisited = useCallback(
    (path) => noteSelection([path], viewIndex, { focus: path }),
    [noteSelection, viewIndex],
  );
  const { revealPath, noteVisit, history: revealCommands } = useRevealHistory({
    index: view.index,
    viewport: view.viewport,
    focusPath,
    selectPath: selectVisited,
  });

  const selectAndRevealPath = useCallback((path, options = {}) => {
    noteSelection([path], viewIndex, { focus: path });
    revealPath(path, { ...options, updateFocus: false });
  }, [noteSelection, revealPath, viewIndex]);

  // Un formulaire demandé depuis la liste des problèmes vit dans le panneau
  // des réglages : il le rouvre s'il était fermé, comme le renommage et
  // l'explication d'une prise inactive.
  const openForm = useCallback((resolution) => {
    if (panelViewState?.showInspector === false) panelViewState.toggleInspector?.();
    if (resolution.form === 'controls') {
      selectAndRevealPath(resolution.path);
      setHighlightControls(resolution.path);
      return;
    }
    if (resolution.form === 'square-one') {
      // Aucun nœud ne porte l'erreur : le formulaire vit en tête du panneau.
      setSquareOneRepairOpen(true);
      return;
    }
    if (resolution.form === 'orphan-action') {
      // Raccorder **ou** retirer : les deux chemins existent réellement, et le
      // formulaire ne choisit pas à la place de l'auteur. Il révèle l'Action, où
      // le retrait est offert, et ouvre dans son panneau l'ajout d'une arrivée,
      // qui est l'autre moitié.
      selectAndRevealPath(resolution.path);
      setWireRequestPath(resolution.path);
    }
  }, [panelViewState, selectAndRevealPath]);

  // Révéler un Écran désigné ailleurs. La vue seule ne salit rien : recentrer
  // et sélectionner passent par la session de vue, qui n'écrit pas dans le
  // projet. La demande n'est acquittée qu'une fois l'index prêt — sinon elle
  // serait consommée avant que le nœud existe, et perdue.
  useEffect(() => {
    if (!pendingFocusPath || !view.index) return;
    if (view.index.byPath.has(pendingFocusPath)) selectAndRevealPath(pendingFocusPath);
    onFocusPathConsumed?.();
  }, [pendingFocusPath, view.index, selectAndRevealPath, onFocusPathConsumed]);

  const readinessView = useMemo(() => ({
    status: readiness.status,
    summary: readiness.summary,
    error: readiness.error,
    stale: readiness.stale,
    refresh: readiness.refresh,
  }), [
    readiness.status, readiness.summary, readiness.error, readiness.stale, readiness.refresh,
  ]);
  const blockingIssues = useMemo(() => buildAdvancedBlockingIssues({
    summary: readiness.summary,
    diagnostics: view.view?.diagnostics ?? [],
    usage,
    index: view.index,
    readinessError: readiness.status === 'failed' ? readiness.error : null,
  }), [readiness.summary, readiness.status, readiness.error, view.view?.diagnostics, usage, view.index]);
  const issuesExportState = useMemo(() => (exportState ? {
    refusal: exportState.refusal,
    dismissRefusal: exportState.dismissRefusal,
  } : null), [exportState?.refusal, exportState?.dismissRefusal]);
  const issuesContext = useMemo(() => (view.view ? {
    blockingIssues,
    view: view.view,
    index: view.index,
    disabled: editingDisabled,
    onFocusPath: selectAndRevealPath,
    onGesture: runGesture,
    onOpenForm: openForm,
    readiness: readinessView,
    exportState: issuesExportState,
    stagePaths,
    working,
  } : null), [
    view.view, view.index, editingDisabled, selectAndRevealPath, runGesture, openForm,
    blockingIssues, readinessView, issuesExportState, stagePaths, working,
  ]);
  useEffect(() => {
    onIssuesContext?.(issuesContext);
  }, [onIssuesContext, issuesContext]);
  useEffect(() => () => onIssuesContext?.(null), [onIssuesContext]);

  // Cliquer un nœud sur le canvas est la façon ordinaire de se déplacer dans
  // le graphe, et c'était la seule qui n'entrait pas dans l'historique : le
  // pas-à-pas restait donc grisé pour qui navigue à la carte plutôt que par
  // les panneaux.
  //
  // Seule une sélection **d'un seul nœud** compte. Un rectangle de sélection
  // n'est pas un déplacement, et empiler ses nœuds un par un rendrait le
  // Précédent inutilisable. Une désélection n'enregistre rien non plus.
  //
  // Une sélection non vide venue du graphe rouvre l'Inspecteur s'il était
  // fermé, comme une sélection du diagramme rouvre les Réglages du Libre : on
  // clique une carte pour l'éditer. La préférence commune aux deux éditeurs
  // peut le refuser (`selectionOpensSettings`).
  //
  // L'identité de cette fonction doit rester stable : elle entre dans les
  // dépendances du montage du moteur, qui se remonterait à chaque rendu. Les
  // préférences de panneaux sont donc relues par une ref, sans quoi fermer
  // l'Inspecteur remonterait le moteur.
  const panelViewStateRef = useRef(panelViewState);
  panelViewStateRef.current = panelViewState;
  const openInspectorForSelection = useCallback((count) => {
    const panels = panelViewStateRef.current;
    if (!panels?.toggleInspector) return;
    if (shouldOpenSettingsForSelection(count, { panelOpen: panels.showInspector !== false })) {
      panels.toggleInspector();
    }
  }, []);
  // La Liste des nœuds désigne un nœud comme l'arbre du Libre : elle le
  // sélectionne, le révèle, et rouvre l'Inspecteur selon la même règle.
  const selectFromNodeList = useCallback((path, options) => {
    selectAndRevealPath(path, options);
    openInspectorForSelection(1);
  }, [openInspectorForSelection, selectAndRevealPath]);
  const noteSelectionAsVisit = useCallback((paths, index, options) => {
    noteSelection(paths, index, options);
    if (paths.length === 1) noteVisit(paths[0]);
    openInspectorForSelection(paths.length);
  }, [noteSelection, noteVisit, openInspectorForSelection]);
  const canvasView = useMemo(
    () => ({ ...view, noteSelection: noteSelectionAsVisit }),
    [view, noteSelectionAsVisit],
  );

  // Clic droit sur une carte.
  //
  // Le menu vise le nœud sous le pointeur, même s'il diffère de la sélection.
  // Si la cible appartient déjà à une sélection multiple, celle-ci est
  // conservée — c'est le comportement du Libre, et la casser ferait perdre une
  // sélection que l'auteur vient de composer. Sinon la cible devient la
  // sélection, pour que l'auteur voie sur quoi il agit avant d'agir.
  // Les dépendances sont les **morceaux** de la vue, pas la vue entière :
  // `useAdvancedGraphView` rend un objet neuf à chaque rendu, et dépendre de
  // lui recréait ce rappel à chaque image d'un panoramique — donc décrochait
  // et raccrochait l'écouteur `contextmenu` du canvas soixante fois par
  // seconde.
  const openGraphMenu = useCallback(({ path, x, y }) => {
    const selected = new Set([...selection.stages, ...selection.actions]);
    noteSelection(selected.has(path) ? [...selected] : [path], viewIndex, { focus: path });
    setGraphMenu({ path, x, y });
  }, [selection, noteSelection, viewIndex]);

  // Le clic droit hors de tout nœud ouvre le **même** menu, sur d'autres
  // entrées : il porte un point de graphe au lieu d'un chemin de nœud. Deux
  // états séparés se seraient chevauchés à l'écran au premier clic enchaîné.
  const openSurfaceMenu = useCallback(({ graphPoint, x, y }) => {
    setGraphMenu({ path: null, graphPoint, x, y });
  }, []);

  const closeGraphMenu = useCallback(() => setGraphMenu(null), []);

  // Retirer un nœud, ou une sélection. Un seul nœud passe par le parcours de
  // retrait qui inventorie ses références ; plusieurs passent par le geste de
  // Couper, sans le presse-papier, et une confirmation qui les liste. C'est la
  // même demande pour la touche Suppr et pour « Retirer… » du clic droit.
  const requestRemoval = useCallback((paths) => {
    const entries = (paths ?? [])
      .map((path) => view.index?.byPath.get(path))
      .filter(Boolean);
    if (entries.length === 0) return;
    if (entries.length === 1) {
      setDialog({ kind: 'delete', nodeKind: entries[0].kind, path: entries[0].path });
      return;
    }
    setDialog({ kind: 'delete-selection', paths: entries.map((entry) => entry.path) });
  }, [view.index]);

  const requestNodeRename = useCallback((path) => {
    if (!viewIndex?.byPath.has(path)) return;
    noteSelection([path], viewIndex, { focus: path });
    if (panelViewState?.showInspector === false) panelViewState.toggleInspector?.();
    setRenamePath(path);
  }, [viewIndex, noteSelection, panelViewState]);

  const explainInactiveLinkPort = useCallback((path) => {
    if (!viewIndex?.byPath.has(path)) return;
    noteSelection([path], viewIndex, { focus: path });
    if (panelViewState?.showInspector === false) panelViewState.toggleInspector?.();
    setHighlightControls(path);
  }, [noteSelection, panelViewState, viewIndex]);

  const openGraphLinkDialog = useCallback((intent) => {
    setGraphMenu(null);
    if (isGraphLinkAutoApplyable(intent)) {
      void runGesture(buildExistingGraphLinkGesture(intent, {}));
      return;
    }
    setDialog({ kind: 'graph-link', intent, index: viewIndex });
  }, [runGesture, viewIndex]);

  // Voisinage et parcours joué passent par une seule présentation du moteur.
  // La lecture a priorité tant que le simulateur est ouvert.
  const graphPresentation = useMemo(() => {
    if (simulation && playbackView) {
      return playbackPresentation(playbackView.trace, {
        followCamera: playbackView.followCamera,
      });
    }
    if (connectionView && view.index) {
      return {
        mode: PRESENTATION_CONNECTIONS,
        ...connectionNeighborhood(
          view.index,
          connectionView.path,
          connectionView.levels,
          { showReturns: edgeVisibility.returns },
        ),
      };
    }
    return { mode: null, nodePaths: [], edgeIds: [] };
  }, [simulation, playbackView, connectionView, view.index, edgeVisibility.returns]);

  const presentationControls = useMemo(() => ({
    onExtend: connectionView
      ? () => setConnectionView((current) => (
          current ? { ...current, levels: current.levels + 1 } : current
        ))
      : null,
    onExit: connectionView
      ? () => {
          setConnectionView(null);
        }
      : null,
    followCamera: playbackView?.followCamera === true,
    onToggleFollow: playbackView
      ? () => setPlaybackView((current) => (
          current ? { ...current, followCamera: !current.followCamera } : current
        ))
      : null,
  }), [connectionView, playbackView]);

  // Les actions sont construites sur le nœud **visé**, relu dans l'index au
  // moment du rendu du menu : la sélection a pu changer entre le clic et le
  // rendu, et l'inspecteur n'est pas forcément sur la même cible.
  const graphMenuActions = useMemo(() => {
    if (!graphMenu || !view.index) return [];
    if (!graphMenu.path) {
      return buildGraphSurfaceActions({
        graphPoint: graphMenu.graphPoint,
        editingDisabled,
        shortcutLabels,
        // `ContextMenu` referme lui-même après l'action : rien à fermer ici.
        onCreateStage: (position) => { void createStageAt(position); },
        onCreateAction: (position) => { void createActionAt(position); },
        // Relu à **chaque ouverture** du menu : ce mémo se recalcule dès que
        // `graphMenu` change, et le presse-papier ne bouge pas menu ouvert.
        clipboard: readGraphClipboard(),
        onPaste: (position) => { void pasteAt(position); },
      });
    }
    return buildGraphContextActions({
      inspected: inspectNode(view.index, graphMenu.path),
      index: view.index,
      editingDisabled,
      shortcutLabels,
      onSimulateFrom: view.view ? startSimulation : null,
      onListenFromAction: view.view
        ? (path) => setDialog({ kind: 'listen-from-action', path })
        : null,
      selectedPaths: [...selection.stages, ...selection.actions],
      onCopy: copySelection,
      onCut: (paths) => { void cutSelection(paths); },
      onDuplicate: (paths) => { void duplicateSelection(paths); },
      onSetColor: (paths, color) => {
        void runGesture(advancedGestures.setNodeColor(paths, color));
        closeGraphMenu();
      },
      onViewConnections: showNodeConnections,
      onDelete: requestRemoval,
    });
  }, [
    graphMenu, view.index, view.view, editingDisabled, startSimulation, runGesture,
    selection, closeGraphMenu, showNodeConnections,
    copySelection, cutSelection, duplicateSelection, pasteAt, createStageAt, createActionAt, requestRemoval,
    shortcutLabels,
  ]);

  // Les raccourcis du graphe : ceux de la sélection, partagés avec l'arbre et
  // le diagramme du Libre, et ceux propres au graphe.
  //
  // Ils sont posés sur `window` parce que le canvas n'a pas le focus clavier :
  // on y désigne à la souris, et l'auteur n'a aucune raison d'avoir cliqué
  // avant de frapper. `graphShortcutFor` dit à quelle commande une frappe est
  // destinée, et rend celles qui vont à un champ, à une modale ou à un
  // dialogue ouvert.
  //
  // Ce qui naît au clavier — un Écran, une Action, un collage — naît **sous le
  // pointeur**, comme au clic droit, et au centre de la vue quand le pointeur
  // n'est pas sur le graphe.
  //
  // Seule une frappe réellement consommée est retenue : sans sélection, ou
  // sans presse-papier, la touche reste au navigateur et aux autres surfaces.
  // La table des commandes est relue à chaque rendu par une ref : l'écoute,
  // elle, n'est posée qu'une fois.
  const graphKeyboardRef = useRef(null);
  graphKeyboardRef.current = (event) => {
    const actionId = graphShortcutFor(event, {
      shortcuts: getCurrentShortcuts(),
      blocked: dialog !== null || renamePath !== null || simulation !== null,
      editingDisabled,
    });
    if (!actionId) return false;
    const paths = [...selection.stages, ...selection.actions];
    const here = () => cameraRef.current?.pointerPoint() ?? viewCenter();
    const camera = cameraRef.current;
    switch (actionId) {
      case 'selectionCopy':
        if (paths.length === 0) return false;
        copySelection(paths);
        return true;
      case 'selectionCut':
        if (paths.length === 0) return false;
        void cutSelection(paths);
        return true;
      case 'selectionDuplicate':
        if (paths.length === 0) return false;
        void duplicateSelection(paths);
        return true;
      case 'selectionPaste':
        if (!readGraphClipboard()) return false;
        void pasteAt(here());
        return true;
      case 'selectionDelete':
        if (paths.length === 0) return false;
        requestRemoval(paths);
        return true;
      case 'selectionRename':
        if (paths.length !== 1) return false;
        requestNodeRename(paths[0]);
        return true;
      case 'graphZoomIn':
      case 'graphZoomOut':
        if (!camera) return false;
        camera.zoomBy(actionId === 'graphZoomIn' ? GRAPH_ZOOM_STEP : 1 / GRAPH_ZOOM_STEP);
        return true;
      case 'graphFit':
        if (!camera) return false;
        camera.fit();
        return true;
      case 'graphVisitBack':
        if (!revealCommands?.canBack) return false;
        revealCommands.onBack();
        return true;
      case 'graphVisitForward':
        if (!revealCommands?.canForward) return false;
        revealCommands.onForward();
        return true;
      case 'graphCreateStage':
        void createStageAt(here());
        return true;
      case 'graphCreateAction':
        void createActionAt(here());
        return true;
      case 'graphToggleOverview':
        if (!panelViewState?.toggleOverview) return false;
        panelViewState.toggleOverview();
        return true;
      case 'graphArrange':
        if (arrangement.disabled || arrangement.busy) return false;
        void arrangement.arrange();
        return true;
      default:
        return false;
    }
  };
  useEffect(() => {
    const onKeyDown = (event) => {
      if (graphKeyboardRef.current?.(event)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Le panneau Réglages retrouve sa position quand on revient sur un nœud
  // récemment visité. La clé porte l'époque du projet : un autre document ne
  // reprend pas les positions du précédent.
  const inspectorScrollRef = useRef(null);
  const onInspectorScroll = useInspectorScrollMemory(
    inspectorScrollRef,
    view.inspected && selectedNodeCount <= 1 ? `${projectEpoch}:${view.inspected.path}` : null,
  );

  if (view.status === 'failed') {
    return (
      <div className="advanced-workspace advanced-workspace--error" role="alert">
        <h2>Lecture impossible</h2>
        {/* Les refus du codec ressortent tels quels : ils ne sont pas réécrits
            en codes de vue, et le projet reste ouvert et enregistrable. */}
        <p><code>{view.error?.code ?? 'ERREUR'}</code> {view.error?.path}</p>
        <p>{view.error?.message ?? String(view.error)}</p>
      </div>
    );
  }

  const inspected = view.inspected;
  // La sélection affichée, résolue contre l'index : un nœud retiré n'y compte
  // plus, même si le cache de vue le garde pour un undo.
  const selectedEntries = [...selection.stages, ...selection.actions]
    .map((path) => view.index?.byPath.get(path))
    .filter(Boolean);
  // Un rapport ne se montre que tant que le document est celui que son geste a
  // produit. Ctrl+Z le tait — il annoncerait un nœud retiré ou des raccords
  // rétablis — et Ctrl+Y, qui rend ce document, le fait revenir, juste de
  // nouveau. Seul le payload compte : un relevé de disque qui change l'état
  // d'une liaison ne rend pas le rapport faux.
  const lastReport = authoring.lastReport
    && readAuthoringPayload(authoring.lastReport.project) === readAuthoringPayload(project)
    ? authoring.lastReport
    : null;
  const showNodeList = panelViewState?.showNodeList ?? true;
  const showInspector = panelViewState?.showInspector ?? true;
  const panelOrder = panelViewState?.panelOrder ?? DEFAULT_ADVANCED_WORKSPACE_PANEL_ORDER;
  const visibility = {
    [ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST]: showNodeList,
    [ADVANCED_WORKSPACE_PANEL_IDS.GRAPH]: true,
    [ADVANCED_WORKSPACE_PANEL_IDS.INSPECTOR]: showInspector,
  };
  const visiblePanelOrder = getVisibleAdvancedWorkspacePanelOrder(panelOrder, visibility);
  const resizeBoundaries = getAdvancedWorkspaceResizeBoundaries(visiblePanelOrder);
  const resizeBoundaryByPair = new Map(resizeBoundaries.map((boundary) => [boundary.id, boundary]));
  const nodeListPanelWidth = panelViewState?.nodeListPanelWidth ?? ADVANCED_NODE_LIST_WIDTH_DEFAULT;
  const inspectorPanelWidth = panelViewState?.inspectorPanelWidth ?? ADVANCED_INSPECTOR_WIDTH_DEFAULT;
  const workspaceStyle = {
    '--advanced-node-list-panel-width': `${nodeListPanelWidth}px`,
    '--advanced-inspector-panel-width': `${inspectorPanelWidth}px`,
  };

  const renderResizeHandle = (boundary) => {
    const nodeListConfig = {
      ariaLabel: 'Redimensionner la liste des nœuds',
      panelClass: '.advanced-panel-slot--advanced-node-list',
      cssVar: '--advanced-node-list-panel-width',
      minWidth: ADVANCED_NODE_LIST_WIDTH_MIN,
      maxWidth: ADVANCED_NODE_LIST_WIDTH_MAX,
      value: nodeListPanelWidth,
      defaultValue: ADVANCED_NODE_LIST_WIDTH_DEFAULT,
      onResize: panelViewState?.setNodeListPanelWidth,
    };
    const inspectorConfig = {
      ariaLabel: 'Redimensionner les réglages',
      panelClass: '.advanced-panel-slot--advanced-inspector',
      cssVar: '--advanced-inspector-panel-width',
      minWidth: ADVANCED_INSPECTOR_WIDTH_MIN,
      maxWidth: ADVANCED_INSPECTOR_WIDTH_MAX,
      value: inspectorPanelWidth,
      defaultValue: ADVANCED_INSPECTOR_WIDTH_DEFAULT,
      onResize: panelViewState?.setInspectorPanelWidth,
    };
    const config = boundary.resizedPanelId === ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST
      ? nodeListConfig
      : inspectorConfig;
    if (!config.onResize) return null;
    return <PanelResizeHandle {...config} direction={boundary.direction} />;
  };

  const renderNodeListPanel = (dragHandleProps) => (
    <section className="advanced-panel advanced-panel--nodes" aria-label="Liste des nœuds et Écrans">
      {/* Cette liste est l'équivalent structurel de l'Arbre côté Libre. Elle
          garde sa recherche et ses compteurs, rendus dans sa barre ; les
          outils communs sont sur le L. */}
      <GraphSearchPanel
        renderHeader={(summary) => (
          <GraphNodeListActions
            onSearch={() => {
              setNodeSearchActive(true);
              setLocalSearchFocusTrigger((trigger) => trigger + 1);
            }}
            onClose={panelViewState?.toggleNodeList}
            summary={summary}
            dragHandleProps={dragHandleProps}
          />
        )}
        project={project}
        search={view.search}
        focus={view.focus}
        onFocusPath={selectFromNodeList}
        onContextMenuRequest={openGraphMenu}
        counts={view.view?.counts}
        entry={view.view?.entry}
        searchActive={nodeSearchActive}
        onSearchActiveChange={setNodeSearchActive}
        searchFocusTrigger={searchFocusTrigger + localSearchFocusTrigger}
      />
    </section>
  );

  const renderGraphPanel = (dragHandleProps) => (
    <section className="advanced-panel advanced-panel--graph" aria-label="Graphe">
      <AdvancedPanelHeader
        title="Graphe"
        dragHandleProps={dragHandleProps}
        actions={(
          <>
            {/* Chaque création porte le dessin de la nature qu'elle crée, celui
                de la liste et du canvas. */}
            <div
              className="advanced-create-stage-split"
              onMouseLeave={() => setStageDefaultsMenu(null)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setStageDefaultsMenu(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setStageDefaultsMenu(null);
                  event.currentTarget.querySelector('.advanced-create-stage-split__toggle')?.focus();
                }
              }}
            >
              <CommandButton
                entry={headerCommand('createStage', 'Créer un Écran…', creationBlocked, shortcutLabels.graphCreateStage)}
                Icon={Fullscreen}
                onClick={() => createStageAt(viewCenter())}
              />
              <button
                type="button"
                className="chrome-toolbar-btn is-icon-only advanced-create-stage-split__toggle"
                aria-label="Options de création d’un Écran"
                aria-haspopup="menu"
                aria-expanded={Boolean(stageDefaultsMenu)}
                onMouseEnter={() => setStageDefaultsMenu(true)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setStageDefaultsMenu(true);
                  }
                }}
                onClick={() => setStageDefaultsMenu(true)}
              >
                <ChevronDown className="chrome-icon" aria-hidden="true" />
              </button>
              {stageDefaultsMenu && (
                <div className="advanced-create-stage-menu" role="menu" aria-label="Options de création d’un Écran">
                  <button
                    type="button"
                    role="menuitem"
                    className="advanced-create-stage-menu__item"
                    onClick={() => {
                      setStageDefaultsMenu(null);
                      setDialog({ kind: 'new-stage-defaults' });
                    }}
                  >
                    Écran par défaut…
                  </button>
                </div>
              )}
            </div>
            <CommandButton
              entry={headerCommand('createAction', 'Créer une liste de choix…', creationBlocked, shortcutLabels.graphCreateAction)}
              className="advanced-create-command"
              Icon={Waypoints}
              onClick={() => createActionAt(viewCenter())}
            />
            {DERIVED_CONSTRUCTION_CREATION_ENABLED && <CommandButton
              entry={headerCommand('createConstruction', 'Constructions dérivées…', creationBlocked)}
              className="advanced-create-command"
              Icon={Wrench}
              onClick={() => setDialog({ kind: 'create-construction' })}
            />}
          </>
        )}
      />
      <GraphCanvasStage
        view={canvasView}
        project={project}
        surfaceTools={{
          ...mediaTools,
          onSimulate: view.view ? () => startSimulation(null) : null,
          onSearch: () => {
            if (panelViewState?.showNodeList === false) panelViewState.toggleNodeList?.();
            setNodeSearchActive(true);
            setLocalSearchFocusTrigger((trigger) => trigger + 1);
          },
        }}
        onAuthoredPositionsChange={commitPositions}
        onMediaDrop={editingDisabled ? null : dropMediaOnStage}
        onNodeContextMenu={openGraphMenu}
        onSurfaceContextMenu={openSurfaceMenu}
        onNodeDoubleClick={requestNodeRename}
        onGraphLinkIntent={editingDisabled ? null : openGraphLinkDialog}
        onInactiveLinkPort={explainInactiveLinkPort}
        presentation={graphPresentation}
        presentationControls={presentationControls}
        edgeVisibility={edgeVisibility}
        onEdgeVisibilityChange={setEdgeVisibility}
        history={revealCommands}
        arrangement={arrangement}
        overviewOpen={panelViewState?.showOverview ?? true}
        onToggleOverview={panelViewState?.toggleOverview ?? null}
        cameraTarget={playbackView?.followCamera ? playbackView.activePath : null}
        focusRef={focusRef}
        graphCenterRef={graphCenterRef}
        cameraRef={cameraRef}
        restoreToken={restoreToken}
      >
        {graphMenu && graphMenuActions.length > 0 && (
          <ContextMenu
            x={graphMenu.x}
            y={graphMenu.y}
            actions={graphMenuActions}
            onClose={closeGraphMenu}
          />
        )}
      </GraphCanvasStage>
    </section>
  );

  const renderInspectorPanel = (dragHandleProps) => (
    <section className="advanced-panel advanced-panel--inspector" aria-label="Réglages du nœud sélectionné">
      <AdvancedPanelHeader
        title="Réglages"
        onClose={panelViewState?.toggleInspector}
        dragHandleProps={dragHandleProps}
      />
      <aside
        ref={inspectorScrollRef}
        className="advanced-inspector advanced-inspector--editor"
        onScroll={onInspectorScroll}
      >
        <RefusalNotice
          refusal={authoring.refusal}
          index={view.index}
          onDismiss={authoring.clearRefusal}
        />
        {lastReport && lastReport !== reportSeen && (
          <ReportNotice
            entry={lastReport}
            onDismiss={() => setReportSeen(lastReport)}
          />
        )}

        {squareOneRepairOpen && (
          <SquareOneRepairForm
            index={view.index}
            disabled={editingDisabled}
            onGesture={runGesture}
            onClose={() => setSquareOneRepairOpen(false)}
          />
        )}

        {/* Plusieurs nœuds : ce qui se fait sur tous d'un coup, comme la
            sélection multiple du Libre. Le nœud qui a le focus reste celui que
            la liste et le graphe désignent. */}
        {selectedEntries.length > 1 && (
          <GraphSelectionEditor
            entries={selectedEntries}
            disabled={editingDisabled}
            projectEpoch={projectEpoch}
            onSetColor={(paths, color) => { void runGesture(advancedGestures.setNodeColor(paths, color)); }}
            onSetControls={(stageUuids, control, value) => {
              void runGesture(advancedGestures.setStagesControls(stageUuids, { [control]: presence.value(value) }));
            }}
            onAssignMedia={assignStageMedia}
            onDelete={requestRemoval}
          />
        )}

        {!inspected && selectedEntries.length <= 1 && (
          <p className="advanced-inspector__empty">
            Sélectionnez un Écran ou une liste de choix pour afficher ses réglages.
          </p>
        )}

        {/* La `key` sur le chemin — stable : bâti sur l'uuid ou l'id, jamais sur le
            nom — remet à zéro les formulaires ouverts quand la sélection change.
            Sans elle, l'instance survit d'un nœud à l'autre de même nature, et un
            « Appliquer » partirait sur le nœud courant avec les valeurs choisies
            pour le précédent. La sélection change aussi sans clic, quand elle suit
            une écoute. */}
        {selectedEntries.length <= 1 && inspected?.kind === STAGE_KIND && (
          <StageEditor
            key={inspected.path}
            inspected={inspected}
            project={project}
            index={view.index}
            usage={usage}
            disabled={editingDisabled}
            highlightControls={highlightControls === inspected.path}
            onGesture={runGesture}
            onAssignMedia={assignStageMedia}
            projectEpoch={projectEpoch}
            onDelete={() => setDialog({ kind: 'delete', nodeKind: STAGE_KIND, path: inspected.path })}
            onRemoveOption={(actionPath, ordinal) => setDialog({ kind: 'remove-option', path: actionPath, ordinal })}
            onFocusPath={selectAndRevealPath}
            onViewConnections={showNodeConnections}
            focusName={renamePath === inspected.path}
            onNameFocusHandled={() => setRenamePath(null)}
          />
        )}

        {selectedEntries.length <= 1 && inspected?.kind === ACTION_KIND && (
          <ActionEditor
            key={inspected.path}
            inspected={inspected}
            project={project}
            index={view.index}
            disabled={editingDisabled}
            onGesture={runGesture}
            onDelete={() => setDialog({ kind: 'delete', nodeKind: ACTION_KIND, path: inspected.path })}
            onRemoveOption={(ordinal) => setDialog({ kind: 'remove-option', path: inspected.path, ordinal })}
            wireRequested={wireRequestPath === inspected.path}
            onWireRequestHandled={() => setWireRequestPath(null)}
            onFocusPath={selectAndRevealPath}
            onViewConnections={showNodeConnections}
            focusName={renamePath === inspected.path}
            onNameFocusHandled={() => setRenamePath(null)}
          />
        )}
      </aside>
    </section>
  );

  const renderPanelContent = (panelId, dragHandleProps) => {
    if (panelId === ADVANCED_WORKSPACE_PANEL_IDS.NODE_LIST) return renderNodeListPanel(dragHandleProps);
    if (panelId === ADVANCED_WORKSPACE_PANEL_IDS.GRAPH) return renderGraphPanel(dragHandleProps);
    if (panelId === ADVANCED_WORKSPACE_PANEL_IDS.INSPECTOR) return renderInspectorPanel(dragHandleProps);
    return null;
  };

  return (
    <div className="advanced-workspace" style={workspaceStyle}>
      <PanelSortContext items={visiblePanelOrder} onMove={panelViewState?.movePanel}>
        {visiblePanelOrder.map((panelId, index) => {
          const nextPanelId = visiblePanelOrder[index + 1];
          const boundary = nextPanelId
            ? resizeBoundaryByPair.get(`${panelId}-${nextPanelId}`)
            : null;
          return (
            <Fragment key={panelId}>
              <SortablePanelItem
                id={panelId}
                activation="header"
                className={`advanced-panel-slot advanced-panel-slot--${panelId}`}
              >
                {({ dragHandleProps }) => renderPanelContent(panelId, dragHandleProps)}
              </SortablePanelItem>
              {boundary ? renderResizeHandle(boundary) : null}
            </Fragment>
          );
        })}
      </PanelSortContext>

      {exportState?.review && (
        <ZipReviewPanel review={exportState.review} onClose={exportState.closeReview} />
      )}

      {simulation && (
        <DocumentSimulationPanel
          simulation={simulation}
          // Le rappel déplace la sélection, allonge la trace et, si demandé,
          // entraîne la caméra.
          onActiveNodeChange={handleActiveNodeChange}
          onClose={closeSimulation}
        />
      )}

      {dialog?.kind === 'new-stage-defaults' && (
        <NewStageDefaultsDialog
          selectedStage={view.inspected?.kind === STAGE_KIND ? view.inspected : null}
          onClose={() => setDialog(null)}
        />
      )}
      {DERIVED_CONSTRUCTION_CREATION_ENABLED && dialog?.kind === 'create-construction' && (
        <CreateConstructionDialog index={view.index} busy={editingDisabled} onCancel={() => setDialog(null)} onConfirm={runGesture} />
      )}
      {dialog?.kind === 'remove-option' && (
        <RemoveOptionDialog
          index={view.index}
          actionPath={dialog.path}
          ordinal={dialog.ordinal}
          busy={editingDisabled}
          onCancel={() => setDialog(null)}
          onConfirm={runGesture}
        />
      )}
      {dialog?.kind === 'graph-link' && view.index && (
        <GraphLinkDialog
          key={`${dialog.intent.sourcePath}-${dialog.intent.targetPath ?? 'empty'}-${dialog.intent.portId}`}
          index={view.index}
          intent={dialog.intent}
          busy={editingDisabled}
          onCancel={() => setDialog(null)}
          onConfirm={runGesture}
        />
      )}
      {dialog?.kind === 'listen-from-action' && view.index && (
        <ListenFromActionDialog
          inspected={inspectNode(view.index, dialog.path)}
          index={view.index}
          onCancel={() => setDialog(null)}
          onListen={(stagePath) => {
            setDialog(null);
            startSimulation(stagePath);
          }}
        />
      )}
      {dialog?.kind === 'delete-selection' && (
        <DeleteSelectionDialog
          index={view.index}
          paths={dialog.paths}
          busy={editingDisabled}
          onCancel={() => setDialog(null)}
          onConfirm={runGesture}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteNodeDialog
          index={view.index}
          kind={dialog.nodeKind}
          path={dialog.path}
          busy={editingDisabled}
          onCancel={() => setDialog(null)}
          onConfirm={runGesture}
        />
      )}
    </div>
  );
}
