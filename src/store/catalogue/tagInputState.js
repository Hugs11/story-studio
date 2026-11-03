// Keyboard transitions are shared by combobox rendering and pure tests.
export function tagInputKey(state, key, count) {
  if (key === 'Escape') return { open: false, active: -1, command: null };
  if (key === 'Enter') return { ...state, command: state.open && state.active >= 0 && state.active < count ? 'suggestion' : 'submit' };
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;
  return { open: true, active: count ? Math.max(0, Math.min(count - 1, state.active + (key === 'ArrowDown' ? 1 : -1))) : -1, command: null };
}
