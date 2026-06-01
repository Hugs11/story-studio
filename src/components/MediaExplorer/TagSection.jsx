import { useState } from 'react';
import { tagStyle } from './helpers';

export function TagSection({ paths, mediaTags, itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag }) {
  const [newTag, setNewTag] = useState('');
  const targetPaths = (paths ?? []).filter(Boolean);
  const isBulk = targetPaths.length > 1;

  function tagsForPath(path) {
    return mediaTags?.[path] ?? (!isBulk ? itemTags : []);
  }

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
      {allProjectTags.map((tag) => {
        const taggedCount = targetPaths.filter((path) => tagsForPath(path).includes(tag)).length;
        const active = taggedCount === targetPaths.length;
        const partial = taggedCount > 0 && !active;
        return (
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
        );
      })}
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
