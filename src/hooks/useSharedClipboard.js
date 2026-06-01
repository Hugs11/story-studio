// Clipboard partagé entre TreePanel et le diagramme complet.
// Singleton module-level : pas de prop-drilling, pas de Context.
const sharedClipboard = { current: null };

export function useSharedClipboard() {
  return sharedClipboard;
}
