import { useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../i18n/treePresentation.js";
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
import './EditorPanel.css';

// Noms automatiques déjà persistés : reconnaissance stable, sans consulter le catalogue.
// eslint-disable-next-line i18next/no-literal-string -- noms de création FR/EN/IT conservés comme données historiques
const AUTOMATIC_STORY_NAMES = new Set(['Nouvelle histoire', 'New story', 'Nuova storia']);
function isAutomaticStoryName(name) {
  return !name || AUTOMATIC_STORY_NAMES.has(name);
}

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

function targetNameById(allMenus, allStories, targetId, fallback = t("tree:navigation.destination.missing")) {
  if (targetId === 'root') return t(NAV_ROOT_LABEL);
  if (targetId === NAV_TARGET_NEXT_STORY) return t("tree:navigation.nextStory.label");
  if (!targetId) return fallback;
  if (isStoryNavigationTarget(targetId)) {
    const storyId = decodeNavigationStoryId(targetId);
    const storyName = allStories.find((s) => s.id === storyId)?.name || fallback;
    return isStoryHomeStepNavigationTarget(targetId)
      ? t("tree:story.navigation.endReturn", { name: storyName })
      : isStoryPlayNavigationTarget(targetId)
      ? t("tree:story.navigation.direct", { name: storyName })
      : t("tree:story.navigation.title", { name: storyName });
  }
  return allMenus.find((menu) => menu.id === targetId)?.name || fallback;
}

function buildInheritedReturnLabel(parentMenu, allMenus, allStories, autoNextEffective) {
  if (!parentMenu) return null;
  if (autoNextEffective) return t("tree:navigation.nextStory.playback");
  const inheritedTargetId = parentMenu.returnAfterPlay ?? null;
  if (!inheritedTargetId || isCurrentMenuNavigationTarget(inheritedTargetId)) {
    return t("tree:story.navigation.return", { name: parentMenu.name || t("tree:navigation.folder.fallback") });
  }
  if (isRootNavigationTarget(inheritedTargetId)) return t("tree:story.navigation.return", { name: t(NAV_ROOT_LABEL) });
  const name = targetNameById(allMenus, allStories, resolveNavigationTargetId(inheritedTargetId, parentMenu.id));
  return t("tree:story.navigation.return", { name });
}

// Icône de l'option « Revient à … » : celle de la cible réellement héritée (dossier, racine, histoire).
function buildInheritedReturnKind(parentMenu, autoNextEffective) {
  if (!parentMenu) return null;
  if (autoNextEffective) return 'story';
  const inheritedTargetId = parentMenu.returnAfterPlay ?? null;
  if (!inheritedTargetId || isCurrentMenuNavigationTarget(inheritedTargetId)) return 'menu';
  const targetId = resolveNavigationTargetId(inheritedTargetId, parentMenu.id);
  if (targetId === 'root') return 'root';
  if (targetId === NAV_TARGET_NEXT_STORY) return 'story';
  if (targetId && isStoryNavigationTarget(targetId)) {
    if (isStoryHomeStepNavigationTarget(targetId)) return 'story_home_step';
    return isStoryPlayNavigationTarget(targetId) ? 'story_play' : 'story';
  }
  return 'menu';
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
  useTreeTranslation();
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
  const inheritedReturnKind = buildInheritedReturnKind(parentMenu, autoNextEffective && !isLastInMenu);
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
      ...(isAutomaticStoryName(node.name) ? { name: autoName } : {}),
      ...(!node.itemImage && embeddedImage ? { itemImage: embeddedImage } : {}),
    });
  }

  return (
    <>
      {/* Card : L'histoire (nom intégré) */}
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:story.card.title")}</div>
          <div className="card-copy card-copy--inline">{t("tree:story.card.description")}</div>
        </div>

        <div className="field-row" style={{ marginBottom: 0 }}>
          <span className="field-label">{t("tree:zip.name.label")}</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder={t("tree:story.name.label")}
          />
        </div>
        <div className="card-sep" />

        <div className="media-split">
          <div className="media-split-left">
            <div className="media-col-header">{t("tree:media.image.label")}<span className="media-col-subtitle">{t("tree:story.image.description")}</span>
            </div>
            <ImageField
              fieldId={`${node.id}:itemImage`}
              file={node.itemImage}
              extraActions={[
                {
                  key: 'generate-text',
                  label: t("tree:image.title.generate"),
                  onClick: handleRegenerate,
                  title: t("tree:story.image.generateHint"),
                },
              ]}
              onPick={(f) => onUpdate({ itemImage: f, autoGenerateImage: false })}
              onClear={() => onUpdate({ itemImage: null, autoGenerateImage: false })}
            />
          </div>
          <div className="media-split-divider" />
          <div className="media-split-right">
            <div className="media-col-header">{t("tree:media.sound.label")}<span className="media-col-subtitle">{t("tree:story.audio.subtitle")}</span>
            </div>
            <div className="media-col-stack">
              <AudioField
                label={t("tree:story.selection.audio")}
                labelRef={{ key: "tree:story.selection.audio" }}
                description={explicitSilentSelection
                  ? t("tree:story.selection.optional")
                  : t("tree:story.selection.description")}
                file={node.itemAudio}
                required={selectionAudioRequired}
                emptyBadge={explicitSilentSelection ? t("tree:story.selection.silentBadge") : null}
                ttsTextSuggestion={node.name || ''}
                // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
                ttsFilenameHint={`selection-${node.name || 'histoire'}`}
                xttsTarget={{ kind: 'story', entryId: node.id, field: 'itemAudio' }}
                onPick={(f) => onUpdate(createStorySelectionAudioUpdate(f))}
                onClear={() => onUpdate(createStorySelectionAudioUpdate(null))}
              />
              <AudioField
                label={t("tree:story.narrative.label")}
                labelRef={{ key: "tree:story.narrative.label" }}
                description={t("tree:story.narrative.description")}
                file={node.audio}
                // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
                ttsFilenameHint={`histoire-complete-${node.name || 'histoire'}`}
                xttsTarget={{ kind: 'story', entryId: node.id, field: 'audio' }}
                onPick={handleStoryAudioPick}
                onClear={() => onUpdate({ audio: null })}
              />
            </div>
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
        inheritedReturnKind={inheritedReturnKind}
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
            aria-label={t("tree:story.delete.action")}
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">{t("tree:story.delete.action")}</span>
          <p className="card-danger-desc">{t("tree:story.delete.description")}</p>
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
