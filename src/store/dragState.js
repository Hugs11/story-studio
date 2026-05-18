// Module singleton — HTML5 DnD API fires dragEnd immediately in WebView2/Tauri
// on Windows (known bug). We use pointer events (pointerdown/pointermove/pointerup)
// instead, and this singleton carries the in-flight drag kind + path.
export const mediaDrag = {
  kind: null,
  path: null,
  start(kind, path) { this.kind = kind; this.path = path; },
  end()              { this.kind = null; this.path = null; },
};
