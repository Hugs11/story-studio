// Collecte continue de ce qui trahit un défaut sans avoir besoin d'une spec :
// erreurs et avertissements console, exceptions non rattrapées, commandes IPC
// en échec. Le journal IPC complet sert aussi de trace (quel média chaque écran
// du simulateur a chargé).
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const IPC_PREFIX = 'http://ipc.localhost/';

function ipcCommand(url) {
  return decodeURIComponent(url.slice(IPC_PREFIX.length).split('?')[0]);
}

export function attachCollectors(page, runDir) {
  const events = [];
  const ipc = [];
  let flushed = 0;
  let step = 'démarrage';
  const record = (kind, data) => {
    const event = { at: new Date().toISOString(), step, kind, ...data };
    events.push(event);
    appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  };

  page.on('console', message => {
    const type = message.type();
    if (type === 'error' || type === 'warning') record(`console.${type}`, { text: message.text() });
  });
  page.on('pageerror', error => record('pageerror', { text: String(error?.stack || error) }));
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith(IPC_PREFIX)) return;
    let body = null;
    try { body = request.postDataJSON(); } catch { body = request.postData(); }
    ipc.push({ at: Date.now(), step, cmd: ipcCommand(url), body });
  });
  page.on('response', async response => {
    const url = response.url();
    const tauriError = response.headers?.()['tauri-response'] === 'error';
    if (!url.startsWith(IPC_PREFIX) || (response.ok() && !tauriError)) return;
    let text = '';
    try { text = await response.text(); } catch { /* corps indisponible */ }
    record('ipc.error', { cmd: ipcCommand(url), status: response.status(), text: text.slice(0, 2000) });
  });

  return {
    all: () => events.slice(),
    ipc: () => ipc.slice(),
    setStep(name) { step = name; },
    // Défauts affirmables sans spec : exceptions et erreurs console.
    // Avertissements et refus IPC restent consultables sans faire rougir les refus attendus.
    faults: () => {
      const signals = events.filter(event => event.kind === 'console.warning' || event.kind === 'ipc.error');
      if (signals.length) console.warn('Signaux E2E (events.jsonl) :', JSON.stringify(signals));
      return events.filter(event => event.kind === 'pageerror' || event.kind === 'console.error');
    },
    flush() {
      const batch = ipc.slice(flushed);
      if (batch.length) appendFileSync(join(runDir, 'ipc.jsonl'), batch.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      flushed = ipc.length;
    },
  };
}
