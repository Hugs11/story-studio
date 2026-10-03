import { writeFileSync } from 'node:fs';
import { pattern, resolveElements } from './selectors.mjs';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const sleep = ms => new Promise(done => setTimeout(done, ms));

class Locator {
  constructor(page, chain = []) { this.page = page; this.chain = chain; }
  extend(step) { return new Locator(this.page, [...this.chain, step]); }
  locator(selector, options = {}) {
    const result = this.extend({ kind: 'css', selector });
    return options.hasText === undefined && !options.has ? result : result.filter(options);
  }
  getByRole(role, { name, exact = false } = {}) {
    if (!['button', 'menuitem', 'dialog', 'alertdialog'].includes(role)) throw new Error(`Rôle e2e non couvert : ${role}`);
    return this.extend({ kind: 'role', role, name: name === undefined ? null : pattern(name), exact });
  }
  getByText(text, { exact = false } = {}) { return this.extend({ kind: 'text', text: pattern(text), exact }); }
  filter({ hasText, has } = {}) {
    return this.extend({ kind: 'filter', text: hasText === undefined ? null : pattern(hasText), has: has?.chain });
  }
  first() { return this.nth(0); }
  nth(index) { if (index < 0) throw new Error('nth négatif non couvert'); return this.extend({ kind: 'nth', index }); }
  async elements(timeout) { return this.page.client.execute(resolveElements.toString(), [this.chain], false, timeout); }
  async count() { await this.page.drain(); return (await this.elements()).length; }
  async find({ timeout = 30_000, state = 'visible', active = false } = {}) {
    const deadline = Date.now() + timeout;
    do {
      const remaining = () => Math.max(1, deadline - Date.now());
      await this.page.drain(remaining());
      const elements = await this.elements(remaining());
      if (elements.length > 1) throw new Error(`Sélecteur e2e ambigu (${elements.length}) : ${JSON.stringify(this.chain)}`);
      const el = elements[0];
      const shown = el && await this.page.client.execute(e => {
        const s = getComputedStyle(e);
        return s.visibility !== 'hidden' && s.display !== 'none' && !!e.getClientRects().length;
      }, [el], false, remaining());
      if (state === 'hidden' && !shown || state === 'detached' && !el) return null;
      if (el && (state === 'attached' || state === 'visible' && shown)) {
        const disabled = active && await this.page.client.execute(e => e.matches(':disabled') || e.getAttribute('aria-disabled') === 'true', [el], false, remaining());
        if (!disabled) return el;
      }
      await sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`Délai e2e (${state}) : ${JSON.stringify(this.chain)}`);
  }
  async waitFor(options) { await this.find(options); }
  async click(options = {}) {
    const deadline = Date.now() + (options.timeout ?? 30_000);
    do {
      const el = await this.find({ timeout: Math.max(1, deadline - Date.now()), active: true });
      try { await this.page.client.command('POST', `/element/${el[ELEMENT]}/click`, {}); await this.page.drain(); return; }
      catch (error) {
        if (!/stale element|element click intercepted|element not interactable/.test(error.message)) throw error;
        if (Date.now() >= deadline) throw error;
        await sleep(100);
      }
    } while (Date.now() < deadline);
  }
  async hover() {
    const el = await this.find();
    await this.page.client.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 100, origin: el, x: 0, y: 0 }] }] });
  }
  async innerText() { return this.page.client.execute(e => e.innerText, [await this.find({ state: 'attached' })]); }
  async getAttribute(name) { return this.page.client.execute((e, n) => e.getAttribute(n), [await this.find({ state: 'attached' }), name]); }
  async isDisabled() { return this.page.client.execute(e => e.matches(':disabled') || e.getAttribute('aria-disabled') === 'true', [await this.find({ state: 'attached' })]); }
  async boundingBox() { return this.page.client.execute(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, [await this.find()]); }
}

export class WebDriverPage extends Locator {
  constructor(client) {
    super(null); this.page = this; this.client = client; this.listeners = new Map(); this.currentUrl = '';
    this.keyboard = { press: async key => {
      const keys = { Control: '\uE009', Shift: '\uE008', Alt: '\uE00A', Meta: '\uE03D', Escape: '\uE00C', Enter: '\uE007', Tab: '\uE004' };
      const values = key.split('+').map(k => keys[k] ?? k);
      if (values.some(k => [...k].length !== 1)) throw new Error(`Touche e2e non couverte : ${key}`);
      await client.command('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [
        ...values.map(value => ({ type: 'keyDown', value })), ...values.slice().reverse().map(value => ({ type: 'keyUp', value })),
      ] }] });
      await this.drain();
    } };
  }
  on(name, handler) { if (!['console', 'pageerror', 'request', 'response'].includes(name)) throw new Error(`Événement non couvert : ${name}`); this.listeners.set(name, [...(this.listeners.get(name) || []), handler]); }
  async drain(timeout) {
    if (this.draining) return;
    this.draining = true;
    try {
      // Cloner de gros payloads IPC objet par objet via W3C monopolise WebKit.
      // Sérialiser dans la page et transporter une seule chaîne JSON conserve
      // les mêmes données, en évitant ce parcours récursif du pilote natif.
      const raw = await this.client.execute(() => JSON.stringify(window.__E2E_WD_EVENTS__?.splice(0) ?? []), [], false, timeout);
      const entries = JSON.parse(raw ?? '[]');
      for (const entry of entries) {
        const url = () => `http://ipc.localhost/${encodeURIComponent(entry.cmd)}`;
        const event = entry.kind === 'console' ? { type: () => entry.type, text: () => entry.text }
          : entry.kind === 'pageerror' ? new Error(entry.text)
          : entry.kind === 'request' ? { url, postDataJSON: () => entry.body, postData: () => JSON.stringify(entry.body) }
          : { url, ok: () => false, status: () => entry.status, text: async () => entry.text };
        for (const listener of this.listeners.get(entry.kind) || []) await listener(event);
      }
    } finally { this.draining = false; }
  }
  async evaluate(fn, arg) {
    const result = await this.client.execute(fn.toString(), arg === undefined ? [] : [arg], true);
    await this.drain();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async waitForTimeout(ms) { await sleep(ms); await this.drain(); }
  async waitForLoadState() {
    const deadline = Date.now() + 60_000;
    while (await this.client.execute(() => document.readyState === 'loading')) {
      if (Date.now() > deadline) throw new Error('Document non chargé');
      await sleep(100);
    }
    this.currentUrl = await this.client.command('GET', '/url');
    await this.drain();
  }
  async reload() { await this.drain(); await this.client.command('POST', '/refresh', {}); await this.waitForLoadState(); }
  url() { return this.currentUrl; }
  async screenshot({ path } = {}) {
    await this.drain(); const bytes = Buffer.from(await this.client.command('GET', '/screenshot'), 'base64');
    if (path) writeFileSync(path, bytes); return bytes;
  }
}
