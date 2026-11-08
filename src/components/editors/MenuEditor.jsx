import { useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../i18n/treePresentation.js";
import { memo, useState } from 'react';
import { AudioField } from './AudioField';
import { ImageField } from './ImageField';
import { NativeGraphEditor } from './NativeGraphEditor';
import { Toggle } from '../common/Toggle';
import { TextImagePromptModal } from '../TextImageGenerator/TextImagePromptModal';
import { Trash2 } from '../icons/LucideLocal';
import { getGeneratedMenuControls } from '../../store/generatedPlayback.js';
import './EditorPanel.css';

const MENU_BEHAVIOR_CONTROLS = [
  {
    key: 'wheel',
    label: "tree:control.wheel.selection",
    desc: "tree:menu.wheel.description",
    def: true,
  },
  {
    key: 'autoplay',
    label: "tree:control.autoplay.label",
    desc: "tree:menu.autoplay.description",
    def: false,
  },
  {
    key: 'pause',
    label: "tree:control.pause.title",
    desc: "tree:menu.pause.description",
    def: false,
  },
];

export const MenuEditor = memo(function MenuEditor({ node, project, parentMenu, onUpdate, onDelete }) {
  useTreeTranslation();
  const isImportedContinuation = !!node.importedContinuation;
  const nativeGraph = node.nativeGraph ?? null;
  const nativeGraphStageCount = nativeGraph?.stageCount ?? nativeGraph?.document?.stageNodes?.length ?? 0;
  const nativeGraphActionCount = nativeGraph?.actionCount ?? nativeGraph?.document?.actionNodes?.length ?? 0;
  const generatedControls = getGeneratedMenuControls(node, parentMenu, project);
  const hasForcedLinearRootControls = generatedControls.forceAutoplay;
  const [textImgModal, setTextImgModal] = useState(null);

  function handleRegenerate() {
    setTextImgModal({
      defaultText: node.name || '',
      onConfirm: (path) => { onUpdate({ image: path, autoGenerateImage: false }); },
    });
  }

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:menu.card.title")}</div>
          <div className="card-copy card-copy--inline">{t("tree:menu.card.description")}</div>
        </div>

        <div className="field-row field-row--flush">
          <span className="field-label">{t("tree:zip.name.label")}</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder={t("tree:menu.name.placeholder")}
          />
          <span className="menu-count">
            {(node.children?.length ?? node.items?.length ?? 0) === 0
                ? t("tree:count.items.emptyLabel", { count: 0 })
                : t("tree:count.items.label", { count: node.children?.length ?? node.items?.length ?? 0 })}
          </span>
        </div>
        <div className="card-sep" />

        {node.importedContinuation && (
          <div className="sequence-note sequence-note--spaced">
            {t("tree:menu.continuation.description", { name: node.importedContinuation.sourceStoryName || t("tree:menu.source.fallback"), step: node.importedContinuation.sourceStepName ? t("tree:menu.continuation.step", { name: node.importedContinuation.sourceStepName }) : "" })}
          </div>
        )}
        {nativeGraph ? (
          <div className="sequence-note sequence-note--spaced">
            {t("tree:menu.graph.description", { stages: t("tree:count.stages.label", { count: nativeGraphStageCount }), actions: t("tree:count.actions.label", { count: nativeGraphActionCount }) })}
          </div>
        ) : null}
        {node.autoBlackImage ? (
          <>
            <AudioField
              levelLabel={{ entry: node.name, kind: 'menu' }}
              label={t("tree:story.selection.audio")}
              labelRef={{ key: "tree:story.selection.audio" }}
              description={isImportedContinuation ? t("tree:menu.audio.optional") : t("tree:menu.audio.description")}
              file={node.audio}
              required={!isImportedContinuation}
              ttsTextSuggestion={node.name || ''}
              // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
              ttsFilenameHint={`selection-${node.name || 'dossier'}`}
              xttsTarget={{ kind: 'menu', entryId: node.id, field: 'audio' }}
              onPick={(f) => onUpdate({ audio: f })}
              onClear={() => onUpdate({ audio: null })}
            />
          </>
        ) : (
          <div className="media-split">
            <div className="media-split-left">
              <div className="media-col-header">{t("tree:media.image.label")}<span className="media-col-subtitle">{t("tree:menu.image.description")}</span>
              </div>
              <ImageField
                fieldId={`${node.id}:image`}
                file={node.image}
                extraActions={[
                  {
                    key: 'generate-text',
                    label: t("tree:image.title.generate"),
                    onClick: handleRegenerate,
                    title: t("tree:menu.image.generateHint"),
                  },
                ]}
                onPick={(f) => onUpdate({ image: f, autoGenerateImage: false })}
                onClear={() => onUpdate({ image: null, autoGenerateImage: false })}
              />
            </div>
            <div className="media-split-divider" />
            <div className="media-split-right">
              <div className="media-col-header">{t("tree:media.sound.label")}<span className="media-col-subtitle">
                  {isImportedContinuation ? t("tree:menu.audio.optionalSubtitle") : t("tree:menu.audio.subtitle")}
                </span>
              </div>
                <AudioField
              levelLabel={{ entry: node.name, kind: 'menu' }}
                  label={t("tree:story.selection.audio")}
                  labelRef={{ key: "tree:story.selection.audio" }}
                description={isImportedContinuation ? t("tree:menu.audio.optional") : t("tree:menu.audio.description")}
                file={node.audio}
                required={!isImportedContinuation}
                ttsTextSuggestion={node.name || ''}
                // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
                ttsFilenameHint={`selection-${node.name || 'dossier'}`}
                xttsTarget={{ kind: 'menu', entryId: node.id, field: 'audio' }}
                onPick={(f) => onUpdate({ audio: f })}
                onClear={() => onUpdate({ audio: null })}
              />
            </div>
          </div>
        )}
      </div>

      {nativeGraph ? (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">{t("tree:nativeGraph.card.title")}</div>
            <div className="card-copy card-copy--inline">{t("tree:nativeGraph.counts.summary", { stages: t("tree:count.stages.label", { count: nativeGraphStageCount }), actions: t("tree:count.actions.label", { count: nativeGraphActionCount }) })}</div>
          </div>
          <NativeGraphEditor
            graph={nativeGraph}
            onChange={(nextGraph) => onUpdate({ nativeGraph: nextGraph })}
          />
        </div>
      ) : null}

      <div className="card menu-behavior-card">
        <div className="card-title-row">
          <div className="card-title">{t("tree:menu.settings.title")}</div>
          <div className="card-copy card-copy--inline">{t("tree:menu.settings.description")}</div>
        </div>

        {hasForcedLinearRootControls ? (
          <div className="info-box menu-behavior-info">{t("tree:menu.linear.description")}</div>
        ) : null}

        <div className="menu-behavior-stack">
          <label className="sequence-control menu-behavior-control">
          <Toggle
            on={node.autoBlackImage || false}
            onChange={(v) => onUpdate({ autoBlackImage: v })}
            ariaLabel={t("tree:menu.image.aria")}
          />
            <div className="menu-behavior-copy">
              <span className="during-play-control-title">{t("tree:menu.image.transparent")}</span>
              <span className="menu-behavior-desc">{t("tree:menu.image.transparentDescription")}</span>
            </div>
          </label>
          {MENU_BEHAVIOR_CONTROLS.map(({ key, label, desc, def }) => {
            label = t(label); desc = t(desc);
            const isForced = hasForcedLinearRootControls && (key === 'wheel' || key === 'autoplay');
            return (
              <label
                key={key}
                className={`sequence-control menu-behavior-control${isForced ? ' menu-behavior-control--forced' : ''}`}
              >
                <Toggle
                  on={isForced ? generatedControls[key] : (node.controlSettings?.[key] ?? def)}
                  onChange={(v) => onUpdate({ controlSettings: { ...node.controlSettings, [key]: v } })}
                  disabled={isForced}
                  ariaLabel={isForced ? t("tree:menu.control.forcedAria", { label }) : label}
                />
                <div className="menu-behavior-copy">
                  <span className="during-play-control-title">{label}</span>
                  {isForced ? <span className="menu-behavior-state">{t("tree:menu.control.forced")}</span> : null}
                  <span className="menu-behavior-desc">{desc}</span>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={onDelete}
            aria-label={t("tree:menu.delete.action")}
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">{t("tree:menu.delete.action")}</span>
          <p className="card-danger-desc">
            {(() => {
              const count = node.children?.length ?? node.items?.length ?? 0;
              return count > 0
                ? t("tree:menu.delete.contents", { count })
                : t("tree:menu.delete.empty");
            })()}
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
