import { useState } from 'react';
import { Toggle } from '../common/Toggle';
import { AudioField } from './AudioField';
import { DeleteAudioDialog } from '../DeleteAudioDialog/DeleteAudioDialog';
import { useProjectContext } from '../../store/ProjectContext';
import { NavigationTargetSelect } from './story/storyUtils';
import { TriangleAlert } from '../icons/LucideLocal';
import './CentralPanel.css';

function canDeleteFromWorkspace(filePath, workspaceDir) {
  if (!filePath || !workspaceDir) return false;
  const normalize = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase().trim();
  const file = normalize(filePath);
  const dir = normalize(workspaceDir).replace(/\/$/, '');
  return ['fichiers-importes', 'enregistrements', 'voix-generees', 'images-generees']
    .some((d) => file.startsWith(`${dir}/${d}/`));
}

const navigationSelectWrapStyle = { maxWidth: 280, width: '100%' };
const fieldDescStyle = { fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 };

export function EndNodeEditor({
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
      onUpdateNightMode(false);
      onRemove();
    }
  }

  function handleAudioDeleted() {
    setShowDeleteDialog(false);
    onUpdateNightModeAudio(null);
    onUpdateNightMode(false);
    onRemove();
  }

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Nœud de fin</div>
          <div className="card-copy card-copy--inline">
            Message audio joué à la fin de chaque histoire, avant d'atteindre la destination suivante (ex : « Tu veux encore écouter une histoire ? »). La lecture est toujours automatique.
          </div>
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
        <div className="card-title">Pendant le nœud de fin</div>
        <div className="field-row" style={{ marginBottom: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="field-label">Accueil</span>
            <div style={fieldDescStyle}>
              Destination quand l'enfant appuie sur le bouton Accueil pendant la lecture du nœud de fin.
            </div>
          </div>
          <div style={navigationSelectWrapStyle}>
            <NavigationTargetSelect
              value={nightModeHomeReturn ?? ''}
              onChange={(value) => onUpdateNightModeHomeReturn?.(value)}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={null}
              emptyLabel="Réglage par défaut"
              resolvedDestinationLabel={nightModeHomeReturnResolvedLabel}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Après le nœud de fin</div>
        <div className="field-row" style={{ marginBottom: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="field-label">À la fin du nœud de fin, retour vers</span>
            <div style={fieldDescStyle}>
              Où l'enfant est redirigé après la lecture du message de fin.
            </div>
          </div>
          <div style={navigationSelectWrapStyle}>
            <NavigationTargetSelect
              value={nightModeReturn ?? ''}
              onChange={(value) => onUpdateNightModeReturn?.(value)}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={null}
              emptyLabel="Réglage par défaut"
              resolvedDestinationLabel={nightModeReturnResolvedLabel}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Mode nuit</div>
        <div className="field-row" style={{ marginBottom: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="field-label">Activer</span>
            <div style={fieldDescStyle}>
              Marque le pack comme « mode nuit » dans les métadonnées exportées. Certaines Lunii peuvent ajuster leur affichage, le niveau sonore et le nombre d'histoires que l'enfant peut écouter si le mode nuit est activé sur la Lunii et cette option activée.
            </div>
          </div>
          <Toggle on={nightModeActive} onChange={onUpdateNightMode} />
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
            <div className="card-danger-title">Supprimer le nœud de fin</div>
            <div className="card-danger-desc">
              Retire le nœud de fin du pack. Les histoires ne joueront plus de message commun à leur conclusion. Désactive aussi le mode nuit.
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
