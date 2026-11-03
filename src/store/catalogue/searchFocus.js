// Open the containing native disclosure before attempting to focus its field.
export function focusCatalogueSearch(input, schedule = requestAnimationFrame) {
  if (!input) return;
  const disclosure = input.closest('details');
  if (disclosure) disclosure.open = true;
  schedule(() => { if (input.isConnected) input.focus(); });
}
