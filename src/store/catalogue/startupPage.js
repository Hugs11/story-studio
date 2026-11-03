/** Only the preferred landing page survives an application restart. */
export function startupPage(value) {
  return value === 'catalogue' ? 'catalogue' : 'home';
}
