import { useEffect } from 'react';
import { Toggle } from '../common/Toggle';
import { AudioField } from './AudioField';
import { NAV_TARGET_NEXT_STORY, NavigationTargetSelect } from './story/storyUtils';
import { Trash2 } from '../icons/LucideLocal';
import './CentralPanel.css';

export function EndNodeEditor({
  endNodeName = 'Message de fin',
  nightModeAudio,
  nightModeActive,
  nightModeReturn,
  nightModeHomeReturn,
  nightModeReturnResolvedLabel = null,
  nightModeHomeReturnResolvedLabel = null,
  projectName,
  allMenus = [],
  allStories = [],
  onUpdateNightModeAudio,
  onUpdateNightMode,
  onUpdateNightModeReturn,
  onUpdateNightModeHomeReturn,
  onUpdateEndNodeName,
  onRemove,
}) {
  const hasAudio = typeof nightModeAudio === 'string' && nightModeAudio.trim().length > 0;

  useEffect(() => {
    if (!nightModeReturn) {
      onUpdateNightModeReturn?.(NAV_TARGET_NEXT_STORY);
    }
  }, [nightModeReturn, onUpdateNightModeReturn]);

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Message de fin</div>
          <div className="card-copy card-copy--inline">
            Audio joué après chaque histoire, avant la destination finale.
          </div>
        </div>

        <div className="field-row">
          <span className="field-label">Nom</span>
          <input
            className="field-input"
            value={endNodeName}
            onChange={(event) => onUpdateEndNodeName?.(event.target.value)}
            placeholder="Message de fin"
          />
        </div>

        <AudioField
          label="Audio de fin d'histoire"
          file={nightModeAudio}
          ttsTextSuggestion="Tu veux encore écouter une histoire ?"
          ttsFilenameHint={`fin-histoire-${projectName || 'projet'}`}
          xttsTarget={{ kind: 'root', field: 'nightModeAudio' }}
          onPick={(file) => onUpdateNightModeAudio(file)}
          onClear={() => onUpdateNightModeAudio(null)}
        />

        {!hasAudio && (
          <div className="info-box warn">
            Audio requis pour la génération.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Pendant la lecture</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row end-node-setting-row">
            <div className="editor-setting-copy end-node-setting-copy">
              <div className="editor-setting-title">Bouton Accueil</div>
              <div className="editor-setting-desc">
                Destination si l'enfant appuie sur Accueil pendant le message de fin.
              </div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={nightModeHomeReturn ?? ''}
                onChange={(value) => onUpdateNightModeHomeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel="Identique à après la lecture"
                includeStoryPlay={false}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Après la lecture</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row end-node-setting-row">
            <div className="editor-setting-copy end-node-setting-copy">
              <div className="editor-setting-title">Retour après le message</div>
              <div className="editor-setting-desc">
                Destination après le message de fin.
              </div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={nightModeReturn ?? NAV_TARGET_NEXT_STORY}
                onChange={(value) => onUpdateNightModeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                includeDefault={false}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Réglage du message de fin</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row is-toggle-row end-node-setting-row end-node-toggle-row">
            <Toggle on={nightModeActive} onChange={onUpdateNightMode} />
            <div className="editor-setting-copy end-node-setting-copy">
              <div className="editor-setting-title">Activer le mode nuit</div>
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
            aria-label="Supprimer le message de fin"
            title="Supprimer le message de fin"
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">Supprimer le message de fin</span>
          <p className="card-danger-desc">
            Retire le message de fin du pack. Les histoires ne joueront plus de message commun à leur conclusion. Désactive aussi le mode nuit.
          </p>
        </div>
      </div>
    </>
  );
}
