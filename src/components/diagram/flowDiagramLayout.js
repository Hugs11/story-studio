import { decodeNavigationStoryId, isStoryHomeStepNavigationTarget, isStoryNavigationTarget, normalizeNavigationTarget, refTargetEntryId } from '../../store/navigationTargets.js';
import {
  CONTEXTUAL_NEXT_STORY_TARGET,
  getGeneratedEndNodeReturnNavigation,
  getGeneratedStoryNavigation,
  resolveGeneratedTargetForStory,
} from '../../store/generatedNavigation.js';
import { canMoveEntryToContainer } from '../tree/treeOperations.js';
import { compactNavigationPresentation } from './diagram/navigationPresentation.js';

export const TYPE_LABELS = { root: 'Racine', menu: 'Dossier', story: 'Histoire', zip: 'ZIP', ref: 'Lien', 'end-node': 'Message de fin' };
// Re-exporte depuis la source unique (useZipCover importe MIME d'ici).
export { MIME } from '../../utils/mimeTypes.js';
const ZOOM_MIN = 0.08;
const ZOOM_MAX = 1.9;
export const BUTTON_ZOOM_FACTOR = 1.12;
export const WHEEL_ZOOM_SENSITIVITY = 0.0012;
export const DRAG_START_DISTANCE = 6;
const COMPLETE_METRICS = {
  full: { nodeWidth: 100, rootWidth: 120, nodeHeight: 96, nodeVisualHeight: 82, colGap: 12, rowGap: 92, rowStackGap: 56, padX: 32, padY: 20, navPadBottom: 48, storyRowLimit: 8, structureRowLimit: 4, rootRowLimit: 3 },
  compact: { nodeWidth: 86, rootWidth: 98, nodeHeight: 74, nodeVisualHeight: 62, colGap: 8, rowGap: 78, rowStackGap: 46, padX: 28, padY: 16, navPadBottom: 44, storyRowLimit: 6, structureRowLimit: 3, rootRowLimit: 2 },
  minimal: { nodeWidth: 68, rootWidth: 84, nodeHeight: 58, nodeVisualHeight: 48, colGap: 6, rowGap: 62, rowStackGap: 36, padX: 22, padY: 12, navPadBottom: 38, storyRowLimit: 5, structureRowLimit: 2, rootRowLimit: 2 },
};

export function getCompleteMetrics(compactMode) {
  return COMPLETE_METRICS[compactMode] ?? COMPLETE_METRICS.full;
}

export function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export const END_NODE_ID = 'end-node';

function getRuntimeRootDiagramTarget(project) {
  return project?.rootEntries?.[0]?.id ?? 'root';
}

function diagramNodeIdFromGeneratedTarget(targetId, project = null) {
  if (!targetId || targetId === CONTEXTUAL_NEXT_STORY_TARGET) return null;
  if (targetId === 'root') return getRuntimeRootDiagramTarget(project);
  if (isStoryNavigationTarget(targetId)) return decodeNavigationStoryId(targetId);
  return targetId;
}

function resolveStoryDiagramTarget(target, entry, parentMenu, rootEntries, fallbackTarget = null, project = null) {
  return diagramNodeIdFromGeneratedTarget(
    resolveGeneratedTargetForStory(target, entry, parentMenu, rootEntries, fallbackTarget),
    project,
  );
}

function storyTargetMode(target) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized || !isStoryNavigationTarget(normalized)) return null;
  if (isStoryHomeStepNavigationTarget(normalized)) return 'story_home_step';
  return normalized.startsWith('story_play:') ? 'story_play' : 'story';
}

function collectNavigationTransitions(entries, parentMenu = null, transitions = [], project = null, rootEntries = entries) {
  const projectType = project?.projectType ?? null;
  for (const entry of entries ?? []) {
    if (entry.type === 'story') {
      const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries);
      const sequence = entry.afterPlaybackSequence ?? [];
      const autoNextActive = !!project?.globalOptions?.autoNext;
      const hasSequence = sequence.length > 0 && !autoNextActive;
      const hasPrompt = !!entry.afterPlaybackPromptAudio && !autoNextActive;
      let effectiveReturnTarget = null;
      const inheritedTarget = parentMenu?.returnAfterPlay
        ? resolveStoryDiagramTarget(parentMenu.returnAfterPlay, entry, parentMenu, rootEntries, parentMenu.id, project)
        : null;
      const generatedReturnTarget = diagramNodeIdFromGeneratedTarget(navigation.directReturn.targetId, project);
      const explicitReturnTarget = !autoNextActive && entry.returnAfterPlay && generatedReturnTarget
        ? generatedReturnTarget
        : null;
      const fallbackReturnTarget = explicitReturnTarget
        ?? generatedReturnTarget
        ?? inheritedTarget
        ?? (projectType !== 'simple' ? (parentMenu?.id ?? getRuntimeRootDiagramTarget(project)) : null);

      const endPresentation = navigation.endMessage?.presentationKind ?? 'none';

      if (hasSequence) {
        const lastStep = sequence[sequence.length - 1];
        const configuredReturnTarget = lastStep?.okTarget
          ? resolveStoryDiagramTarget(lastStep.okTarget, entry, parentMenu, rootEntries, fallbackReturnTarget, project)
          : null;
        const targetForMode = lastStep?.okTarget
          ?? entry.returnAfterPlay
          ?? parentMenu?.returnAfterPlay
          ?? null;
        effectiveReturnTarget = configuredReturnTarget ?? fallbackReturnTarget;
        if (effectiveReturnTarget) {
          const mode = storyTargetMode(targetForMode);
          transitions.push({
            from: entry.id,
            to: effectiveReturnTarget,
            kind: 'after-end',
            source: 'sequence',
            label: mode === 'story_home_step' ? 'Fin -> retour' : mode === 'story_play' ? 'Fin -> lecture' : mode === 'story' ? 'Fin -> titre' : 'Fin',
            localEnd: {
              kind: 'sequence',
              stepCount: sequence.length,
              label: `Scénario de fin · ${sequence.length} étape${sequence.length > 1 ? 's' : ''}`,
            },
          });
        }
        for (const step of sequence) {
          if (step?.homeNone) continue;
          const homeTarget = step?.homeTarget
            ? resolveStoryDiagramTarget(step.homeTarget, entry, parentMenu, rootEntries, effectiveReturnTarget, project)
            : null;
          if (homeTarget && homeTarget !== effectiveReturnTarget) {
            transitions.push({ from: entry.id, to: homeTarget, kind: 'home', source: 'sequence' });
          }
        }
      } else if (hasPrompt) {
        if (endPresentation === 'global') {
          effectiveReturnTarget = END_NODE_ID;
          transitions.push({
            from: entry.id,
            to: effectiveReturnTarget,
            kind: 'after-end',
            source: 'global-end',
            contextualStoryId: entry.id,
            parentMenuId: parentMenu?.id ?? null,
            endNodeTargetId: diagramNodeIdFromGeneratedTarget(navigation.endNodeReturn.effectiveTargetId, project),
          });
        } else {
        effectiveReturnTarget = (entry.afterPlaybackPromptOkTarget
          ? resolveStoryDiagramTarget(entry.afterPlaybackPromptOkTarget, entry, parentMenu, rootEntries, fallbackReturnTarget, project)
          : null) ?? fallbackReturnTarget;
        if (effectiveReturnTarget) {
          transitions.push({
            from: entry.id,
            to: effectiveReturnTarget,
            kind: 'after-end',
            source: 'prompt',
            localEnd: {
              kind: 'prompt',
              stepCount: 1,
              label: 'Message de fin personnalisé',
            },
          });
        }
        }
        const promptHomeTarget = entry.afterPlaybackPromptHomeNone
          ? null
          : entry.afterPlaybackPromptHomeTarget
            ? resolveStoryDiagramTarget(entry.afterPlaybackPromptHomeTarget, entry, parentMenu, rootEntries, effectiveReturnTarget, project)
            : null;
        if (promptHomeTarget && promptHomeTarget !== effectiveReturnTarget) {
          transitions.push({ from: entry.id, to: promptHomeTarget, kind: 'home', source: 'prompt' });
        }
      } else if (endPresentation === 'global') {
        effectiveReturnTarget = END_NODE_ID;
        transitions.push({
          from: entry.id,
          to: effectiveReturnTarget,
          kind: 'after-end',
          source: 'end-node',
          contextualStoryId: entry.id,
          endNodeTargetId: diagramNodeIdFromGeneratedTarget(navigation.endNodeReturn.effectiveTargetId, project),
        });
      } else {
        if (explicitReturnTarget) {
          effectiveReturnTarget = explicitReturnTarget;
          transitions.push({ from: entry.id, to: explicitReturnTarget, kind: 'return', source: 'configured' });
        } else {
          if (generatedReturnTarget && projectType !== 'simple') {
            effectiveReturnTarget = generatedReturnTarget;
            transitions.push({
              from: entry.id,
              to: generatedReturnTarget,
              kind: 'return',
              source: inheritedTarget ? 'inherited' : 'implicit',
            });
          } else if (projectType !== 'simple') {
            effectiveReturnTarget = parentMenu?.id ?? getRuntimeRootDiagramTarget(project);
            transitions.push({ from: entry.id, to: effectiveReturnTarget, kind: 'return', source: 'implicit' });
          }
        }
      }

      const homeTarget = entry.returnOnHome
        ? resolveStoryDiagramTarget(entry.returnOnHome, entry, parentMenu, rootEntries, effectiveReturnTarget, project)
        : null;
      // Une carte story fusionne son stage de sélection et son stage de lecture.
      // Un Home play → sélection de cette même story est donc interne à la carte :
      // dessiner une boucle suggérerait à tort une navigation ou une fin locale.
      if (homeTarget && homeTarget !== entry.id && homeTarget !== effectiveReturnTarget) {
        transitions.push({ from: entry.id, to: homeTarget, kind: 'home', source: 'configured' });
      }
      continue;
    }

    if (entry.type === 'ref') {
      // Un nœud `ref` est une arête vers un nœud existant : on relie la feuille ref à sa cible.
      const to = refTargetEntryId(entry.target);
      if (to) {
        transitions.push({ from: entry.id, to, kind: 'reference', source: 'reference' });
      }
      continue;
    }

    if (entry.type === 'menu') {
      collectNavigationTransitions(entry.children ?? [], entry, transitions, project, rootEntries);
    }
  }

  return transitions;
}

export function getCompleteNavigationEdges(project, layout) {
  const nodeMap = new Map(layout.nodes.map((node) => [node.entry.id, node]));
  const visibleTargetId = (targetId) => (
    nodeMap.has(targetId) ? targetId : (layout.hiddenStoryGroupByStoryId?.get(targetId) ?? targetId)
  );
  const nodeVisualHeight = layout.metrics?.nodeVisualHeight ?? layout.metrics?.nodeHeight ?? 0;
  const visualBottom = (node) => node.y + Math.min(node.height, nodeVisualHeight || node.height);

  const regularEdges = collectNavigationTransitions(project.rootEntries ?? [], null, [], project, project.rootEntries ?? [])
    .map((edge) => {
      const from = nodeMap.get(edge.from);
      const displayTo = visibleTargetId(edge.to);
      const to = nodeMap.get(displayTo);
      if (!from || !to) return null;

      const selfLoop = edge.from === edge.to;
      const sameRowReturn = edge.kind === 'return' && Math.abs(from.y - to.y) < 1;
      const useRailReturn = sameRowReturn && !selfLoop;
      const targetIsBelow = to.y > from.y;
      const x1 = selfLoop ? from.x + (from.width * 0.28) : from.x + (from.width / 2);
      const y1 = (selfLoop || useRailReturn || (layout.isLevelLayout && targetIsBelow))
        ? visualBottom(from)
        : from.y;
      const x2 = selfLoop ? from.x + (from.width * 0.72) : to.x + (to.width / 2);
      const y2 = layout.isLevelLayout && targetIsBelow ? to.y : visualBottom(to);
      const verticalDirection = y2 >= y1 ? 1 : -1;
      const controlOffset = selfLoop
        ? Math.max(30, from.height * 0.34)
        : Math.max(54, Math.abs(x2 - x1) * 0.18, Math.abs(y2 - y1) * 0.34);
      const railY = useRailReturn
        ? Math.max(y1, y2) + Math.max(22, Math.min(34, Math.abs(x2 - x1) * 0.12))
        : null;

      return {
        ...edge,
        displayTo: displayTo !== edge.to ? displayTo : undefined,
        selfLoop,
        route: useRailReturn ? 'same-row-return' : 'curve',
        x1,
        y1,
        x2,
        y2,
        labelX: x1 + ((x2 - x1) / 2),
        labelY: railY ?? (selfLoop ? y1 + controlOffset + 14 : y1 + ((y2 - y1) / 2)),
        railY,
        c1y: selfLoop ? y1 + controlOffset : y1 + (controlOffset * verticalDirection),
        c2y: selfLoop ? y2 + controlOffset : y2 - (controlOffset * verticalDirection),
      };
    })
    .filter(Boolean);

  if (layout.hasEndNode) {
    const endNode = nodeMap.get(END_NODE_ID);
    if (endNode) {
      const endNodeReturn = getGeneratedEndNodeReturnNavigation(project);
      const contextualSourceEdges = regularEdges
        .filter((edge) => edge.to === END_NODE_ID && edge.endNodeTargetId);
      const contextualTargets = contextualSourceEdges.map((edge) => ({
        to: edge.endNodeTargetId,
        source: 'contextual',
        contextualStoryId: edge.contextualStoryId ?? edge.from,
      }));
      // Une reprise `next_story` dépend de l'histoire qui a atteint le message
      // de fin. Si cette histoire est cachée dans un dossier replié, aucun
      // raccourci synthétique ne peut représenter fidèlement son trajet.
      const endNodeEdges = endNodeReturn?.isContextual
        ? contextualTargets
        : endNodeReturn ? [{
          to: diagramNodeIdFromGeneratedTarget(endNodeReturn?.targetId, project) ?? getRuntimeRootDiagramTarget(project),
          source: endNodeReturn?.isExplicit ? 'configured' : 'implicit',
        }] : [];

      const seenEndNodeTargets = new Set();
      for (const edge of endNodeEdges) {
        const routeKey = edge.contextualStoryId ? `${edge.contextualStoryId}\u0000${edge.to}` : edge.to;
        if (seenEndNodeTargets.has(routeKey)) continue;
        seenEndNodeTargets.add(routeKey);
        const displayTo = visibleTargetId(edge.to);
        const selfLoop = edge.to === END_NODE_ID;
        const returnTarget = selfLoop ? endNode : (nodeMap.get(displayTo) ?? nodeMap.get('root'));
        if (!returnTarget) continue;
        const targetIsBelow = !selfLoop && returnTarget.y > endNode.y;
        const ex = selfLoop ? endNode.x + endNode.width : endNode.x + endNode.width / 2;
        const ey = selfLoop
          ? endNode.y + endNode.height / 2
          : targetIsBelow ? visualBottom(endNode) : endNode.y;
        const rx = selfLoop ? endNode.x : returnTarget.x + returnTarget.width / 2;
        const ry = selfLoop
          ? endNode.y + endNode.height / 2
          : targetIsBelow ? returnTarget.y : visualBottom(returnTarget);
        const verticalDirection = ry >= ey ? 1 : -1;
        const controlOffset = Math.max(80, Math.abs(ey - ry) * 0.4);
        regularEdges.push({
          from: END_NODE_ID,
          to: edge.to,
          displayTo: displayTo !== edge.to ? displayTo : undefined,
          kind: 'after-end',
          source: edge.source,
          contextualStoryId: edge.contextualStoryId,
          chainStoryIds: edge.chainStoryIds,
          label: edge.label,
          x1: ex,
          y1: ey,
          x2: rx,
          y2: ry,
          c1y: selfLoop ? ey + controlOffset : ey + (controlOffset * verticalDirection),
          c2y: selfLoop ? ry + controlOffset : ry - (controlOffset * verticalDirection),
          labelX: selfLoop ? endNode.x + endNode.width / 2 : undefined,
          labelY: selfLoop ? endNode.y + endNode.height + 18 : undefined,
        });
      }
    }
  }

  return compactNavigationPresentation(project, regularEdges);
}

export { canMoveEntryToContainer };
