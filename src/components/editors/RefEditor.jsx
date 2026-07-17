import { memo } from 'react';
import { Trash2 } from '../icons/LucideLocal';
import { NavigationTargetSelect } from './story/storyUtils';
import { refTargetEntryId } from '../../store/navigationTargets';
import './EditorPanel.css';

// Éditeur d'un nœud `ref` (« → nœud existant ») : change la cible, la présentation
// (↪ continuer / ↩ revenir) ou supprime le lien. La cible n'est jamais affectée.
export const RefEditor = memo(function RefEditor({ node, allMenus = [], allStories = [], onUpdate, onDelete }) {
  const targetId = refTargetEntryId(node.target);
  const targetEntry = allStories.find((s) => s.id === targetId)
    ?? allMenus.find((m) => m.id === targetId)
    ?? null;
  const targetName = targetEntry?.name || (node.target ? '(cible introuvable)' : 'aucune cible');

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">Lien</div>
          <div className="card-copy card-copy--inline">
            Renvoie vers un nœud déjà présent au lieu d'en créer un nouveau — pour faire converger
            plusieurs chemins vers la même histoire ou le même dossier.
          </div>
        </div>

        <div className="field-row">
          <span className="field-label" style={{ flex: 1 }}>Pointe vers</span>
          <NavigationTargetSelect
            value={node.target ?? ''}
            onChange={(target) => onUpdate({ target: target || null })}
            allMenus={allMenus}
            allStories={allStories}
            currentStoryId={null}
            includeNextStory={false}
            emptyLabel="Choisir un nœud…"
            style={{ minWidth: 240, maxWidth: 360 }}
          />
        </div>

        <div className="field-row">
          <span className="field-label" style={{ flex: 1 }}>Présentation</span>
          <select
            className="field-input"
            value={node.refKind === 'return' ? 'return' : 'continue'}
            onChange={(e) => onUpdate({ refKind: e.target.value })}
            style={{ maxWidth: 360 }}
          >
            <option value="continue">↪ Continuer vers…</option>
            <option value="return">↩ Revenir à…</option>
          </select>
        </div>
      </div>

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={onDelete}
            aria-label="Supprimer ce lien"
            title="Supprimer ce lien"
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">Supprimer ce lien</span>
          <p className="card-danger-desc">
            Le lien vers « {targetName} » sera retiré. La cible n'est pas affectée.
          </p>
        </div>
      </div>
    </>
  );
});
