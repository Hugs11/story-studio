import { Check, X } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { focusButtonOnMouseDown } from '../../common/mouseFocus.js';

/**
 * Inline editor frame shared by the fiche and the multiple-selection panel:
 * Enter/blur saves, Escape cancels, check and cross buttons. Plain render
 * helper (not a component) so the callers' element trees stay flat.
 */
export function inlineEditShell({ t, children, invalid, saving, saveDisabled, onSave, onCancel }) {
  const save = () => { if (!invalid && !saving) onSave(); };
  return <section className="catalogue-inline-editor" aria-label={t('catalogue:fiche.inline.edit')}
    onMouseDown={focusButtonOnMouseDown}
    onBlur={event => { if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return; save(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
      if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return;
      // Multiline description: Enter breaks the line, Ctrl+Enter (Cmd+Enter on macOS) saves.
      const multiline = event.target.tagName === 'TEXTAREA';
      // La pastille de langue (bouton `combobox`) fermée laisse remonter Entrée : elle enregistre comme un champ texte.
      const field = ['INPUT', 'SELECT'].includes(event.target.tagName) || event.target.getAttribute?.('role') === 'combobox';
      if (multiline ? event.ctrlKey || event.metaKey : field) { event.preventDefault(); save(); }
    }}>
    {children}
    <Button variant="icon" size="sm" disabled={saveDisabled || invalid || saving} aria-label={t('catalogue:fiche.edit.save')} onClick={save}><Check width={14} height={14} /></Button>
    <Button variant="icon" size="sm" disabled={saving} aria-label={t('catalogue:fiche.inline.cancel')} onMouseDown={event => event.preventDefault()} onClick={onCancel}><X width={14} height={14} /></Button>
  </section>;
}
