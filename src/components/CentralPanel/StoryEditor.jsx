import { memo, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { useProjectContext } from '../../store/ProjectContext';
import { basename } from '../../utils/fileUtils';
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
import { Trash2 } from '../icons/LucideLocal';
import {
  createStorySelectionAudioUpdate,
  isExplicitSilentStoryTitle,
  isStorySelectionAudioRequired,
} from '../../store/storyTitleStage';
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

function buildInheritedReturnLabel(parentMenu, allMenus, allStories, autoNextEffective) {
  if (!parentMenu) return null;
  if (autoNextEffective) return 'Lecture de l’histoire suivante';
  const inheritedTargetId = parentMenu.returnAfterPlay ?? null;
  if (!inheritedTargetId || isCurrentMenuNavigationTarget(inheritedTargetId)) {
    return `Revient à ${parentMenu.name || 'ce dossier'}`;
  }
  if (isRootNavigationTarget(inheritedTargetId)) return `Revient à ${NAV_ROOT_LABEL}`;
  const name = targetNameById(allMenus, allStories, resolveNavigationTargetId(inheritedTargetId, parentMenu.id));
  return `Revient à ${name}`;
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
  afterPlayFocus = null,
  onAfterPlayFocusConsumed,
}) {
  const { onExtractAudioEmbeddedImage } = useProjectContext();

  const autoNext = project?.globalOptions?.autoNext ?? false;
  const autoNextEffective = autoNext && node?.type === 'story';
  const parentChildren = parentMenu?.children ?? [];
  const nodeIndexInParent = parentChildren.findIndex((c) => c.id === node?.id);
  const isLastInMenu = autoNextEffective && (
    nodeIndexInParent < 0 ||
    !parentChildren.slice(nodeIndexInParent + 1).some((c) => c.type === 'story')
  );

  const inheritedReturnLabel = buildInheritedReturnLabel(
    parentMenu, allMenus, allStories, autoNextEffective && !isLastInMenu,
  );
  const explicitSilentSelection = isExplicitSilentStoryTitle(node);
  const selectionAudioRequired = isStorySelectionAudioRequired(node);
  const [textImgModal, setTextImgModal] = useState(null);

  function handleRegenerate() {
    setTextImgModal({
      defaultText: node.name || '',
      onConfirm: (path) => { onUpdate({ itemImage: path, autoGenerateImage: false }); },
    });
  }

  async function handleStoryAudioPick(path) {
    const autoName = basename(path)
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
                  label: 'Générer une image-titre',
                  icon: '✦',
                  onClick: handleRegenerate,
                  title: "Créer une image-titre à partir du nom de l'histoire",
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
              description={explicitSilentSelection
                ? 'Optionnel — ce titre de sélection peut rester silencieux'
                : "Énoncé quand l'enfant parcourt les histoires"}
              file={node.itemAudio}
              required={selectionAudioRequired}
              emptyBadge={explicitSilentSelection ? 'Écran silencieux' : null}
              ttsTextSuggestion={node.name || ''}
              ttsFilenameHint={`selection-${node.name || 'histoire'}`}
              xttsTarget={{ kind: 'story', entryId: node.id, field: 'itemAudio' }}
              onPick={(f) => onUpdate(createStorySelectionAudioUpdate(f))}
              onClear={() => onUpdate(createStorySelectionAudioUpdate(null))}
            />
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

      {/* Card : Pendant l'histoire */}
      <DuringPlaySection
        node={node}
        project={project}
        allMenus={allMenus}
        allStories={allStories}
        parentMenu={parentMenu}
        onUpdate={onUpdate}
      />

      {/* Card : A la fin de l'histoire */}
      <AfterPlaySection
        node={node}
        parentMenu={parentMenu}
        allMenus={allMenus}
        allStories={allStories}
        project={project}
        inheritedReturnLabel={inheritedReturnLabel}
        onUpdate={onUpdate}
        afterPlayFocus={afterPlayFocus}
        onAfterPlayFocusConsumed={onAfterPlayFocusConsumed}
      />

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={onDelete}
            aria-label="Supprimer cette histoire"
            title="Supprimer cette histoire"
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">Supprimer cette histoire</span>
          <p className="card-danger-desc">
            L'histoire est retirée du pack avec son audio, son image et ses transitions. Les fichiers audio et image restent disponibles dans la médiathèque pour être réutilisés.
          </p>
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
