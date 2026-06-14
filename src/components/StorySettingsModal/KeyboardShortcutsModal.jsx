import { useMemo, useState } from 'react';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  SHORTCUT_SCOPES,
  findShortcutConflict,
  formatShortcut,
  resetKeyboardShortcuts,
  resetKeyboardShortcutsForScope,
  shortcutFromEvent,
} from '../../store/keyboardShortcuts';
import './KeyboardShortcutsModal.css';

function normalizeFilter(value) {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchesQuery(definition, shortcut, query) {
  if (!query) return true;
  const haystack = [
    definition.label,
    definition.scope,
    formatShortcut(shortcut),
  ].filter(Boolean).join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return haystack.includes(query);
}

export function KeyboardShortcutsModal({
  shortcuts,
  onChange,
  onClose,
}) {
  const [captureId, setCaptureId] = useState(null);
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');

  const normalizedQuery = useMemo(() => normalizeFilter(query.trim()), [query]);

  const sections = useMemo(() => SHORTCUT_SCOPES.map((scope) => {
    const items = SHORTCUT_DEFINITIONS.filter((d) => d.scope === scope.id)
      .filter((d) => matchesQuery(d, shortcuts?.[d.id] ?? d.defaultShortcut, normalizedQuery));
    return { scope, items };
  }).filter((section) => section.items.length > 0), [shortcuts, normalizedQuery]);

  function handleKeyDown(event, definition) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setCaptureId(null);
      setMessage('');
      return;
    }

    const nextShortcut = shortcutFromEvent(event);
    if (!nextShortcut) return;
    event.preventDefault();
    event.stopPropagation();

    const conflict = findShortcutConflict(shortcuts, definition.id, nextShortcut);
    if (conflict) {
      const scopeLabel = SHORTCUT_SCOPES.find((s) => s.id === conflict.scope)?.label || conflict.scope;
      setMessage(`Déjà utilisé par « ${conflict.label} » dans ${scopeLabel}.`);
      return;
    }

    onChange({ ...shortcuts, [definition.id]: nextShortcut });
    setCaptureId(null);
    setMessage('');
  }

  function handleResetAll() {
    const defaults = resetKeyboardShortcuts();
    onChange(defaults);
    setCaptureId(null);
    setMessage('');
  }

  function handleResetScope(scopeId) {
    onChange(resetKeyboardShortcutsForScope(shortcuts, scopeId));
    setCaptureId(null);
    setMessage('');
  }

  function handleOverlayKeyDown(event) {
    if (captureId) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={handleOverlayKeyDown}
    >
      <div
        className="modal-box keyboard-shortcuts-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>Raccourcis clavier</span>
          <button className="btn btn-icon modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="keyboard-shortcuts-body">
          <div className="keyboard-shortcuts-lead">
            Clique sur un raccourci puis presse la nouvelle combinaison. Échap annule la capture.
          </div>

          <input
            type="search"
            className="keyboard-shortcuts-search"
            placeholder="Rechercher un raccourci…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {sections.length === 0 ? (
            <div className="keyboard-shortcuts-empty">Aucun raccourci ne correspond à « {query} ».</div>
          ) : null}

          {sections.map(({ scope, items }) => {
            const editableInScope = items.some((d) => !d.readOnly);
            return (
              <div key={scope.id} className="keyboard-shortcuts-section">
                <div className="keyboard-shortcuts-section-head">
                  <div className="keyboard-shortcuts-section-title">
                    {scope.label}
                    {scope.id === 'a11y' ? (
                      <span className="keyboard-shortcuts-fixed-badge">lecture seule</span>
                    ) : null}
                  </div>
                  {editableInScope ? (
                    <button
                      type="button"
                      className="keyboard-shortcuts-section-reset"
                      onClick={() => handleResetScope(scope.id)}
                      title={`Restaurer les valeurs par défaut pour « ${scope.label} »`}
                    >
                      Réinitialiser
                    </button>
                  ) : null}
                </div>
                {scope.description ? (
                  <div className="keyboard-shortcuts-section-desc">{scope.description}</div>
                ) : null}
                <div className="keyboard-shortcuts-list">
                  {items.map((definition) => {
                    const currentShortcut = shortcuts?.[definition.id] ?? definition.defaultShortcut;
                    if (definition.readOnly) {
                      return (
                        <div key={definition.id} className="keyboard-shortcut-row is-readonly">
                          <div className="keyboard-shortcut-info">
                            <div className="opts-row-label">{definition.label}</div>
                            {definition.readOnlyReason ? (
                              <div className="opts-row-sub">{definition.readOnlyReason}</div>
                            ) : null}
                          </div>
                          <div className="keyboard-shortcut-keys">
                            <kbd className="kbd">{formatShortcut(definition.defaultShortcut)}</kbd>
                            {(definition.aliases || []).map((alias, idx) => (
                              <kbd key={idx} className="kbd">{formatShortcut(alias)}</kbd>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={definition.id} className="keyboard-shortcut-row">
                        <div className="keyboard-shortcut-info">
                          <div className="opts-row-label">{definition.label}</div>
                          <div className="opts-row-sub">
                            Défaut : {formatShortcut(DEFAULT_SHORTCUTS[definition.id] ?? definition.defaultShortcut)}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`keyboard-shortcut-capture ${captureId === definition.id ? 'is-capturing' : ''}`}
                          onClick={() => {
                            setCaptureId(definition.id);
                            setMessage('');
                          }}
                          onKeyDown={(event) => captureId === definition.id && handleKeyDown(event, definition)}
                        >
                          {captureId === definition.id ? 'Appuie sur un raccourci…' : formatShortcut(currentShortcut)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {message ? <div className="keyboard-shortcuts-message">{message}</div> : null}

          <div className="keyboard-shortcuts-actions">
            <button className="btn" type="button" onClick={handleResetAll}>Tout réinitialiser</button>
            <button className="btn btn-primary" type="button" onClick={onClose}>Fermer</button>
          </div>
        </div>
      </div>
    </div>
  );
}
