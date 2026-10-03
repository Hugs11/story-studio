// Exécuté dans <head>, avant tout module frontend. Tauri initialise ses
// internals avant le document ; aucun appel de l'application ne précède ceci.
export function installCollector(workspace) {
  const queue = window.__E2E_WD_EVENTS__ = [];
  const push = (kind, data) => queue.push({ kind, at: Date.now(), ...data });
  if (workspace) localStorage.setItem('storyStudioWorkspaceDir', workspace);
  for (const type of ['log', 'info', 'debug', 'warn', 'error']) {
    const original = console[type].bind(console);
    console[type] = (...args) => {
      push('console', { type: type === 'warn' ? 'warning' : type, text: args.map(String).join(' ') });
      original(...args);
    };
  }
  window.addEventListener('error', e => push('pageerror', { text: e.error?.stack || e.message }));
  window.addEventListener('unhandledrejection', e => push('pageerror', { text: String(e.reason?.stack || e.reason) }));
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error('Collecteur e2e : internals Tauri absents avant le frontend');
  // Les méthodes Tauri sont non modifiables. Observer le transport fetch,
  // sans toucher aux clés d'invocation ni changer la réponse consommée.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const url = String(input?.url || input);
    const ipc = /^(ipc:\/\/localhost\/|https?:\/\/ipc\.localhost\/)/.test(url);
    const cmd = ipc ? decodeURIComponent(new URL(url).pathname.slice(1)) : null;
    if (ipc) {
      let body = options?.body ?? null;
      // Le plugin fs envoie le texte du projet comme Uint8Array. Ne pas
      // transporter ses millions d'indices via le clone objet de WebDriver.
      if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(body); }
        catch {
          const bytes = ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array(body);
          let encoded = '';
          for (let offset = 0; offset < bytes.length; offset += 16_384) {
            encoded += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
          }
          body = { encoding: 'base64', byteLength: bytes.length, data: btoa(encoded) };
        }
      }
      try { body = JSON.parse(body); } catch { /* texte brut ou corps base64 */ }
      push('request', { cmd, body });
    }
    const response = await originalFetch(input, options);
    if (ipc && response.headers.get('Tauri-Response') !== 'ok') {
      push('response', { cmd, status: response.status, text: await response.clone().text() });
    }
    return response;
  };
  // Le repli postMessage est également observable. Les callbacks restent
  // ceux de Tauri, seules les erreurs sont recopiées avant leur livraison.
  const handler = window.webkit?.messageHandlers?.ipc;
  const originalPost = handler?.postMessage;
  if (originalPost) {
    handler.postMessage = function(data) {
      const message = JSON.parse(data);
      push('request', { cmd: message.cmd, body: message.payload });
      const error = internals.callbacks.get(message.error);
      if (error) internals.callbacks.set(message.error, value => {
        push('response', { cmd: message.cmd, status: 500, text: String(value) });
        return error(value);
      });
      return originalPost.call(this, data);
    };
    if (handler.postMessage === originalPost) throw new Error('Transport postMessage non observable');
  }
  window.__E2E_WD_COLLECTOR_READY__ = true;
}
