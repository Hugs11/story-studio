import { memo, useEffect, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { useProjectContext } from '../../store/ProjectContext';
import {
  NAV_TARGET_NEXT_STORY,
  decodeNavigationMenuId,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryHomeStepNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
  normalizeNavigationTarget,
  decodeNavigationStoryId,
} from '../../store/navigationTargets';
import { AfterPlaySection } from './story/AfterPlaySection';
import { DuringPlaySection } from './story/DuringPlaySection';
import { NAV_ROOT_LABEL } from './story/storyUtils';
import { TriangleAlert } from '../icons/LucideLocal';
import './CentralPanel.css';

// ─── Navigation helpers (used for computed props only) ────────────────────────

function resolveNavigationTargetId(target, currentMenuId = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isCurrentMenuNavigationTarget(normalized)) return currentMenuId ?? null;
  if (isNextStoryNavigationTarget(normalized)) return NAV_TARGET_NEXT_STORY;
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

function targetNameById(allMenus, allStories, targetId, fallback = 'destination introuvable') {
  if (targetId === 'root') return NAV_ROOT_LABEL;
  if (targetId === NAV_TARGET_NEXT_STORY) return 'Histoire suivante';
  if (!targetId) return fallback;
  if (isStoryNavigationTarget(targetId)) {
    const storyId = decodeNavigationStoryId(targetId);
    const storyName = allStories.find((s) => s.id === storyId)?.name || fallback;
    return isStoryHomeStepNavigationTarget(targetId)
      ? `Retour de fin — ${storyName}`
      : isStoryPlayNavigationTarget(targetId)
      ? `Lecture directe — ${storyName}`
      : `Titre — ${storyName}`;
  }
  return allMenus.find((menu) => menu.id === targetId)?.name || fallback;
}

function resolveReturnTarget(node, parentMenu) {
  if (node?.returnAfterPlay) return resolveNavigationTargetId(node.returnAfterPlay, parentMenu?.id ?? null);
  if (parentMenu?.returnAfterPlay) return resolveNavigationTargetId(parentMenu.returnAfterPlay, parentMenu?.id ?? null);
  return parentMenu?.id ?? null;
}

function resolveHomeTarget(node, parentMenu) {
  if (node?.returnOnHomeNone) return null;
  if (node?.returnOnHome) return resolveNavigationTargetId(node.returnOnHome, parentMenu?.id ?? null);
  return resolveReturnTarget(node, parentMenu);
}

function resolvePromptOkTarget(node, parentMenu) {
  if (node?.afterPlaybackPromptOkTarget) {
    return resolveNavigationTargetId(node.afterPlaybackPromptOkTarget, parentMenu?.id ?? null);
  }
  return resolveReturnTarget(node, parentMenu);
}

function resolvePromptHomeTarget(node, parentMenu) {
  if (node?.afterPlaybackPromptHomeNone) return null;
  if (node?.afterPlaybackPromptHomeTarget) {
    return resolveNavigationTargetId(node.afterPlaybackPromptHomeTarget, parentMenu?.id ?? null);
  }
  return resolvePromptOkTarget(node, parentMenu);
}

function buildInheritedReturnLabel(parentMenu, allMenus, allStories, autoNextEffective) {
  if (!parentMenu) return 'Comportement courant (défaut)';
  if (autoNextEffective) return 'Réglage par défaut (Histoire suivante)';
  const inheritedTargetId = parentMenu.returnAfterPlay ?? null;
  if (!inheritedTargetId || isCurrentMenuNavigationTarget(inheritedTargetId)) {
    return `Réglage par défaut (${parentMenu.name || 'ce dossier'})`;
  }
  if (isRootNavigationTarget(inheritedTargetId)) return `Réglage par défaut (${NAV_ROOT_LABEL})`;
  const name = targetNameById(allMenus, allStories, resolveNavigationTargetId(inheritedTargetId, parentMenu.id));
  return `Réglage par défaut (${name})`;
}

function getNavigationState(node, parentMenu, allMenus, allStories, autoNextEffective, isLastInMenu) {
  const inheritedTargetId = parentMenu
    ? (parentMenu.returnAfterPlay
      ? resolveNavigationTargetId(parentMenu.returnAfterPlay, parentMenu.id)
      : parentMenu.id)
    : null;
  const effectiveReturnTargetId = resolveReturnTarget(node, parentMenu);
  const effectiveHomeTargetId = resolveHomeTarget(node, parentMenu);
  const inheritedTargetName = inheritedTargetId
    ? targetNameById(allMenus, allStories, inheritedTargetId, 'une destination introuvable')
    : 'le comportement courant';
  const hasLocalReturnOverride = !!node?.returnAfterPlay;
  const hasLocalHomeOverride = !!node?.returnOnHome || !!node?.returnOnHomeNone;

  if (hasLocalReturnOverride) {
    return {
      tone: 'accent',
      text: `Cette histoire revient vers ${targetNameById(allMenus, allStories, effectiveReturnTargetId, 'une destination introuvable')}.`,
    };
  }
  if (hasLocalHomeOverride) {
    return {
      tone: 'muted',
      text: node?.returnOnHomeNone
        ? `Fin d'histoire vers ${inheritedTargetName} — bouton Accueil sans transition.`
        : `Fin d'histoire vers ${inheritedTargetName} — bouton Accueil vers ${targetNameById(allMenus, allStories, effectiveHomeTargetId, 'une destination introuvable')}.`,
    };
  }
  if (autoNextEffective) {
    return isLastInMenu
      ? { tone: 'muted', text: `Auto-next actif — dernière histoire, retour vers ${inheritedTargetName}.` }
      : { tone: 'accent', text: "Auto-next actif — cette histoire enchaîne automatiquement sur l'histoire suivante." };
  }
  if (parentMenu) {
    return {
      tone: 'muted',
      text: `Après la lecture, retour vers ${inheritedTargetName}.`,
    };
  }
  return { tone: 'muted', text: 'Cette histoire utilise le comportement courant du pack.' };
}

function buildBehaviorSummary(node, parentMenu, allMenus, allStories, project, autoNextEffective, isLastInMenu) {
  const okEnabled = node?.controlSettings?.ok === true;
  const homeEnabled = node?.controlSettings?.home !== false;
  const returnTargetId = resolveReturnTarget(node, parentMenu);
  const homeTargetId = resolveHomeTarget(node, parentMenu);
  const returnTargetName = returnTargetId
    ? targetNameById(allMenus, allStories, returnTargetId, parentMenu?.name || 'ce dossier')
    : null;
  const homeTargetName = homeTargetId
    ? targetNameById(allMenus, allStories, homeTargetId, parentMenu?.name || 'ce dossier')
    : null;
  const hasPrompt = !!node?.afterPlaybackPromptAudio;
  const sequence = node?.afterPlaybackSequence ?? [];
  const hasSequence = sequence.length > 0;
  const hasEndNode = !hasPrompt && !hasSequence && !!project?.nightModeAudio;
  const promptOkTargetId = resolvePromptOkTarget(node, parentMenu);
  const promptHomeTargetId = resolvePromptHomeTarget(node, parentMenu);
  const promptOkTargetName = promptOkTargetId
    ? targetNameById(allMenus, allStories, promptOkTargetId, parentMenu?.name || 'ce dossier')
    : null;
  const promptHomeTargetName = promptHomeTargetId
    ? targetNameById(allMenus, allStories, promptHomeTargetId, parentMenu?.name || 'ce dossier')
    : null;

  const lines = [
    `Bouton OK pendant la lecture : ${okEnabled ? 'actif' : 'désactivé'}`,
    `Bouton Accueil : ${homeEnabled ? (homeTargetName ? `retour vers ${homeTargetName}` : 'retour selon le contexte courant') : 'désactivé'}`,
  ];

  if (hasSequence) {
    const lastStep = sequence[sequence.length - 1] ?? null;
    const sequenceOkTargetId = resolveNavigationTargetId(lastStep?.okTarget, parentMenu?.id ?? null) ?? returnTargetId;
    const sequenceOkTargetName = sequenceOkTargetId
      ? targetNameById(allMenus, allStories, sequenceOkTargetId, parentMenu?.name || 'ce dossier')
      : null;
    lines.push(`Fin d'histoire : scénario de fin de ${sequence.length} étape${sequence.length > 1 ? 's' : ''}, puis OK vers ${sequenceOkTargetName || 'la destination configurée'}`);
  } else if (hasPrompt) {
    lines.push(`Fin d'histoire : message audio, puis OK vers ${promptOkTargetName || returnTargetName || 'la destination configurée'}`);
    lines.push(`Accueil sur le message audio : ${node?.afterPlaybackPromptHomeNone ? 'aucune transition' : `Accueil vers ${promptHomeTargetName || promptOkTargetName || 'la destination configurée'}`}`);
  } else if (hasEndNode) {
    lines.push("Fin d'histoire : passage par le nœud de fin du pack");
  } else if (autoNextEffective && !isLastInMenu) {
    lines.push("Fin d'histoire : enchaînement automatique sur l'histoire suivante");
  } else {
    lines.push(`Fin d'histoire : retour direct vers ${returnTargetName || 'la destination configurée'}`);
  }

  return lines;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const StoryEditor = memo(function StoryEditor({
  node,
  project = null,
  allMenus = [],
  allStories = [],
  parentMenu = null,
  onUpdate,
  onDelete,
}) {
  const { onExtractAudioEmbeddedImage } = useProjectContext();

  const autoNext = project?.globalOptions?.autoNext ?? false;
  const autoNextEffective = autoNext && !node?.returnAfterPlay && !(parentMenu?.returnAfterPlay);
  const parentChildren = parentMenu?.children ?? [];
  const nodeIndexInParent = parentChildren.findIndex((c) => c.id === node?.id);
  const isLastInMenu = autoNextEffective && (
    nodeIndexInParent < 0 ||
    !parentChildren.slice(nodeIndexInParent + 1).some((c) => c.type === 'story')
  );

  const inheritedReturnLabel = buildInheritedReturnLabel(
    parentMenu, allMenus, allStories, autoNextEffective && !isLastInMenu,
  );
  const navigationState = getNavigationState(
    node, parentMenu, allMenus, allStories, autoNextEffective, isLastInMenu,
  );
  const effectiveReturnTargetId = resolveReturnTarget(node, parentMenu);
  const effectiveReturnTargetName = effectiveReturnTargetId
    ? targetNameById(allMenus, allStories, effectiveReturnTargetId, parentMenu?.name || 'ce dossier')
    : 'le comportement courant';

  const [textImgModal, setTextImgModal] = useState(null);

  function handleRegenerate() {
    setTextImgModal({
      defaultText: node.name || '',
      onConfirm: (path) => { onUpdate({ itemImage: path, autoGenerateImage: false }); },
    });
  }

  async function handleStoryAudioPick(path) {
    const autoName = path.split(/[\\/]/).pop()
      .replace(/\.(mp3|ogg|wav|m4a|webm)$/i, '')
      .replace(/[-_]/g, ' ')
      .trim();
    const embeddedImage = await onExtractAudioEmbeddedImage?.(path);
    onUpdate({
      audio: path,
      ...((!node.name || node.name === 'Nouvelle histoire') ? { name: autoName } : {}),
      ...(!node.itemImage && embeddedImage ? { itemImage: embeddedImage } : {}),
    });
  }

  return (
    <>
      {/* Card : L'histoire (nom intégré) */}
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">L'histoire</div>
          <div className="card-copy card-copy--inline">Nom, image et audios — comment cette histoire apparaît dans le menu et ce qui est joué.</div>
        </div>

        <div className="field-row" style={{ marginBottom: 0 }}>
          <span className="field-label">Nom</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Nom de l'histoire"
          />
        </div>
        <div className="card-sep" />

        <div className="media-split">
          <div className="media-split-left">
            <div className="media-col-header">
              Image
              <span className="media-col-subtitle">Image affichée dans le menu de sélection</span>
            </div>
            <ImageField
              accentLabel
              fieldId={`${node.id}:itemImage`}
              file={node.itemImage}
              extraActions={[
                {
                  key: 'generate-text',
                  label: 'Générer un texte',
                  icon: '✦',
                  onClick: handleRegenerate,
                  title: "Créer une image texte à partir du nom de l'histoire",
                },
              ]}
              onPick={(f) => onUpdate({ itemImage: f, autoGenerateImage: false })}
              onClear={() => onUpdate({ itemImage: null, autoGenerateImage: false })}
            />
          </div>
          <div className="media-split-divider" />
          <div className="media-split-right">
            <div className="media-col-header">
              Son
              <span className="media-col-subtitle">Audio de sélection puis lecture de l'histoire</span>
            </div>
            <AudioField
              accentLabel
              label="Audio de sélection"
              description="Énoncé quand l'enfant parcourt les histoires"
              file={node.itemAudio}
              ttsTextSuggestion={node.name || ''}
              ttsFilenameHint={`selection-${node.name || 'histoire'}`}
              xttsTarget={{ kind: 'story', entryId: node.id, field: 'itemAudio' }}
              onPick={(f) => onUpdate({ itemAudio: f })}
              onClear={() => onUpdate({ itemAudio: null })}
            />
            <div className="sep" />
            <AudioField
              accentLabel
              label="Histoire complète"
              description="Écoutée quand l'enfant valide son choix"
              file={node.audio}
              ttsFilenameHint={`histoire-complete-${node.name || 'histoire'}`}
              xttsTarget={{ kind: 'story', entryId: node.id, field: 'audio' }}
              onPick={handleStoryAudioPick}
              onClear={() => onUpdate({ audio: null })}
            />
          </div>
        </div>

      </div>

      {/* Card : Pendant la lecture */}
      <DuringPlaySection
        node={node}
        project={project}
        allMenus={allMenus}
        allStories={allStories}
        parentMenu={parentMenu}
        effectiveReturnTargetName={effectiveReturnTargetName}
        onUpdate={onUpdate}
      />

      {/* Card : Après la lecture */}
      <AfterPlaySection
        node={node}
        parentMenu={parentMenu}
        allMenus={allMenus}
        allStories={allStories}
        project={project}
        inheritedReturnLabel={inheritedReturnLabel}
        onUpdate={onUpdate}
      />

      <div className="card card--danger">
        <div className="card-danger-header">
          <TriangleAlert className="card-danger-icon" />
          <span>Zone sensible</span>
        </div>
        <div className="card-danger-divider" />
        <div className="card-danger-row">
          <div className="card-danger-text">
            <div className="card-danger-title">Supprimer cette histoire</div>
            <div className="card-danger-desc">
              L'histoire est retirée du pack avec son audio, son image et ses transitions. Les fichiers audio et image restent disponibles dans la médiathèque pour être réutilisés.
            </div>
          </div>
          <button className="btn btn-danger-outline" onClick={onDelete}>
            Supprimer
          </button>
        </div>
      </div>

      {textImgModal && (
        <TextImagePromptModal
          defaultText={textImgModal.defaultText}
          onConfirm={(path) => { textImgModal.onConfirm(path); setTextImgModal(null); }}
          onCancel={() => setTextImgModal(null)}
        />
      )}
    </>
  );
});
