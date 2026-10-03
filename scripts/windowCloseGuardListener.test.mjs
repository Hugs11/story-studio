// Inscription de la garde de fermeture sous StrictMode.
//
// Au double montage, l'inscription native (`onCloseRequested`) peut répondre
// après le premier nettoyage de l'effet. Le hook `useWindowCloseGuard` est
// importé intact et exécuté par l'ordonnanceur React de test ; seule la fenêtre
// Tauri est doublée, avec des inscriptions dont la réponse est retenue.
//
// Attendu : un seul écouteur actif après le rejeu, aucun après le démontage, une
// seule demande d'enregistrement par fermeture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tauri-apps/api/window') {
      return {
        url: 'data:text/javascript,export function getCurrentWindow(){return globalThis.__closeWindowFixture;}',
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});

const { runner } = await import('./reactHookDriver.mjs');
await import('./tauriDiskHarness.mjs'); // résolution des sources `src/` sans extension
const { useWindowCloseGuard } = await import('../src/hooks/useWindowCloseGuard.js');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const registrations = [];
  const calls = [];
  window.__TAURI_INTERNALS__ = {};
  globalThis.__closeWindowFixture = {
    onCloseRequested(handler) {
      return new Promise((resolve) => {
        const registration = { handler, active: true };
        registration.resolve = () => resolve(async () => { registration.active = false; });
        registrations.push(registration);
      });
    },
    async destroy() { calls.push('destroy'); },
  };
  const app = runner(() => useWindowCloseGuard({
    saveHandlerRef: { current: async () => 'saved.mbah' },
    askSaveBeforeLeave: async () => { calls.push('ask-save'); return false; },
    beforeClose: async () => calls.push('cleanup'),
  }));
  const active = () => registrations.filter((registration) => registration.active);
  const close = () => Promise.all(active().map((registration) => (
    registration.handler({ preventDefault: () => {} })
  )));
  return { app, registrations, calls, active, close };
}

test('inscription résolue après le rejeu StrictMode : un seul écouteur, une seule demande', async () => {
  const f = fixture();
  f.app.render();
  f.app.flush();
  f.app.replayEffects();
  f.registrations.forEach((registration) => registration.resolve());
  await settle();

  assert.equal(f.registrations.length, 2);
  assert.equal(f.active().length, 1, 'un seul écouteur actif après le rejeu');
  await f.close();
  assert.deepEqual(f.calls, ['ask-save'], 'une seule demande d\'enregistrement par fermeture');

  f.app.unmount();
  await settle();
  assert.equal(f.active().length, 0, 'aucun écouteur après le démontage');
});

test('démontage avant la réponse de l\'inscription : aucun écouteur ne reste', async () => {
  const f = fixture();
  f.app.render();
  f.app.flush();
  f.app.unmount();
  f.registrations.forEach((registration) => registration.resolve());
  await settle();
  assert.equal(f.active().length, 0);
});

test('inscription résolue avant le démontage : retirée au démontage', async () => {
  const f = fixture();
  f.app.render();
  f.app.flush();
  f.registrations.forEach((registration) => registration.resolve());
  await settle();
  assert.equal(f.active().length, 1);
  f.app.unmount();
  await settle();
  assert.equal(f.active().length, 0);
});
