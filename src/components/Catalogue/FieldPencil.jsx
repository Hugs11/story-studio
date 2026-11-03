import { Tooltip } from '../common/Tooltip.jsx';
import { Button } from '../common/Button.jsx';
import { Pencil } from '../icons/LucideLocal.jsx';

/**
 * Discreet pencil of a retouchable value: hidden until its host (an element
 * carrying `catalogue-fiche-editable`) is hovered or holds the keyboard focus,
 * always shown on touch screens (CatalogueViews.css). Plain render helper (not
 * a component) shared by the fiche fields and the Lunii name, so that the
 * callers' element trees stay flat.
 */
// A refused pencil stays focusable with its reason in the tooltip (a real
// `disabled` leaves the tab order and hides the tooltip under WebKitGTK/WKWebView).
export function fieldPencil({ id, label, tooltip = label, onClick, disabled = false }) {
  return <Tooltip text={tooltip} asChild wrap>
    <Button className="catalogue-fiche-field-action" id={id} variant="icon" size="sm" aria-disabled={disabled ? 'true' : undefined} aria-label={label} onClick={disabled ? undefined : onClick}><Pencil width={14} height={14} /></Button>
  </Tooltip>;
}
