// Retrait d'un écouteur d'événement Tauri (`listen`, `onDragDropEvent`…).
//
// `listen` rend son identifiant dès la réponse IPC, mais la page n'inscrit
// l'écouteur que par un script que Rust injecte à part (`listen_js_script`,
// tauri 2) : les deux arrivent parfois dans le désordre. Un retrait lancé dans
// cet intervalle — un effet démonté avant la fin de son `listen`, comme au
// double montage de StrictMode au démarrage — lit un écouteur encore absent
// (« Cannot read properties of undefined (reading 'handlerId') »), rejette
// sans que personne l'attende, et ne retire rien côté Rust : le gestionnaire
// reste branché. On réessaie donc une fois, l'inscription arrivée.
//
// Ne rejette jamais : un échec persistant est remis à `onError`.

const RELEASE_RETRY_DELAY_MS = 100;

export async function releaseTauriListener(unlisten, { onError, retryDelayMs = RELEASE_RETRY_DELAY_MS } = {}) {
  if (typeof unlisten !== 'function') return true;
  try {
    await unlisten();
    return true;
  } catch {
    // Inscription pas encore arrivée côté page : second essai plus bas.
  }
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  try {
    await unlisten();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
