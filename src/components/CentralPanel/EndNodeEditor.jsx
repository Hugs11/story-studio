import { useState } from 'react';
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
import { NavigationTargetSelect } from './story/storyUtils';
import { TriangleAlert } from '../icons/LucideLocal';
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

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Message de fin</div>
          <div className="card-copy card-copy--inline">
            Message audio joué à la fin de chaque histoire, avant d'atteindre la destination suivante (ex : « Tu veux encore écouter une histoire ? »). La lecture est toujours automatique.
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
          <div className="card-title">Pendant le message de fin</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">Bouton Accueil</div>
              <div className="editor-setting-desc">
              Destination quand l'enfant appuie sur le bouton Accueil pendant la lecture du message de fin.
              </div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={nightModeHomeReturn ?? ''}
                onChange={(value) => onUpdateNightModeHomeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel="Suit le retour de l'histoire"
                resolvedDestinationLabel={nightModeHomeReturnResolvedLabel}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Après le message de fin</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">Destination finale</div>
              <div className="editor-setting-desc">
              Où l'enfant est redirigé après la lecture du message de fin.
              </div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={nightModeReturn ?? ''}
                onChange={(value) => onUpdateNightModeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel="Suit la fin de l'histoire"
                resolvedDestinationLabel={nightModeReturnResolvedLabel}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Mode nuit</div>
        </div>
        <div className="editor-setting-stack">
          <div className="editor-setting-row is-toggle-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">Activer</div>
              <div className="editor-setting-desc">
              Marque le pack comme « mode nuit » dans les métadonnées exportées. Certaines Lunii peuvent ajuster leur affichage, le niveau sonore et le nombre d'histoires que l'enfant peut écouter si le mode nuit est activé sur la Lunii et cette option activée.
              </div>
            </div>
            <div className="editor-setting-control">
              <Toggle on={nightModeActive} onChange={onUpdateNightMode} />
            </div>
          </div>
        </div>
      </div>

      <div className="card card--danger">
        <div className="card-danger-header">
          <TriangleAlert className="card-danger-icon" />
          <span>Zone sensible</span>
        </div>
        <div className="card-danger-divider" />
        <div className="card-danger-row">
          <div className="card-danger-text">
            <div className="card-danger-title">Supprimer le message de fin</div>
            <div className="card-danger-desc">
              Retire le message de fin du pack. Les histoires ne joueront plus de message commun à leur conclusion. Désactive aussi le mode nuit.
            </div>
          </div>
          <button className="btn btn-danger-outline" type="button" onClick={handleRemove}>
            Supprimer
          </button>
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
