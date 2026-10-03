// Retrait d'un écouteur Tauri inscrit en retard côté page.
//
// La fumée e2e relevait au démarrage « Cannot read properties of undefined
// (reading 'handlerId') » dans le nettoyage de `useOsFileDrop` : l'effet,
// démonté par StrictMode avant la fin de son `listen`, retirait un écouteur
// que le script injecté par Rust n'avait pas encore inscrit. Le faux ci-dessous
// reproduit la forme de `_unlisten` (tauri 2) : lecture de l'inscription côté
// page, puis retrait côté Rust.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import test from 'node:test';
import assert from 'node:assert/strict';

import { releaseTauriListener } from '../src/utils/tauriListener.js';

function lateRegistration({ registerAfterMs }) {
  const pageListeners = {};
  const state = { rustUnlistened: false };
  setTimeout(() => { pageListeners[7] = { handlerId: 42 }; }, registerAfterMs);
  const unlisten = async () => {
    // `unregisterListener` : `listeners[eventId].handlerId`, sans garde.
    const _handlerId = pageListeners[7].handlerId;
    state.rustUnlistened = true;
  };
  return { unlisten, state };
}

test('contre-épreuve : un retrait immédiat rejette et ne retire rien côté Rust', async () => {
  const { unlisten, state } = lateRegistration({ registerAfterMs: 10 });
  await assert.rejects(unlisten(), /handlerId/);
  assert.equal(state.rustUnlistened, false);
});

test('un écouteur inscrit en retard est retiré au second essai, sans rejet', async () => {
  const { unlisten, state } = lateRegistration({ registerAfterMs: 10 });
  const errors = [];
  const released = await releaseTauriListener(unlisten, { retryDelayMs: 30, onError: (error) => errors.push(error) });
  assert.equal(released, true);
  assert.equal(state.rustUnlistened, true);
  assert.deepEqual(errors, []);
});

test('un échec persistant est remis à onError, jamais rejeté', async () => {
  const { unlisten, state } = lateRegistration({ registerAfterMs: 1_000 });
  const errors = [];
  const released = await releaseTauriListener(unlisten, { retryDelayMs: 5, onError: (error) => errors.push(error) });
  assert.equal(released, false);
  assert.equal(state.rustUnlistened, false);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /handlerId/);
});

test('rien à retirer : un effet démonté avant la réponse de listen', async () => {
  assert.equal(await releaseTauriListener(null), true);
  assert.equal(await releaseTauriListener(undefined), true);
});
