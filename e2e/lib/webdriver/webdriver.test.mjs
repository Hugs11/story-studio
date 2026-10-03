import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { installCollector } from './collector.mjs';
import { WebDriverClient } from './client.mjs';
import { WebDriverPage } from './page.mjs';
import { runInNewContext } from 'node:vm';

test('le collecteur précède le premier IPC, conserve réponse, erreur et workspace', async () => {
  const values = new Map(), listeners = {};
  const internals = { callbacks: new Map() };
  let posted = null, delivered = null;
  internals.callbacks.set(42, value => { delivered = value; });
  Object.defineProperty(internals, 'invoke', { value() {} });
  const native = { postMessage(data) { posted = data; } };
  const window = { __TAURI_INTERNALS__: internals, webkit: { messageHandlers: { ipc: native } }, addEventListener: (k, fn) => { listeners[k] = fn; },
    fetch: async url => new Response(url.endsWith('refus') ? 'refus attendu' : '{"ok":true}', { headers: { 'Tauri-Response': url.endsWith('refus') ? 'error' : 'ok' } }) };
  window.ipc = Object.freeze({ postMessage: data => native.postMessage(data) });
  runInNewContext(`(${installCollector})('/tmp/isolé')`, { window, localStorage: { setItem: (k,v) => values.set(k,v) }, console: { log() {}, info() {}, debug() {}, warn() {}, error() {} }, URL, TextDecoder, btoa });
  assert.equal(values.get('storyStudioWorkspaceDir'), '/tmp/isolé');
  const response = await window.fetch('ipc://localhost/commande', { body: '{"a":1}' });
  assert.deepEqual(await response.json(), { ok: true });
  await window.fetch('ipc://localhost/refus', { body: '{}' });
  assert.equal(window.__E2E_WD_EVENTS__[0].cmd, 'commande');
  assert.equal(window.__E2E_WD_EVENTS__[0].body.a, 1);
  assert.equal(window.__E2E_WD_EVENTS__[2].kind, 'response');
  await window.fetch('ipc://localhost/ecriture', { body: new TextEncoder().encode('{"texte":"écriture é"}') });
  assert.equal(window.__E2E_WD_EVENTS__.at(-1).body.texte, 'écriture é');
  const binary = new Uint8Array([255, 254, 0, 1]);
  await window.fetch('ipc://localhost/binaire', { body: binary });
  const stored = window.__E2E_WD_EVENTS__.at(-1).body;
  assert.equal(stored.encoding, 'base64');
  assert.deepEqual(Buffer.from(stored.data, 'base64'), Buffer.from(binary));

  listeners.unhandledrejection({ reason: new Error('exception attendue') });
  assert.match(window.__E2E_WD_EVENTS__.at(-1).text, /exception attendue/);
  const fallback = JSON.stringify({ cmd: 'repli', payload: { a: 2 }, error: 42 });
  window.ipc.postMessage(fallback);
  assert.equal(posted, fallback);
  internals.callbacks.get(42)('refus du repli');
  assert.equal(delivered, 'refus du repli');
  assert.equal(window.__E2E_WD_EVENTS__.at(-2).cmd, 'repli');
  assert.equal(window.__E2E_WD_EVENTS__.at(-1).text, 'refus du repli');
});

test('W3C transporte script, arguments et erreurs, évaluation asynchrone refusée lisiblement', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : null; requests.push({ method: req.method, url: req.url, data });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/slow')) { setTimeout(() => res.end(JSON.stringify({ value: true })), 100); return; }
    if (req.url.endsWith('/execute/async')) res.end(JSON.stringify({ value: { ok: false, error: 'refus IPC attendu' } }));
    else if (req.url.endsWith('/execute/sync')) res.end(JSON.stringify({ value: '[]' }));
    else { res.statusCode = 400; res.end(JSON.stringify({ value: { error: 'invalid argument', message: 'capacité invalide' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = new WebDriverClient(`http://127.0.0.1:${server.address().port}`); client.session = 'test';
  const page = new WebDriverPage(client);
  await assert.rejects(page.evaluate(async x => x, ['accent é', 1]), /refus IPC attendu/);
  assert.deepEqual(requests[0].data.args, [['accent é', 1]]);
  assert.match(requests[0].data.script, /arguments.length-1/);
  await assert.rejects(client.command('POST', '/actions', {}), /invalid argument.*capacité invalide/);
  await assert.rejects(client.command('GET', '/slow', undefined, 10), /WebDriver GET.*slow.*10 ms.*timeout/);
});


test('la relève transporte un gros payload IPC comme JSON et restitue le corps intact', async () => {
  const body = { items: Array.from({ length: 10_000 }, (_, i) => ({ i, texte: 'accent é' })) };
  let received;
  const page = new WebDriverPage({
    async execute(fn) {
      const window = { __E2E_WD_EVENTS__: [{ kind: 'request', cmd: 'probe', at: 1, body }] };
      const result = runInNewContext(`(${fn})()`, { window });
      assert.equal(typeof result, 'string', 'le protocole W3C reçoit une valeur opaque');
      assert.equal(window.__E2E_WD_EVENTS__.length, 0);
      return result;
    },
  });
  page.on('request', request => { received = request.postDataJSON(); });
  await page.drain();
  assert.deepEqual(received, body);
});
