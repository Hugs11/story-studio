import { useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../i18n/treePresentation.js";
import { Toggle } from '../common/Toggle';
import { AudioField } from './AudioField';
import { packStartReturnLabel, NavigationTargetSelect } from './story/storyUtils';
import { Trash2 } from '../icons/LucideLocal';
import {
  collectEndMessagePresentations,
} from '../../store/generatedNavigation';
import {
  getEffectiveEndMessageControlState,
  summarizeEndMessagePlayback,
} from '../../store/endMessagePresentation';
import { EndMessagePlaybackControl } from './EndMessagePlaybackControl';
import './EditorPanel.css';

export function EndNodeEditor({
  endNodeName = t("tree:endNode.card.title"),
  nightModeAudio,
  nightModeActive,
  nightModeReturn,
  nightModeHomeReturn,
  projectName,
  allMenus = [],
  allStories = [],
  onUpdateNightModeAudio,
  onUpdateNightMode,
  onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
  onUpdateEndMessageAutoplay,
  onUpdateEndNodeName,
  onRemove,
  project = null,
  onExamineStory,
  onAttachStory,
}) {
  useTreeTranslation();
  const hasAudio = typeof nightModeAudio === 'string' && nightModeAudio.trim().length > 0;
  const startReturnLabel = packStartReturnLabel(project);
  const presentations = collectEndMessagePresentations(project);
  const globalStories = presentations.filter((item) => item.presentationKind === 'global');
  const localStories = presentations.filter((item) => item.presentationKind === 'local_prompt' || item.presentationKind === 'local_sequence');
  const controlStates = globalStories.map((item) => getEffectiveEndMessageControlState(
    item.navigation.endMessage.controls,
    item.effectiveHome,
  ));
  const playbackSummary = summarizeEndMessagePlayback(
    controlStates,
    project?.globalOptions?.endMessageAutoplay ?? true,
  );

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:endNode.card.title")}</div>
          <div className="card-copy card-copy--inline">{t("tree:endNode.card.description")}</div>
        </div>

        <div className="field-row">
          <span className="field-label">{t("tree:zip.name.label")}</span>
          <input
            className="field-input"
            value={endNodeName}
            onChange={(event) => onUpdateEndNodeName?.(event.target.value)}
            placeholder={t("tree:endNode.card.title")}
          />
        </div>

        <AudioField
          label={t("tree:endNode.audio.label")}
          labelRef={{ key: "tree:endNode.audio.label" }}
          file={nightModeAudio}
          ttsTextSuggestion={endNodeName || ''}
          ttsFilenameHint={`fin-histoire-${projectName || 'projet'}`}
          xttsTarget={{ kind: 'root', field: 'nightModeAudio' }}
          onPick={(file) => onUpdateNightModeAudio(file)}
          onClear={() => onUpdateNightModeAudio(null)}
        />

        {!hasAudio && (
          <div className="info-box warn">{t("tree:endNode.audio.required")}</div>
        )}
        {localStories.length > 0 && (
          <div className="end-node-local-list">
            <span className="field-label">{t("tree:endNode.local.label")}</span>
            {localStories.map((item) => (
              <div key={item.entry.id} className="end-node-local-list-row">
                <button type="button" className="link-button" onClick={() => onExamineStory?.(item.entry.id)}>
                  {t("tree:endNode.story.examine", { name: item.entry.name || t("tree:endNode.story.fallback") })}
                </button>
                <button type="button" className="link-button" onClick={() => onAttachStory?.(item.entry.id)}>{t("tree:endNode.global.attach")}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:playback.during.title")}</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row end-node-setting-row">
            <div className="editor-setting-copy end-node-setting-copy">
              <div className="editor-setting-title">{t("tree:control.home.label")}</div>
              <div className="editor-setting-desc">{t("tree:endNode.home.description")}</div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={nightModeHomeReturn ?? ''}
                onChange={(value) => onUpdateNightModeHomeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel={startReturnLabel}
                includeStoryPlay={false}
                flagMissingValue
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:playback.after.title")}</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row end-node-setting-row end-node-playback-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">{t("tree:endNode.continuation.label")}</div>
              <div className="editor-setting-desc">{t("tree:endNode.continuation.description")}</div>
            </div>
            <EndMessagePlaybackControl
              summary={playbackSummary}
              onChange={onUpdateEndMessageAutoplay}
            />
          </div>
          <div className="editor-setting-row end-node-setting-row">
            <div className="editor-setting-copy end-node-setting-copy">
              <div className="editor-setting-title">{t("tree:endNode.return.label")}</div>
              <div className="editor-setting-desc">
                {nightModeReturn
                  ? t("tree:endNode.return.override")
                  : t("tree:endNode.return.individual")}
              </div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={nightModeReturn ?? ''}
                onChange={(value) => onUpdateNightModeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel={t("tree:navigation.individual.label")}
                flagMissingValue
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:endNode.settings.title")}</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row is-toggle-row end-node-setting-row end-node-toggle-row">
            <Toggle on={nightModeActive} onChange={onUpdateNightMode} />
            <div className="editor-setting-copy end-node-setting-copy">
              <div className="editor-setting-title">{t("tree:endNode.night.enable")}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={() => onRemove?.()}
            aria-label={t("tree:endNode.delete.action")}
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">{t("tree:endNode.delete.action")}</span>
          <p className="card-danger-desc">{t("tree:endNode.delete.description")}</p>
        </div>
      </div>
    </>
  );
}
