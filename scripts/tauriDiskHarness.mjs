// Banc d'essai disque de `projectIO.js`.
//
// Ce que ce harnais double, et rien d'autre : la WebView, les dialogues de
// fichiers et le transport IPC. Les commandes `plugin:fs|*` sont servies par le
// vrai système de fichiers dans un répertoire temporaire, donc les fichiers
// écrits sont de vrais fichiers, relus tels quels par `node:fs`. Le codec, les
// mappings de chemins et les fonctions de sauvegarde restent ceux de production.
//
// Toute commande non déclarée échoue explicitement : un test qui prétend qu'un
// refus survient avant la validation Rust le prouve, au lieu de recevoir une
// valeur inventée.

import { register } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

register('./nodeSourceResolver.mjs', import.meta.url);

const storage = new Map();
const localStorageDouble = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};
globalThis.localStorage = localStorageDouble;
globalThis.window = { crypto: globalThis.crypto, localStorage: localStorageDouble };
window.__TAURI_INTERNALS__ = {};

const decoder = new TextDecoder();

// Les chemins **rendus aux tests** sont normalisés en `/`. C'est la forme que la
// production rend elle-même (`projectMediaPaths.js` la documente), la seule qui
// permette d'écrire une attente une seule fois pour Linux, macOS et Windows, et
// une forme que `node:fs` accepte sur les trois. Les doublures Tauri, elles,
// gardent le séparateur du système : `plugin:path|join` rend des antislashs sous
// Windows comme le vrai greffon, sinon le banc cesserait d'éprouver ce que la
// production reçoit réellement là-bas.
function handOut(value) {
  return value.replace(/\\/g, '/');
}

function firstPath(args) {
  return args?.path ?? args?.toPath ?? args?.newPath ?? args?.fromPath ?? args?.oldPath ?? null;
}

export async function createDiskHarness({ commands = {} } = {}) {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'story-studio-disk-'));
  const documents = nodePath.join(root, 'documents');
  const workspace = nodePath.join(root, 'workspace');
  await fs.mkdir(documents, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });

  const calls = [];
  const faults = [];
  const dialogs = { save: [], open: [] };

  const failureFor = (cmd, target) => {
    const fault = faults.find((entry) => entry.cmd === cmd
      && entry.remaining > 0
      && (entry.match == null || String(target ?? '').includes(entry.match)));
    if (!fault) return null;
    fault.remaining -= 1;
    return fault.message;
  };

  const fsCommands = {
    'plugin:fs|exists': async ({ path }) => fs.access(path).then(() => true, () => false),
    'plugin:fs|mkdir': async ({ path, options }) => {
      await fs.mkdir(path, { recursive: !!options?.recursive });
    },
    'plugin:fs|read_text_file': async ({ path }) => Array.from(await fs.readFile(path)),
    'plugin:fs|read_file': async ({ path }) => Array.from(await fs.readFile(path)),
    'plugin:fs|copy_file': async ({ fromPath, toPath }) => {
      await fs.copyFile(fromPath, toPath);
    },
    'plugin:fs|rename': async ({ oldPath, newPath }) => {
      await fs.rename(oldPath, newPath);
    },
    'plugin:fs|remove': async ({ path, options }) => {
      await fs.rm(path, { recursive: !!options?.recursive });
    },
    'plugin:fs|read_dir': async ({ path }) => {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymlink: entry.isSymbolicLink(),
      }));
    },
  };

  const pathCommands = {
    'plugin:path|join': ({ paths }) => nodePath.join(...paths),
    'plugin:path|resolve_directory': ({ directory }) => {
      if (directory !== 6) throw new Error(`Répertoire de base non doublé : ${directory}`);
      return documents;
    },
  };

  const dialogCommands = {
    'plugin:dialog|save': () => {
      if (dialogs.save.length === 0) throw new Error('Dialogue « Enregistrer » inattendu');
      return dialogs.save.shift();
    },
    'plugin:dialog|open': () => {
      if (dialogs.open.length === 0) throw new Error('Dialogue « Ouvrir » inattendu');
      return dialogs.open.shift();
    },
  };

  window.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
    if (cmd === 'plugin:fs|write_text_file') {
      const path = decodeURIComponent(options?.headers?.path ?? '');
      calls.push({ cmd, target: path });
      const failure = failureFor(cmd, path);
      if (failure) throw new Error(failure);
      await fs.writeFile(path, decoder.decode(Uint8Array.from(args)));
      return null;
    }
    const target = firstPath(args);
    calls.push({ cmd, target });
    const failure = failureFor(cmd, target);
    if (failure) throw new Error(failure);
    const handler = commands[cmd] ?? fsCommands[cmd] ?? pathCommands[cmd] ?? dialogCommands[cmd];
    if (!handler) throw new Error(`Commande non doublée : ${cmd}`);
    return handler(args, options);
  };

  localStorageDouble.clear();

  return {
    root: handOut(root),
    documents: handOut(documents),
    workspace: handOut(workspace),
    calls,
    dir: (...parts) => handOut(nodePath.join(root, ...parts)),
    settings: localStorageDouble,
    /** Prochaine réponse du dialogue « Enregistrer sous… » (`null` = annulation). */
    answerSave: (path) => dialogs.save.push(path),
    answerOpen: (path) => dialogs.open.push(path),
    /** Panne injectée sur une commande IPC, filtrée par fragment de chemin. */
    injectFailure: ({ cmd, match = null, message = 'panne injectée', times = 1 }) => {
      faults.push({ cmd, match, message, remaining: times });
    },
    countCalls: (cmd) => calls.filter((call) => call.cmd === cmd).length,
    async mkdirp(...parts) {
      const target = nodePath.join(root, ...parts);
      await fs.mkdir(target, { recursive: true });
      return handOut(target);
    },
    async writeFile(relative, contents) {
      const target = nodePath.join(root, relative);
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
      return handOut(target);
    },
    readFile: (path) => fs.readFile(path, 'utf8'),
    exists: (path) => fs.access(path).then(() => true, () => false),
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  };
}
