import { useHelpTranslation } from '../../i18n/helpPresentation.js';
import { useMemo, useState } from 'react';
import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
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
import { normalizeSearchText } from '../../utils/frenchText.js';
import './KeyboardShortcutsModal.css';

function matchesQuery(definition, shortcut, query, t) {
  if (!query) return true;
  const haystack = [
    t(definition.labelKey),
    definition.scope,
    formatShortcut(shortcut),
  ].filter(Boolean).join(' ');
  return normalizeSearchText(haystack).includes(query);
}

export function KeyboardShortcutsModal({
  shortcuts,
  onChange,
  onClose,
}) {
  const { t, language } = useHelpTranslation();
  const [captureId, setCaptureId] = useState(null);
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');

  const normalizedQuery = useMemo(
    () => normalizeSearchText(query).trim(),
    [query],
  );

  const sections = useMemo(() => SHORTCUT_SCOPES.map((scope) => {
    const items = SHORTCUT_DEFINITIONS.filter((d) => d.scope === scope.id)
      .filter((d) => matchesQuery(d, shortcuts?.[d.id] ?? d.defaultShortcut, normalizedQuery, t));
    return { scope, items };
  }).filter((section) => section.items.length > 0), [shortcuts, normalizedQuery, t, language]);

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
      setMessage({ actionKey: conflict.labelKey, scopeKey: SHORTCUT_SCOPES.find((s) => s.id === conflict.scope).labelKey });
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

  // Escape : annule la capture en cours, sinon ferme la modale. Via la pile
  // partagée pour passer devant les Préférences ouvertes dessous, quel que
  // soit l'élément qui a le focus.
  useEscapeKey(true, () => {
    if (captureId) {
      setCaptureId(null);
      setMessage('');
      return;
    }
    onClose();
  });

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal-box keyboard-shortcuts-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span>{t('help:keyboard.modal.title')}</span>
          <Button variant="icon" className="modal-close" onClick={onClose}>✕</Button>
        </div>

        <div className="keyboard-shortcuts-body">
          <div className="keyboard-shortcuts-lead">
            {t('help:keyboard.capture.instructions')}
          </div>

          <input
            type="search"
            className="keyboard-shortcuts-search"
            placeholder={t('help:keyboard.search.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {sections.length === 0 ? (
            <div className="keyboard-shortcuts-empty">{t('help:keyboard.search.empty', { query })}</div>
          ) : null}

          {sections.map(({ scope, items }) => {
            const editableInScope = items.some((d) => !d.readOnly);
            return (
              <div key={scope.id} className="keyboard-shortcuts-section">
                <div className="keyboard-shortcuts-section-head">
                  <div className="keyboard-shortcuts-section-title">
                    {t(scope.labelKey)}
                    {scope.id === 'a11y' ? (
                      <span className="keyboard-shortcuts-fixed-badge">{t('help:keyboard.scope.readOnly')}</span>
                    ) : null}
                  </div>
                  {editableInScope ? (
                    <button
                      type="button"
                      className="keyboard-shortcuts-section-reset"
                      onClick={() => handleResetScope(scope.id)}
                      title={t('help:keyboard.scope.resetTitle', { scope: t(scope.labelKey) })}
                    >
                      {t('help:keyboard.scope.resetAction')}
                    </button>
                  ) : null}
                </div>
                {scope.descriptionKey ? (
                  <div className="keyboard-shortcuts-section-desc">{t(scope.descriptionKey)}</div>
                ) : null}
                <div className="keyboard-shortcuts-list">
                  {items.map((definition) => {
                    const currentShortcut = shortcuts?.[definition.id] ?? definition.defaultShortcut;
                    if (definition.readOnly) {
                      return (
                        <div key={definition.id} className="keyboard-shortcut-row is-readonly">
                          <div className="keyboard-shortcut-info">
                            <div className="opts-row-label">{t(definition.labelKey)}</div>
                            {definition.readOnlyReasonKey ? (
                              <div className="opts-row-sub">{t(definition.readOnlyReasonKey)}</div>
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
                          <div className="opts-row-label">{t(definition.labelKey)}</div>
                          <div className="opts-row-sub">
                            {t('help:keyboard.shortcut.defaultLabel', { shortcut: formatShortcut(DEFAULT_SHORTCUTS[definition.id] ?? definition.defaultShortcut) })}
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
                          {captureId === definition.id ? t('help:keyboard.capture.waiting') : formatShortcut(currentShortcut)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {message ? <div className="keyboard-shortcuts-message">{t('help:keyboard.conflict.message', { action: t(message.actionKey), scope: t(message.scopeKey) })}</div> : null}

          <div className="keyboard-shortcuts-actions">
            <Button onClick={handleResetAll}>{t('help:keyboard.resetAll.action')}</Button>
            <Button variant="primary-violet" onClick={onClose}>{t('common:dialog.close.label')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
