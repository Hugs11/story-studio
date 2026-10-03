import { useState } from 'react';
import { tagStyle } from './helpers';
import { selectionTagStates } from '../../store/mediaTags';

export function TagSection({ paths, mediaTags, itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag }) {
  const [newTag, setNewTag] = useState('');
  const targetPaths = (paths ?? []).filter(Boolean);
  const isBulk = targetPaths.length > 1;

  // La lecture du panneau est celle de `store/mediaTags.js`, et elle voit tous
  // les alias d'un même fichier : un chemin se présente ici en forme native ou
  // en `/` selon le champ d'où il vient, et une carte héritée peut porter les
  // deux. Afficher la première entrée seule contredirait la vignette, et un
  // retrait laisserait survivre l'étiquette de l'autre alias.
  const states = selectionTagStates(mediaTags, targetPaths, allProjectTags, itemTags);

  function handleSubmit(e) {
    e.preventDefault();
    const t = newTag.trim();
    if (t) {
      for (const path of targetPaths) onAddMediaTag(path, t);
      setNewTag('');
    }
  }

  return (
    <div className="ctx-tag-section">
      <div className="ctx-tag-header">{isBulk ? `Tags (${targetPaths.length})` : 'Tags'}</div>
      {states.map(({ tag, active, partial }) => (
        <button
          key={tag}
          type="button"
          className={`ctx-tag-toggle${partial ? ' is-partial' : ''}`}
          onClick={() => {
            for (const path of targetPaths) {
              if (active) onRemoveMediaTag(path, tag);
              else onAddMediaTag(path, tag);
            }
          }}
        >
          <span className="ctx-tag-check">{active ? '✓' : partial ? '–' : ''}</span>
          <span className="me-tag-chip" style={tagStyle(tag)}>{tag}</span>
        </button>
      ))}
      <form className="ctx-tag-new-form" onSubmit={handleSubmit}>
        <input
          className="ctx-tag-new-input"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="+ Nouveau tag"
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
    </div>
  );
}
