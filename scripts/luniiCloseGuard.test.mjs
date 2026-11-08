// Fermeture pendant une opération Lunii : détection, dialogue, attente, double
// demande et cohabitation avec la file de rendu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tauri-apps/api/window') {
      return { url: 'data:text/javascript,export function getCurrentWindow(){return {};}', shortCircuit: true };
    }
    return next(specifier, context);
  },
});
await import('./tauriDiskHarness.mjs');
const { createWindowCloseHandler } = await import('../src/hooks/useWindowCloseGuard.js');
const { createLuniiActivity, createLuniiCloseGuard, describeLuniiActivity } = await import('../src/store/luniiCloseGuard.js');

const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
  const jobs = new Set();
  return {
    setInterval: fn => { jobs.add(fn); return fn; },
    clearInterval: id => { jobs.delete(id); },
    async tick() { for (const fn of [...jobs]) await fn(); await settle(); },
    get running() { return jobs.size; },
  };
}

function fixture({ choice = 'wait', save = true, render = true, queued = 0, signature = null } = {}) {
  const calls = [];
  const timers = fakeTimers();
  const engine = { devices: [], failing: false, async list() { if (this.failing) throw new Error('down'); return this.devices; } };
  const state = { luniiDevices: [] };
  const listeners = new Set();
  const source = {
    getSnapshot: () => state,
    subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    queued: () => queued,
    cancelQueued: () => { queued = 0; calls.push('cancel-queued'); },
  };
  const activity = createLuniiActivity();
  activity.register(source);
  const setDevices = devices => { state.luniiDevices = devices; for (const l of [...listeners]) l(); };
  const asks = [];
  const guard = createLuniiCloseGuard({ activity, engine, timers, ask: async a => { asks.push(a); calls.push('ask-lunii'); return choice; } });
  const work = { signature };
  const current = {
    luniiGuard: guard,
    readWorkSignature: signature === null ? undefined : () => work.signature,
    saveHandlerRef: { current: null },
    askSaveBeforeLeave: async () => { calls.push('ask-save'); return Array.isArray(save) ? save.shift() : save; },
    confirmClose: async () => { calls.push('render'); return render; },
    beforeClose: async () => calls.push('cleanup'),
  };
  const lock = { acquire: () => ({ release() { calls.push('release'); } }) };
  const handler = createWindowCloseHandler({ readCurrent: () => current, win: { destroy: async () => calls.push('destroy') }, lock });
  const close = () => handler({ preventDefault() {} });
  // Fin d'attente = deux lectures calmes consécutives.
  const idleTicks = async () => { await timers.tick(); await timers.tick(); await settle(); };
  return { calls, asks, guard, setDevices, close, current, engine, timers, work, idleTicks };
}
const busy = (extra = {}) => [{ id: 'a', busy: true, ...extra }];

test('aucune opération Lunii : comportement inchangé', async () => {
  const f = fixture();
  await f.close();
  assert.deepEqual(f.calls, ['render', 'ask-save', 'cleanup', 'destroy', 'release']);
});

test('opération en cours puis « Annuler » : rien ne se ferme, pas de question d’enregistrement', async () => {
  const f = fixture({ choice: 'cancel' });
  f.setDevices(busy({ sending: true }));
  await f.close();
  assert.deepEqual(f.calls, ['render', 'ask-lunii']);
  assert.equal(f.asks[0].kind, 'send');
});

test('« Attendre la fin » : enregistrement d’abord, fermeture seulement à la fin', async () => {
  const f = fixture();
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  assert.deepEqual(f.calls, ['render', 'ask-lunii', 'ask-save']);
  assert.equal(f.guard.isWaiting(), true);
  f.setDevices(busy());
  await settle();
  assert.ok(!f.calls.includes('destroy'));
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.deepEqual(f.calls, ['render', 'ask-lunii', 'ask-save', 'render', 'cleanup', 'destroy', 'release']);
  assert.equal(f.guard.isWaiting(), false);
});

test('enregistrement refusé : aucune attente, aucune fermeture', async () => {
  const f = fixture({ save: false });
  f.setDevices(busy());
  await f.close();
  assert.deepEqual(f.calls, ['render', 'ask-lunii', 'ask-save']);
  assert.equal(f.guard.isWaiting(), false);
});

test('« Ne pas fermer » pendant l’attente : pas de fermeture à la fin', async () => {
  const f = fixture();
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.guard.cancelWait();
  await closing;
  f.setDevices([]);
  await settle();
  assert.ok(!f.calls.includes('destroy'));
  await f.close(); // une nouvelle demande repart normalement
  assert.ok(f.calls.includes('destroy'));
});

test('débranchement pendant l’attente : fermeture', async () => {
  const f = fixture();
  f.setDevices(busy({ id: 'a' }));
  const closing = f.close();
  await settle();
  f.setDevices([{ id: 'a', state: 'disconnected', busy: false }]);
  await f.idleTicks();
  await closing;
  assert.ok(f.calls.includes('destroy'));
});

test('double demande : un seul dialogue, une seule fermeture', async () => {
  const f = fixture();
  f.setDevices(busy());
  const first = f.close();
  await settle();
  await f.close();
  await f.close();
  assert.equal(f.asks.length, 1);
  f.setDevices([]);
  await f.idleTicks();
  await first;
  assert.equal(f.calls.filter(c => c === 'destroy').length, 1);
  assert.equal(f.calls.filter(c => c === 'ask-save').length, 1);
});

test('file de rendu d’abord : refus du rendu = pas de dialogue Lunii', async () => {
  const f = fixture({ render: false });
  f.setDevices(busy());
  await f.close();
  assert.deepEqual(f.calls, ['render']);
});

test('rendu accepté puis Lunii : une seule séquence, une seule fermeture', async () => {
  const f = fixture();
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.deepEqual(f.calls.filter(c => ['render', 'ask-lunii', 'destroy'].includes(c)), ['render', 'ask-lunii', 'render', 'destroy']);
});

test('« Annuler le reste » : seulement avec des opérations en attente, la courante n’est pas coupée', async () => {
  const f = fixture({ choice: 'cancelRest', queued: 2 });
  f.setDevices(busy());
  assert.equal(await f.guard.isBusy(), true);
  const closing = f.close();
  await settle();
  assert.ok(f.calls.includes('cancel-queued'));
  assert.ok(!f.calls.includes('destroy'));
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.ok(f.calls.includes('destroy'));
  const g = fixture({ choice: 'cancelRest', queued: 0 });
  g.setDevices(busy());
  const c = g.close();
  await settle();
  assert.ok(!g.calls.includes('cancel-queued'));
  g.setDevices([]);
  await g.idleTicks();
  await c;
});

test('describeLuniiActivity : type, titre et file', () => {
  assert.deepEqual(describeLuniiActivity([], 0), { active: false, kind: 'generic', title: null, queued: 0 });
  assert.equal(describeLuniiActivity([{ busy: true, sending: true }]).kind, 'send');
  const d = { busy: true, pendingKeys: ['k'], stories: [{ key: 'k', title: ' Titre ' }] };
  assert.equal(describeLuniiActivity([d]).title, 'Titre');
  assert.equal(describeLuniiActivity([], 1).active, true);
});

test('moteur occupé sans source JS : le dialogue s’affiche', async () => {
  const f = fixture({ choice: 'cancel' });
  f.engine.devices = [{ id: 'a', busy: true }];
  await f.close();
  assert.deepEqual(f.calls, ['render', 'ask-lunii']);
});

test('désinscription de la source pendant l’attente, moteur occupé : pas de fermeture', async () => {
  const f = fixture();
  f.engine.devices = [{ id: 'a', busy: true }];
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.setDevices([]);
  await f.idleTicks();
  await f.idleTicks();
  assert.ok(!f.calls.includes('destroy'));
  f.engine.devices = [];
  await f.idleTicks();
  await closing;
  assert.ok(f.calls.includes('destroy'));
});

test('creux d’une seule lecture entre deux éléments d’un lot : pas de fermeture', async () => {
  const f = fixture();
  f.engine.devices = [{ id: 'a', busy: true }];
  const closing = f.close();
  await settle();
  f.engine.devices = [];
  await f.timers.tick();
  f.engine.devices = [{ id: 'a', busy: true }];
  await f.timers.tick();
  f.engine.devices = [];
  await f.timers.tick();
  assert.ok(!f.calls.includes('destroy'));
  await f.timers.tick();
  await closing;
  assert.ok(f.calls.includes('destroy'));
});

test('list() en échec : l’attente continue, jamais de fermeture faute d’information', async () => {
  const f = fixture();
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.setDevices([]);
  f.engine.failing = true;
  await f.idleTicks();
  await f.idleTicks();
  assert.ok(!f.calls.includes('destroy'));
  assert.equal(f.guard.isWaiting(), true);
  f.guard.cancelWait();
  await closing;
  assert.ok(!f.calls.includes('destroy'));
});

test('projet modifié pendant l’attente : la question d’enregistrement revient, refus = pas de fermeture', async () => {
  const f = fixture({ signature: 's1', save: [true, false] });
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.work.signature = 's2';
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.equal(f.calls.filter(c => c === 'ask-save').length, 2);
  assert.ok(!f.calls.includes('destroy'));
});

test('projet inchangé pendant l’attente : fermeture sans nouvelle question', async () => {
  const f = fixture({ signature: 's1' });
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.equal(f.calls.filter(c => c === 'ask-save').length, 1);
  assert.ok(f.calls.includes('destroy'));
});

test('après l’attente, la file de rendu est reconsultée', async () => {
  const f = fixture();
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.current.confirmClose = async () => { f.calls.push('render2'); return false; };
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.ok(f.calls.includes('render2'));
  assert.ok(!f.calls.includes('destroy'));
});

test('moteur de nouveau occupé juste avant la destruction : l’attente reprend', async () => {
  const f = fixture();
  f.setDevices(busy());
  const closing = f.close();
  await settle();
  f.setDevices([]);
  let reads = 0;
  f.engine.list = async () => { reads += 1; return reads === 3 ? [{ id: 'a', busy: true }] : (reads > 3 && reads < 6 ? [{ id: 'a', busy: true }] : []); };
  for (let i = 0; i < 10; i += 1) await f.timers.tick();
  await closing;
  assert.ok(f.calls.includes('destroy'));
  assert.ok(reads >= 5);
});

test('réservation native refusée après l’attente : la panne est signalée', async () => {
  const f = fixture();
  const calls = [];
  const handler = createWindowCloseHandler({ readCurrent: () => f.current, win: { destroy: async () => calls.push('destroy') }, lock: { acquire: () => null } });
  f.setDevices(busy());
  const closing = handler({ preventDefault() {} });
  await settle();
  f.setDevices([]);
  await f.idleTicks();
  await closing;
  assert.deepEqual(calls, []);
  assert.equal(f.guard.hasFailed(), true);
});
