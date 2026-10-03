// Dépôt de fichiers « comme depuis l'Explorateur », sans souris réelle.
//
// L'application écoute `onDragDropEvent` (`tauri://drag-enter`, `-over`,
// `-drop`) et situe la cible par `elementFromPoint` à la position reçue, en
// pixels physiques. On émet la même séquence d'événements par l'IPC, au centre
// de l'élément visé.
export async function dropFiles(page, selector, paths) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: 'visible' });
  const box = await target.boundingBox();
  if (!box) throw new Error(`Cible de dépôt sans boîte : ${selector}`);
  const css = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(async ({ css: point, paths: files }) => {
    const ratio = window.devicePixelRatio || 1;
    const position = { x: Math.round(point.x * ratio), y: Math.round(point.y * ratio) };
    const emit = (event, payload) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload });
    await emit('tauri://drag-enter', { paths: files, position });
    await emit('tauri://drag-over', { position });
    await emit('tauri://drag-drop', { paths: files, position });
  }, { css, paths });
}
