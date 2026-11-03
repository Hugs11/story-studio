// Navigation aux flèches dans un menu : les entrées sont celles du menu lui-même
// (`role="menu"` le plus proche), jamais celles d'un sous-menu ouvert à côté.

const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], input[data-menu-input]';

export function menuItems(menu) {
  return [...(menu?.querySelectorAll(ITEMS) ?? [])].filter(item => item.closest('[role="menu"]') === menu && !item.disabled);
}

/** Déplace le focus pour ↓ ↑ Début Fin ; vrai si la touche a été traitée. */
export function navigateMenu(event, menu) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  const items = menuItems(menu);
  if (!items.length) return false;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
  return true;
}
