// Configuration locale du banc e2e.
//
// Aucun chemin personnel ni nom de pack réel n'est versionné : les chemins
// propres au poste (corpus, STUdio, JDK) viennent de `e2e/local.config.json`,
// ignoré par git, ou de variables d'environnement `SS_E2E_*`. Voir
// `local.config.example.json`.
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = resolve(E2E_DIR, '..');

// Identifiant de la config `src-tauri/tauri.e2e.conf.json` : profil WebView2,
// logs, sessions et cache isolés de l'usage réel.
export const APP_IDENTIFIER = 'com.hugs11.story-studio.e2e';
export const CDP_URL = 'http://127.0.0.1:9222';
export const DEV_ORIGIN = 'http://127.0.0.1:1420';

function readLocalConfig() {
  const file = join(E2E_DIR, 'local.config.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

const local = readLocalConfig();

function pick(envName, key, fallback = null) {
  return process.env[envName] || local[key] || fallback;
}

function reportDir(envName, key, fallback) {
  return resolve(REPO_DIR, pick(envName, key, join(E2E_DIR, 'artifacts', fallback)));
}

export const config = {
  tauriDriver: pick('SS_E2E_TAURI_DRIVER', 'tauriDriver'),
  webkitWebDriver: pick('SS_E2E_WEBKIT_WEB_DRIVER', 'webkitWebDriver'),
  // Dossier racine du corpus d'archives (lecture seule, jamais modifié).
  corpusDir: pick('SS_E2E_CORPUS_DIR', 'corpusDir'),
  // Installation STUdio web-ui (dossier contenant le jar et `lib/`).
  studioDir: pick('SS_E2E_STUDIO_DIR', 'studioDir'),
  // JDK utilisé pour compiler et lancer le harnais STUdio.
  javaHome: pick('SS_E2E_JAVA_HOME', 'javaHome', process.env.JAVA_HOME || null),
  // Dossier de l'oracle Lunii.QT (clone `Lunii.QT/` + `venv/`, voir
  // `luniiqt/setup.mjs`). Défaut : `<workDir>/luniiqt`.
  luniiqtDir: pick('SS_E2E_LUNIIQT_DIR', 'luniiqtDir'),
  // Racine des artefacts d'exécution (hors dépôt).
  workDir: pick('SS_E2E_WORK_DIR', 'workDir', join(tmpdir(), 'ss-e2e')),
  // Manifeste du corpus réduit, configuré explicitement sur chaque poste.
  reducedCorpusFile: pick('SS_E2E_REDUCED_CORPUS', 'reducedCorpusFile'),
  // Rapports du corpus standard ou complet, des suspects, de parité et de mesures.
  c3aReportDir: reportDir('SS_E2E_C3A_REPORT_DIR', 'c3aReportDir', 'corpus'),
  c3cReportDir: reportDir('SS_E2E_C3A_REPORT_DIR', 'c3cReportDir', 'corpus-complet'),
  c3aSuspectsReportDir: reportDir('SS_E2E_C3A_SUSPECTS_REPORT_DIR', 'c3aSuspectsReportDir', 'suspects'),
  c3bReportDir: reportDir('SS_E2E_C3B_REPORT_DIR', 'c3bReportDir', 'parity'),
  entrySourceReportDir: reportDir('SS_E2E_ENTRY_SOURCE_REPORT_DIR', 'entrySourceReportDir', 'entry-source'),
  // Installation XTTS locale (lecture seule, jamais modifiée) : dossier
  // contenant `server.py`, `venv/` et `models/`.
  xttsDir: pick('SS_E2E_XTTS_DIR', 'xttsDir'),
  // Installation ComfyUI/Stable Diffusion locale (lecture seule) : dossier
  // racine contenant `start_comfyui.bat` et le sous-dossier `workflows/`.
  comfyuiDir: pick('SS_E2E_COMFYUI_DIR', 'comfyuiDir'),
};

// Liste de noms tirée d'une variable `SS_E2E_*` (séparée par des virgules) ou
// d'un tableau de `local.config.json` : les noms de projets personnels ne sont
// jamais versionnés, il n'y a donc pas de valeur par défaut.
export function localList(envName, key) {
  const value = process.env[envName] || local[key] || [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map((s) => String(s).trim()).filter(Boolean);
}

export function appDataDirs() {
  if (process.platform === 'linux') return {
    local: join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), APP_IDENTIFIER),
    roaming: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP_IDENTIFIER),
    cache: join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), APP_IDENTIFIER),
  };
  const localAppData = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  return {
    local: localAppData ? join(localAppData, APP_IDENTIFIER) : null,
    roaming: roaming ? join(roaming, APP_IDENTIFIER) : null,
  };
}

export function requireConfig(key) {
  const value = config[key];
  if (!value) {
    throw new Error(`Configuration e2e manquante : « ${key} ». Renseigner e2e/local.config.json `
      + '(voir local.config.example.json) ou la variable SS_E2E_* correspondante.');
  }
  return value;
}
