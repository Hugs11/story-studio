import { useState } from 'react';
import { Toggle } from '../common/Toggle';
import { AudioField } from './AudioField';
import { DeleteAudioDialog } from '../DeleteAudioDialog/DeleteAudioDialog';
import { useProjectContext } from '../../store/ProjectContext';
import { NavigationTargetSelect } from './story/storyUtils';

function canDeleteFromWorkspace(filePath, workspaceDir) {
  if (!filePath || !workspaceDir) return false;
  const normalize = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase().trim();
  const file = normalize(filePath);
  const dir = normalize(workspaceDir).replace(/\/$/, '');
  return ['fichiers-importes', 'enregistrements', 'voix-generees', 'images-generees']
    .some((d) => file.startsWith(`${dir}/${d}/`));
}

const targetSelectStyle = {
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
};

export function EndNodeEditor({
  nightModeAudio,
  nightModeActive,
  nightModeReturn,
  nightModeHomeReturn,
  projectName,
  savePath,
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
        <div className="card-title">Nœud de fin d'histoire</div>
        <div style={{ padding: '0 16px 12px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          Message audio joué à la fin de chaque histoire, avant d'atteindre la destination suivante. La lecture est toujours automatique.
        </div>

        <div style={{ padding: '0 16px 12px' }}>
          <AudioField
            label="Audio de fin d'histoire"
            file={nightModeAudio}
            ttsTextSuggestion="C'est l'heure de dormir. Veux-tu une dernière histoire avant d'aller au lit ?"
            ttsFilenameHint={`fin-histoire-${projectName || 'projet'}`}
            xttsTarget={{ kind: 'root', field: 'nightModeAudio' }}
            onPick={(file) => onUpdateNightModeAudio(file)}
            onClear={() => onUpdateNightModeAudio(null)}
          />
        </div>

        {!hasAudio && (
          <div className="info-box warn" style={{ margin: '0 16px 12px' }}>
            Audio requis pour la génération.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Pendant le nœud de fin</div>
        <div style={{ padding: '0 16px 12px' }}>
          <div className="field-row" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 0 }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <span className="field-label">Accueil</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                Destination quand Home est pressé pendant la lecture du nœud de fin.
              </div>
            </div>
            <div style={{ width: 320, maxWidth: '42%', minWidth: 220, flexShrink: 0 }}>
              <NavigationTargetSelect
                value={nightModeHomeReturn ?? ''}
                onChange={(value) => onUpdateNightModeHomeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel="Même destination qu'après le nœud de fin"
                style={targetSelectStyle}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Après le nœud de fin</div>
        <div style={{ padding: '0 16px 12px' }}>
          <div className="field-row" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 0 }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <span className="field-label">À la fin du nœud de fin, retour vers</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                Où l'enfant est redirigé après la lecture du message de fin.
              </div>
            </div>
            <div style={{ width: 320, maxWidth: '42%', minWidth: 220, flexShrink: 0 }}>
              <NavigationTargetSelect
                value={nightModeReturn ?? ''}
                onChange={(value) => onUpdateNightModeReturn?.(value)}
                allMenus={allMenus}
                allStories={allStories}
                currentStoryId={null}
                emptyLabel="Réglage par défaut"
                style={targetSelectStyle}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Mode nuit</div>
        <div style={{ padding: '0 16px 12px' }}>
          <div className="field-row" style={{ marginBottom: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className="field-label">Activer le mode nuit</span>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                Active l'indicateur mode nuit du pack. La navigation réelle reste définie par la sortie du nœud ci-dessus.
              </div>
            </div>
            <Toggle on={nightModeActive} onChange={onUpdateNightMode} />
          </div>
        </div>
      </div>

      <div className="card" style={{ borderColor: 'var(--color-danger, #c0392b)' }}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Supprimer le nœud de fin et désactiver le mode nuit.
          </div>
          <button className="btn btn-danger" type="button" onClick={handleRemove}>
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
