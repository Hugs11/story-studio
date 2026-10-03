// Shim de `@tauri-apps/plugin-dialog` pour les parcours e2e.
//
// Substitué au plugin par `vite.config.js` seulement en `serve` et sous
// `VITE_E2E=1` : il n'existe dans aucun build. Les boîtes natives ne peuvent
// pas être interceptées à chaud (`__TAURI_INTERNALS__` n'est pas réinscriptible),
// d'où la substitution au moment de la résolution des modules.
//
// Le test pose ses réponses dans `window.__E2E_DIALOGS__` : un tableau
// d'objets `{ kind: 'open' | 'save' | 'ask' | 'confirm' | 'message' | 'any', value }`,
// consommés dans l'ordre. Chaque appel est journalisé dans
// `window.__E2E_DIALOG_LOG__` avec ses options (titre, chemin par défaut,
// filtres), ce qui permet d'affirmer quel dossier l'application propose.
//
// File vide : en mode `strict` (défaut), l'appel est annulé (`null` / `false`)
// et marqué `unanswered` dans le journal, pour qu'un agent ne reste jamais
// bloqué derrière une boîte native. En mode `native`
// (`window.__E2E_DIALOG_MODE__ = 'native'`), la vraie boîte s'ouvre.
import * as real from 'e2e-real-plugin-dialog';

export * from 'e2e-real-plugin-dialog';

const CANCELLED = { open: null, save: null, ask: false, confirm: false, message: undefined };

function queue() {
  if (!Array.isArray(window.__E2E_DIALOGS__)) window.__E2E_DIALOGS__ = [];
  return window.__E2E_DIALOGS__;
}

function journal() {
  if (!Array.isArray(window.__E2E_DIALOG_LOG__)) window.__E2E_DIALOG_LOG__ = [];
  return window.__E2E_DIALOG_LOG__;
}

function answer(kind, args) {
  const pending = queue();
  const index = pending.findIndex(entry => entry.kind === kind || entry.kind === 'any');
  const entry = { kind, args: JSON.parse(JSON.stringify(args ?? null)), at: Date.now() };
  journal().push(entry);
  if (index >= 0) {
    const [scripted] = pending.splice(index, 1);
    entry.answered = scripted.value;
    return Promise.resolve(scripted.value);
  }
  if (window.__E2E_DIALOG_MODE__ === 'native') {
    entry.native = true;
    return real[kind](...args);
  }
  entry.unanswered = true;
  return Promise.resolve(CANCELLED[kind]);
}

export const open = (...args) => answer('open', args);
export const save = (...args) => answer('save', args);
export const ask = (...args) => answer('ask', args);
export const confirm = (...args) => answer('confirm', args);
export const message = (...args) => answer('message', args);
