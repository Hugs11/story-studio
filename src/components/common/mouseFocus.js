/**
 * WebKit may focus an ancestor (or the document) on a button mousedown,
 * blurring and unmounting its editor before click. Cancel that default and
 * focus the button explicitly, as on Windows. Inputs keep their native focus
 * and selection behavior; keyboard focus and outside clicks are untouched.
 * Can be used on a button or delegated by an enclosing focus boundary.
 * Do not use with an input or editable element nested inside a button:
 * closest('button') would intercept its mousedown as well.
 */
export function focusButtonOnMouseDown(event) {
  if (event.button !== 0 || event.defaultPrevented) return;
  const button = event.target?.closest?.('button');
  if (button && !event.currentTarget.contains(button)) return;
  if (!button && event.currentTarget?.tagName !== 'BUTTON') return;
  if ((button ?? event.currentTarget).disabled) return;
  event.preventDefault();
  (button ?? event.currentTarget).focus({ preventScroll: true });
}
