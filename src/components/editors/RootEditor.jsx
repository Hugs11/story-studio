import { useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../i18n/treePresentation.js";
import { memo, useEffect, useRef, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { Info } from '../icons/LucideLocal';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { KEYS, read, write } from '../../store/persistentSettings';
import { basename } from '../../utils/fileUtils';
import './EditorPanel.css';
import './RootEditor.css';

const AUTO_NEXT_TOOLTIP = "tree:root.autoNext.description";

export const RootEditor = memo(function RootEditor({
  node,
  projectType,
  onUpdateRoot,
  onUpdateMedia,
  onUpdateStoryAudio,
  onUpdateOption,
  autoNextFocus = null,
  onAutoNextFocusConsumed,
}) {
  useTreeTranslation();
  const sameImage = !!node.sameImage;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;
  const isSimple = projectType === 'simple';
  const simpleStoryName = node.packMetadata?.title || node.projectName || '';
  const rootTitle = isSimple ? simpleStoryName : (node.rootName || node.packMetadata?.title || node.projectName || '');
  const [simpleNameDraft, setSimpleNameDraft] = useState(simpleStoryName);
  const isEditingSimpleNameRef = useRef(false);

  const [simpleInfoDismissed, setSimpleInfoDismissed] = useState(
    () => read(KEYS.SIMPLE_MODE_INFO_DISMISS) === '1',
  );

  useEffect(() => {
    if (!isSimple) return;
    setSimpleInfoDismissed(read(KEYS.SIMPLE_MODE_INFO_DISMISS) === '1');
  }, [isSimple]);

  useEffect(() => {
    if (!isEditingSimpleNameRef.current) setSimpleNameDraft(simpleStoryName);
  }, [simpleStoryName]);

  function dismissSimpleInfo() {
    setSimpleInfoDismissed(true);
    write(KEYS.SIMPLE_MODE_INFO_DISMISS, '1');
  }

  function handleSimpleNameChange(nextValue) {
    // Le modèle normalise les noms à chaque mutation et retire donc l'espace
    // final avant la frappe suivante. Le brouillon garde la saisie exacte à
    // l'écran, tandis que le store reste canonique pour l'autosave et l'export.
    setSimpleNameDraft(nextValue);
    onUpdateRoot({ projectName: nextValue, packMetadata: { title: nextValue } });
  }

  function handleSimpleNameBlur() {
    isEditingSimpleNameRef.current = false;
    setSimpleNameDraft(simpleStoryName);
  }

  const [textImgModal, setTextImgModal] = useState(null);
  const autoNextControlRef = useRef(null);
  const autoNextHighlightTimeoutRef = useRef(null);
  const [autoNextHighlighted, setAutoNextHighlighted] = useState(false);

  useEffect(() => {
    if (projectType !== 'pack' || !autoNextFocus?.requestId) return undefined;
    const control = autoNextControlRef.current;
    if (!control) return undefined;

    control.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setAutoNextHighlighted(true);
    window.clearTimeout(autoNextHighlightTimeoutRef.current);
    autoNextHighlightTimeoutRef.current = window.setTimeout(() => {
      setAutoNextHighlighted(false);
      autoNextHighlightTimeoutRef.current = null;
    }, 1200);
    onAutoNextFocusConsumed?.(autoNextFocus.requestId);
    return undefined;
  }, [autoNextFocus?.requestId, onAutoNextFocusConsumed, projectType]);

  useEffect(() => () => {
    window.clearTimeout(autoNextHighlightTimeoutRef.current);
  }, []);

  function handleGenerateTextImage() {
    setTextImgModal({
      defaultText: rootTitle,
      onConfirm: (path) => {
        onUpdateMedia('rootImage', path);
        if (sameImage) onUpdateMedia('thumbnailImage', path);
        onUpdateMedia('autoGenerateRootImage', false);
      },
    });
  }

  function renderRootAudio() {
    return (
      <div className="root-audio-section">
        <div className="media-col-header">{t("tree:media.sound.label")}<span className="media-col-subtitle">{t("tree:root.titleAudio.subtitle")}</span>
        </div>
        <AudioField
          label={t("tree:root.titleAudio.label")}
          labelRef={{ key: "tree:root.titleAudio.label" }}
          description={t("tree:root.titleAudio.description")}
          file={node.rootAudio}
          ttsTextSuggestion={rootTitle}
          ttsFilenameHint={`titre-${rootTitle || 'projet'}`}
          xttsTarget={{ kind: 'root', field: 'rootAudio' }}
          onPick={(f) => onUpdateMedia('rootAudio', f)}
          onClear={() => onUpdateMedia('rootAudio', null)}
        />
      </div>
    );
  }

  return (
    <>
      {nativeGraph ? (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">{t("tree:nativeGraph.card.title")}</div>
            <div className="card-copy card-copy--inline">{t("tree:nativeGraph.counts.summary", { stages: t("tree:count.stages.label", { count: nativeGraphStageCount }), actions: t("tree:count.actions.label", { count: nativeGraphActionCount }) })}</div>
          </div>
          <div className="sequence-note" style={{ margin: '0 16px 12px' }}>{t("tree:root.graph.description")}</div>
          <NativeGraphEditor
            graph={nativeGraph}
            onChange={(nextGraph) => onUpdateMedia('nativeGraph', nextGraph)}
          />
        </div>
      ) : null}

      {isSimple && !simpleInfoDismissed ? (
        <div className="simple-mode-info" role="note">
          <span className="simple-mode-info-icon" aria-hidden="true">
            <Info className="chrome-icon" strokeWidth={1.9} absoluteStrokeWidth />
          </span>
          <div className="simple-mode-info-text">
            <strong>{t("tree:root.simple.title")}</strong>
            <span>{t("tree:root.simple.description")}</span>
          </div>
          <button
            type="button"
            className="simple-mode-info-dismiss"
            onClick={dismissSimpleInfo}
            aria-label={t("tree:root.simple.dismiss")}
            title={t("tree:root.simple.dismiss")}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="card root-identity-card">
        <div className="card-title-row">
          <div className="card-title">{isSimple ? t("tree:root.simple.identity") : t("tree:root.pack.identity")}</div>
          <div className="card-copy card-copy--inline">
            {isSimple
              ? t("tree:root.simple.mediaDescription")
              : t("tree:root.pack.mediaDescription")}
          </div>
        </div>

        {projectType === 'pack' ? (
          <div className="root-card-name-row root-card-name-row--identity">
            <div className="field-row" style={{ marginBottom: 0, flex: 1 }}>
              <span className="field-label">{t("tree:zip.name.label")}</span>
              <input
                className="field-input"
                value={node.rootName ?? ''}
                onChange={(e) => onUpdateRoot({ rootName: e.target.value })}
                placeholder={t("tree:navigation.root.label")}
              />
            </div>
            <span className="root-entry-count">
              {(node.rootEntries?.length ?? 0) === 0
                ? t("tree:count.items.emptyLabel", { count: 0 })
                : t("tree:count.items.label", { count: node.rootEntries?.length ?? 0 })}
            </span>
          </div>
        ) : null}

        {isSimple ? (
          <div className="root-card-name-row root-card-name-row--simple root-card-name-row--identity">
            <div className="simple-name-field">
              <label className="simple-name-label" htmlFor="root-simple-name">{t("tree:story.name.label")}</label>
              <input
                id="root-simple-name"
                className="field-input simple-name-input"
                value={simpleNameDraft}
                onFocus={() => { isEditingSimpleNameRef.current = true; }}
                onChange={(e) => handleSimpleNameChange(e.target.value)}
                onBlur={handleSimpleNameBlur}
                placeholder={t("tree:root.name.example")}
              />
              <span className="simple-name-hint">{t("tree:root.name.description")}</span>
            </div>
          </div>
        ) : null}

        <div className="card-sep" />

        <div className="root-media-section">
          <div className="media-split root-cover-media-split">
            <div className="media-split-left">
              <div className="media-col-header">{t("tree:media.image.label")}<span className="media-col-subtitle">
                  {isSimple
                    ? t("tree:root.simple.imageDescription")
                    : t("tree:root.pack.imageDescription")}
                </span>
              </div>
              {/* La vignette catalogue se choisit dans la fiche du pack. Tant
                  qu'elle n'en a pas de propre, elle suit cette image. */}
              <ImageField
                fieldId="root:coverImage"
                file={node.rootImage}
                badge={t("tree:root.image.badge")}
                formatHint={t("tree:root.image.hint")}
                extraActions={[
                  {
                    key: 'generate-text',
                    label: t("tree:image.title.generate"),
                    onClick: handleGenerateTextImage,
                    title: t("tree:story.image.generateHint"),
                  },
                ]}
                onPick={(f) => {
                  onUpdateMedia('rootImage', f);
                  if (sameImage) onUpdateMedia('thumbnailImage', f);
                  onUpdateMedia('autoGenerateRootImage', false);
                }}
                onClear={() => {
                  onUpdateMedia('rootImage', null);
                  if (sameImage) onUpdateMedia('thumbnailImage', null);
                  onUpdateMedia('autoGenerateRootImage', false);
                }}
              />
            </div>
            <div className="media-split-divider" />
            <div className="media-split-right">
              {renderRootAudio()}
            </div>
          </div>
        </div>
      </div>

      {projectType === 'pack' ? (
        <div className="card root-story-settings-card">
          <div className="card-title-row">
            <div className="card-title">{t("tree:root.story.settings")}</div>
            <div className="card-copy card-copy--inline">{t("tree:root.story.description")}</div>
          </div>
          <div className="during-play-stack">
            <div className="sequence-controls during-play-toggles">
              <label
                ref={autoNextControlRef}
                className={`sequence-control root-auto-next-control${autoNextHighlighted ? ' is-highlighted' : ''}`}
              >
                <Toggle
                  on={!!node.globalOptions?.autoNext}
                  onChange={(value) => onUpdateOption?.('autoNext', value)}
                  ariaLabel={t("tree:root.autoNext.aria")}
                />
                <div className="root-auto-next-copy">
                  <Tooltip text={t(AUTO_NEXT_TOOLTIP)} placement="above" style={{ minWidth: 0 }}>
                    <span className="during-play-control-title">{t("tree:root.autoNext.label")}</span>
                  </Tooltip>
                  <span className="root-auto-next-description">{t("tree:root.autoNext.active")}</span>
                </div>
              </label>
            </div>
          </div>
        </div>
      ) : null}

      {isSimple && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">{t("tree:root.narrative.title")}</div>
            <div className="card-copy card-copy--inline">{t("tree:root.narrative.description")}</div>
          </div>
          <AudioField
            label={t("tree:root.narrative.audio")}
            labelRef={{ key: "tree:root.narrative.audio" }}
            description={t("tree:root.narrative.audioDescription")}
            file={node.storyAudio}
            // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
            ttsFilenameHint={`histoire-complete-${simpleStoryName || 'histoire'}`}
            xttsTarget={{ kind: 'rootStory', field: 'audio' }}
            onPick={(f) => {
              const autoName = basename(f)
                .replace(/\.(mp3|ogg|wav|m4a)$/i, '')
                .replace(/[-_]/g, ' ').trim();
              onUpdateStoryAudio(f);
              if (!simpleStoryName && autoName) handleSimpleNameChange(autoName);
            }}
            onClear={() => onUpdateStoryAudio(null)}
          />
        </div>
      )}

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
