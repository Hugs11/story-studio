export function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}
