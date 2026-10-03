import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { APP_IDENTIFIER, DEV_ORIGIN, REPO_DIR, requireConfig, appDataDirs } from '../config.mjs';
import { attachCollectors } from '../collect.mjs';
import { WebDriverClient } from './client.mjs';
import { WebDriverPage } from './page.mjs';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const origin = 'http://127.0.0.1:4444';

export async function launchLinux({ runDir, fresh = false, workspaceDir = null, timeoutMs = 15 * 60_000, exePath = null, env = null }) {
  const startedAt = Date.now();
  if (exePath) throw new Error('Le pilote Linux couvre le frontend e2e servi par Vite, pas les exécutables de release.');
  for (const url of [DEV_ORIGIN, `${origin}/status`]) {
    const busy = await fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (busy) throw new Error(`Une instance utilise déjà ${url}`);
  }
  const driver = requireConfig('tauriDriver');
  const native = requireConfig('webkitWebDriver');
  for (const path of [driver, native]) if (!statSync(path).isFile()) throw new Error(`Pilote non régulier : ${path}`);
  mkdirSync(runDir, { recursive: true });
  const workspace = workspaceDir ?? join(runDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  if (fresh) {
    for (const dir of Object.values(appDataDirs())) {
      if (dir?.endsWith(APP_IDENTIFIER)) rmSync(dir, { recursive: true, force: true });
    }
  }
  const children = [];
  let stopped = false;
  const logs = [];
  const start = (command, args, options, name) => {
    const log = createWriteStream(join(runDir, name), { flags: 'a' }); logs.push(log);
    const child = spawn(command, args, { cwd: REPO_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.pipe(log); child.stderr.pipe(log); children.push(child); return child;
  };
  const client = new WebDriverClient(origin, timeoutMs);
  let page, events, timer;
  const stop = async () => {
    if (stopped) return { polluted: [], closedGracefully: null };
    stopped = true;
    clearInterval(timer);
    if (page) await page.drain(5000).catch(() => {});
    events?.flush();
    if (client.session) await client.command('DELETE', '', undefined, 10_000).catch(() => {});
    for (const child of children.reverse()) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* déjà fermé */ } }
    for (const log of logs) log.end();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const busy = await Promise.all([DEV_ORIGIN, `${origin}/status`].map(url => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)));
      if (busy.every(v => !v)) {
        const polluted = [];
        const walk = dir => {
          let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile() && statSync(path).mtimeMs >= startedAt) polluted.push(path);
          }
        };
        walk(join(homedir(), 'Documents', 'story-studio'));
        if (polluted.length) {
          writeFileSync(join(runDir, 'POLLUTION-workspace-reel.txt'), polluted.join('\n'));
          console.error(`ATTENTION : ${polluted.length} fichier(s) écrit(s) dans le vrai workspace`);
        }
        return { polluted, closedGracefully: null };
      }
      await sleep(100);
    }
    throw new Error('Ports Vite/WebDriver encore occupés après arrêt');
  };
  try {
    if (!exePath) {
      const patch = JSON.parse(readFileSync(join(REPO_DIR, 'src-tauri/tauri.e2e.conf.json'), 'utf8'));
      // cargo debug conserve devUrl ; même surcharge e2e que tauri dev Windows.
      const build = start('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], {
        env: { ...process.env, TAURI_CONFIG: JSON.stringify(patch) },
      }, 'webdriver-build.log');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Délai de compilation e2e dépassé')), timeoutMs);
        build.once('error', error => { clearTimeout(timeout); reject(error); });
        build.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Compilation e2e : code ${code}`)); });
      });
      start('npm', ['run', 'dev', '--', '--config', 'e2e/vite.webdriver.config.mjs'], {
        env: { ...process.env, VITE_E2E: '1', SS_E2E_WORKSPACE: workspace },
      }, 'webdriver-vite.log');
      const deadline = Date.now() + 30_000;
      while (!await fetch(DEV_ORIGIN).then(r => r.ok, () => false)) {
        if (Date.now() > deadline) throw new Error('Vite e2e indisponible');
        await sleep(200);
      }
    }
    start('dbus-run-session', ['--', driver, '--port', '4444', '--native-port', '4445', '--native-driver', native], {
      env: env ?? process.env,
    }, 'tauri-dev.log');
    const deadline = Date.now() + 30_000;
    while (!await client.request('GET', '/status').then(v => v.ready, () => false)) {
      if (Date.now() > deadline) throw new Error('tauri-driver indisponible');
      await sleep(200);
    }
    const session = await client.request('POST', '/session', { capabilities: { alwaysMatch: {
      'tauri:options': { application: exePath ?? join(REPO_DIR, 'src-tauri/target/debug/story-studio') },
    } } });
    client.session = session.sessionId;
    writeFileSync(join(runDir, 'webdriver-session.json'), JSON.stringify({ origin, sessionId: client.session }));
    await client.command('POST', '/timeouts', { script: timeoutMs, pageLoad: 60_000, implicit: 0 });
    page = new WebDriverPage(client);
    events = attachCollectors(page, runDir);
    // Le collecteur partagé ne termine pas son lot par un saut de ligne.
    // Sous Linux, les relances partagent runDir : séparer leurs lots JSONL.
    const flush = events.flush;
    events.flush = () => { flush(); appendFileSync(join(runDir, 'ipc.jsonl'), '\n'); };
    await page.waitForLoadState('domcontentloaded');
    if (!exePath && !await page.evaluate(() => window.__E2E_WD_COLLECTOR_READY__)) throw new Error('Collecteur absent avant le frontend');
    timer = setInterval(() => page.drain().catch(() => {}), 200);
    return { page, events, runDir, workspace, browser: { close: stop }, stop };
  } catch (error) { await stop(); throw error; }
}
