// Lancement de l'application réelle et connexion CDP à sa WebView2.
//
// `tauri dev` avec `src-tauri/tauri.e2e.conf.json` (identifiant isolé, port de
// débogage 9222) et `VITE_E2E=1` (shim des boîtes de dialogue). Une seule
// instance à la fois : les ports 1420 et 9222 sont fixes.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { APP_IDENTIFIER, CDP_URL, DEV_ORIGIN, REPO_DIR, appDataDirs } from './config.mjs';
import { attachCollectors } from './collect.mjs';
import { launchLinux } from './webdriver/launch.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Clé `KEYS.WORKSPACE_DIR` de `src/store/persistentSettings.js`, et workspace
// par défaut de l'app (`projectIO.js`) : jamais écrit par un test.
const WORKSPACE_KEY = 'storyStudioWorkspaceDir';
const REAL_WORKSPACE = join(homedir(), 'Documents', 'story-studio');

async function cdpReady() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function devServerUp() {
  try {
    const response = await fetch(DEV_ORIGIN);
    return response.ok;
  } catch {
    return false;
  }
}

// Efface le profil e2e (WebView2, logs, sessions, cache). Garde-fou : seul un
// dossier portant l'identifiant e2e peut être supprimé.
export function resetAppProfile() {
  const dirs = appDataDirs();
  for (const dir of [dirs.local, dirs.roaming]) {
    if (!dir || !dir.endsWith(APP_IDENTIFIER)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* déjà terminé */ }
  }
}

// Filet de sécurité observé en pratique : `cargo run` (lancé par `tauri dev`)
// laisse parfois échapper `story-studio.exe` du sous-arbre tué par
// `killTree` (le process persiste bien après la fermeture des ports 1420/9222
// et fait ensuite échouer `resetAppProfile` avec EPERM, le profil restant
// verrouillé). On balaie donc, en plus, tout `story-studio.exe` dont
// l'exécutable est sous ce dépôt (jamais l'application installée de l'auteur,
// ailleurs sur le disque).
function killOrphanedAppProcesses() {
  if (process.platform !== 'win32') return;
  const root = REPO_DIR.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='story-studio.exe'" | `
    + `Where-Object { $_.ExecutablePath -like '${root}*' } | `
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}

/**
 * Démarre l'application et renvoie `{ browser, page, events, stop, runDir }`.
 * `fresh` efface d'abord le profil e2e ; `timeoutMs` couvre la première
 * compilation Rust avec l'identifiant e2e.
 *
 * `exePath` (fumée sur le build release) : au lieu de `tauri dev`,
 * lance directement cet exécutable déjà construit avec l'identifiant `.e2e`
 * (le port CDP 9222 vient alors de `additionalBrowserArgs`, figé dans le
 * binaire à la compilation). `env`, si fourni, remplace entièrement
 * `process.env` pour ce lancement (ex. `PATH` réduit, pour prouver que
 * FFmpeg/7-Zip ne sont pas résolus via le `PATH`) — sans lui, hérite de
 * l'environnement courant. `VITE_E2E` ne s'applique pas à un exécutable déjà
 * compilé (le shim de dialogue est une substitution Vite en mode `serve`).
 */
async function dismissReleaseNotes(page) {
  const notes = page.locator('.release-notes-box');
  const visible = await notes.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  if (!visible) return;
  await notes.getByRole('button', { name: 'C’est parti !', exact: true }).click();
  await notes.waitFor({ state: 'hidden', timeout: 5000 });
}

export async function launchApp({ runDir, fresh = false, workspaceDir = null, timeoutMs = 15 * 60_000, exePath = null, env = null } = {}) {
  if (process.platform === 'linux') {
    const app = await launchLinux({ runDir, fresh, workspaceDir, timeoutMs, exePath, env });
    await dismissReleaseNotes(app.page);
    return app;
  }
  const startedAt = Date.now();
  if (await cdpReady() || await devServerUp()) {
    throw new Error('Une instance (port 9222 ou 1420) tourne déjà : la fermer avant de lancer.');
  }
  killOrphanedAppProcesses(); // avant tout : un profil verrouillé par un orphelin ferait échouer resetAppProfile
  if (fresh) resetAppProfile();
  mkdirSync(runDir, { recursive: true });
  const appLog = createWriteStream(join(runDir, 'tauri-dev.log'));
  const child = exePath
    ? spawn(exePath, [], {
      cwd: REPO_DIR,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn('npm', ['run', 'tauri', '--', 'dev', '--config', 'src-tauri/tauri.e2e.conf.json'], {
      cwd: REPO_DIR,
      env: { ...process.env, VITE_E2E: '1' },
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  child.stdout.pipe(appLog);
  child.stderr.pipe(appLog);
  let exited = null;
  child.on('exit', code => { exited = code; });

  const stop = async () => {
    killTree(child.pid);
    // Attendre la libération des ports, pour qu'une relance immédiate passe.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await cdpReady() || await devServerUp())) await sleep(500);
    killOrphanedAppProcesses(); // filet : un `story-studio.exe` peut survivre à killTree (cf. plus haut)
  };

  const started = Date.now();
  while (!(await cdpReady())) {
    if (exited !== null) {
      throw new Error(`tauri dev s'est arrêté (code ${exited}) avant l'ouverture de la fenêtre : voir ${join(runDir, 'tauri-dev.log')}`);
    }
    if (Date.now() - started > timeoutMs) {
      await stop();
      throw new Error('La WebView2 n\'a pas ouvert son port CDP à temps.');
    }
    await sleep(1000);
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await findAppPage(browser);
  const events = attachCollectors(page, runDir);
  await page.waitForLoadState('domcontentloaded');

  // Workspace isolé : sans cette clé, l'app écrit ses copies de médias et ses
  // sauvegardes automatiques dans le vrai `Documents\story-studio`.
  const workspace = workspaceDir ?? join(runDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  // Installer la préférence avant les modules de l'app : une initialisation
  // asynchrone du premier document peut sinon réécrire le workspace par défaut.
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [WORKSPACE_KEY, workspace]);
  const current = await page.evaluate(key => localStorage.getItem(key), WORKSPACE_KEY);
  if (current !== workspace) {
    const session = await page.context().newCDPSession(page);
    // Après remise à zéro du profil, ne pas relire un cache WebView2 périmé.
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  }

  // Le profil de test acquitte aussi les nouveautés par leur bouton réel.
  await dismissReleaseNotes(page);

  return {
    browser,
    page,
    events,
    runDir,
    workspace,
    // `graceful: true` : ferme par la même voie qu'un clic sur la croix de la
    // fenêtre (`Window.close()`, IPC `plugin:window|close`), qui déclenche
    // `tauri://close-requested` et donc `useWindowCloseGuard` (garde
    // d'enregistrement, `beforeClose`, `win.destroy()`) — au lieu d'un
    // `taskkill /F` immédiat. Sert à distinguer un artefact d'arrêt brutal
    // (écriture localStorage/WebView2 non vidée avant la mort du process)
    // d'un vrai comportement applicatif. Se rabat sur `killTree` si la
    // fenêtre ne s'est pas fermée d'elle-même dans le délai.
    async stop({ graceful = false } = {}) {
      events.flush();
      let closedGracefully = false;
      if (graceful) {
        try {
          await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }));
        } catch { /* la page a pu déjà se fermer avant la fin de l'appel */ }
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && (await cdpReady())) await sleep(300);
        closedGracefully = !(await cdpReady());
      }
      await browser.close().catch(() => {});
      await stop();
      const polluted = writtenSince(REAL_WORKSPACE, startedAt);
      if (polluted.length) {
        writeFileSync(join(runDir, 'POLLUTION-workspace-reel.txt'), polluted.join('\n'));
        console.error(`ATTENTION : ${polluted.length} fichier(s) écrit(s) dans le vrai workspace ${REAL_WORKSPACE} — voir POLLUTION-workspace-reel.txt`);
      }
      return { polluted, closedGracefully: graceful ? closedGracefully : null };
    },
  };
}

// Fichiers modifiés depuis `since` dans le workspace réel (garde-fou).
function writtenSince(dir, since) {
  const found = [];
  const walk = current => {
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).mtimeMs >= since) found.push(path);
    }
  };
  walk(dir);
  return found;
}

// `tauri dev` sert le frontend depuis `DEV_ORIGIN` (serveur Vite). Un
// exécutable déjà construit (fumée release) le sert depuis le pseudo-
// hôte de production de Tauri (`http://tauri.localhost/`, jamais un vrai
// réseau) : les deux formes sont acceptées ici.
function isAppPageUrl(url) {
  return url.startsWith(DEV_ORIGIN) || /^https?:\/\/([^/]*\.)?tauri\.localhost\b/.test(url);
}

async function findAppPage(browser, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const context of browser.contexts()) {
      const page = context.pages().find(candidate => isAppPageUrl(candidate.url()));
      if (page) return page;
    }
    await sleep(500);
  }
  throw new Error(`Aucune page applicative (${DEV_ORIGIN} ou tauri.localhost) dans la WebView2.`);
}
