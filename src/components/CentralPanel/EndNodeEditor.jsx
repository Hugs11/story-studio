import { useEffect, useState } from 'react';
import { Toggle } from '../common/Toggle';
import { AudioField } from './AudioField';
import { DeleteAudioDialog } from '../DeleteAudioDialog/DeleteAudioDialog';
import { useProjectContext } from '../../store/ProjectContext';
import {
  ENREGISTREMENTS,
  FICHIERS_IMPORTES,
  IMAGES_GENEREES,
  VOIX_GENEREES,
} from '../../store/workspaceDirs';
import { NAV_TARGET_NEXT_STORY, NavigationTargetSelect } from './story/storyUtils';
import { Trash2 } from '../icons/LucideLocal';
import './CentralPanel.css';

const DELETABLE_WORKSPACE_DIRS = [FICHIERS_IMPORTES, ENREGISTREMENTS, VOIX_GENEREES, IMAGES_GENEREES];

function canDeleteFromWorkspace(filePath, workspaceDir) {
  if (!filePath || !workspaceDir) return false;
  const normalize = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase().trim();
  const file = normalize(filePath);
  const dir = normalize(workspaceDir).replace(/\/$/, '');
  return DELETABLE_WORKSPACE_DIRS.some((d) => file.startsWith(`${dir}/${d}/`));
}

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
  const { workspaceDir } = useProjectContext();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const hasAudio = typeof nightModeAudio === 'string' && nightModeAudio.trim().length > 0;
  const allowDiskDelete = canDeleteFromWorkspace(nightModeAudio, workspaceDir);

  function handleRemove() {
    if (hasAudio) {
      setShowDeleteDialog(true);
    } else {
      onRemove?.();
    }
  }

  function handleAudioDeleted() {
    setShowDeleteDialog(false);
    onUpdateNightModeAudio(null);
    onUpdateNightMode(false);
    onRemove?.({ skipConfirm: true });
  }

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
            onClick={handleRemove}
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

      {showDeleteDialog && (
        <DeleteAudioDialog
          file={nightModeAudio}
          workspaceDir={workspaceDir}
          allowDiskDelete={allowDiskDelete}
          diskDeleteHelp="Cet audio n'est pas dans l'emplacement de travail Story Studio. Il sera retiré du projet mais pas supprimé du disque."
          onDeleted={handleAudioDeleted}
          onClose={() => setShowDeleteDialog(false)}
        />
      )}
    </>
  );
}
