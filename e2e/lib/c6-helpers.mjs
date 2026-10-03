// Gestes propres à la migration depuis 0.9.8, au-dessus de `actions.mjs`.
//
// Forme 0.9.8 établie à partir du code de la 0.9.8 (tag `v0.9.8`), pas des
// plans : `git show v0.9.8:src/store/persistentSettings.js` (clés) et
// `git show v0.9.8:src/store/keyboardShortcuts.js` (raccourcis). Entre 0.9.8 et
// la 0.9.9 courante, `treeCopy/treeCut/treePaste/treeDelete` et
// `diagramCopy/diagramCut/diagramPaste/diagramDelete` ont fusionné en une seule
// commande par geste (`selectionCopy/Cut/Paste/Delete`, scope `selection`,
// `migrateSelectionShortcuts` dans `src/store/keyboardShortcuts.js`) : une
// personnalisation de l'arbre gagne si les deux surfaces ont été personnalisées
// différemment, sinon la seule surface personnalisée gagne. C'est la migration
// réelle que ces helpers servent à vérifier ; les autres clés de préférences
// n'ont pas changé de forme depuis la 0.9.8.
import { createHash } from 'node:crypto';
import { clickButton, MODALS } from './actions.mjs';

// Valeur JS de `storyStudioKeyboardShortcuts` telle qu'un profil 0.9.8 pourrait
// l'avoir écrite (forme exacte de `normalizeShortcut` en 0.9.8 : ctrl/shift/alt/
// meta/code/key). Choix couvrant les branches réelles de la migration :
// - treeCopy personnalisé seul (diagramCopy resté par défaut) → selectionCopy
//   doit reprendre le raccourci de l'arbre ;
// - diagramCut personnalisé seul (treeCut resté par défaut) → selectionCut
//   doit reprendre le raccourci du diagramme (seule surface personnalisée) ;
// - treePaste ET diagramPaste personnalisés à des valeurs *différentes* →
//   selectionPaste doit reprendre celle de l'arbre (règle documentée : l'arbre
//   gagne) ;
// - treeDelete/diagramDelete laissés par défaut → selectionDelete reste le
//   défaut, et les 8 anciennes clés disparaissent après migration ;
// - `undo` (scope général, id inchangé depuis 0.9.8) personnalisé de façon non
//   triviale, pour une vérification comportementale simple (persistance pure,
//   pas de migration d'id) ;
// - `tabOptions` personnalisé sur une combinaison qui n'est PAS un ancien
//   défaut connu (Ctrl+3/Ctrl+4) : doit survivre à `migratePanelToggleShortcuts`
//   sans être remplacé par le nouveau défaut Ctrl+Maj+O ;
// - `toggleTree` personnalisé : la même migration ne remplit le défaut que si
//   la clé est *absente* — une personnalisation existante doit être préservée ;
// - une clé d'action inconnue (`legacyPluginAction`, jamais définie par
//   l'app) : doit être silencieusement ignorée (l'app ne construit sa liste
//   qu'à partir des définitions connues) ;
// - une valeur corrompue sur une clé connue (`redo` : chaîne au lieu d'un
//   objet) : doit retomber sur le défaut sans faire planter l'app.
export const LEGACY_SHORTCUTS_098 = {
  treeCopy: { ctrl: true, shift: true, alt: false, meta: false, key: 'c', code: 'KeyC' },
  diagramCut: { ctrl: true, shift: false, alt: true, meta: false, key: 'x', code: 'KeyX' },
  treePaste: { ctrl: true, shift: false, alt: true, meta: false, key: 'v', code: 'KeyV' },
  diagramPaste: { ctrl: true, shift: true, alt: false, meta: false, key: 'v', code: 'KeyV' },
  undo: { ctrl: true, shift: false, alt: true, meta: false, key: 'u', code: 'KeyU' },
  tabOptions: { ctrl: true, shift: false, alt: true, meta: false, key: 'p', code: 'KeyP' },
  toggleTree: { ctrl: true, shift: true, alt: false, meta: false, key: '1', code: 'Digit1' },
  legacyPluginAction: { ctrl: true, shift: false, alt: false, meta: false, key: 'z', code: 'KeyZ' },
  redo: 'not-an-object',
};

// Attendus après migration, par label affiché dans la modale (voir
// `KeyboardShortcutsModal.jsx`) : le libellé du raccourci tel que `formatShortcut`
// le rend. `Ctrl` est affiché littéralement sous Windows (`commandKeyLabel`).
export const EXPECTED_AFTER_MIGRATION = {
  'Copier la sélection': 'Ctrl+Shift+C', // treeCopy -> selectionCopy
  'Couper la sélection': 'Ctrl+Alt+X', // diagramCut (seul personnalisé) -> selectionCut
  'Coller': 'Ctrl+Alt+V', // treePaste gagne sur diagramPaste -> selectionPaste
  'Supprimer la sélection': 'Suppr', // ni tree ni diagram personnalisés -> défaut inchangé
  'Annuler': 'Ctrl+Alt+U', // undo, personnalisation simple sans migration d'id
  'Préférences': 'Ctrl+Alt+P', // tabOptions, pas un ancien défaut -> conservé
  "Afficher/masquer l'arbre": 'Ctrl+Shift+1', // toggleTree, personnalisation préservée
  'Rétablir': 'Ctrl+Shift+Z', // redo, valeur stockée corrompue -> repli sur le défaut
};

// Quelques préférences non liées aux raccourcis, dans leur forme brute
// `localStorage` (chaînes) — mêmes clés qu'en 0.9.8 (`persistentSettings.js`
// n'a ajouté que des clés nouvelles depuis, jamais renommé celles-ci).
// `storyStudioWorkspaceDir` n'y figure JAMAIS : ce chemin reste exclusivement
// celui que `launchApp` impose (garde-fou du vrai workspace), jamais une
// valeur de profil legacy.
export function legacyPreferences098({ theme = 'dark', copyFilesOn = true, useWorkspaceForNewProjects = true } = {}) {
  return {
    storyStudioThemePreference: theme,
    copyImportedFiles: String(copyFilesOn),
    'storyStudio.useWorkspaceForNewProjects': String(useWorkspaceForNewProjects),
    autoSaveEnabled: 'false',
    'storyStudio.autosaveDefaultOnApplied': '1', // choix explicite déjà migré : la bascule one-shot ne doit pas le retoucher
    bottomPanelOpen: 'true',
    bottomPanelTab: 'queue',
    bottomPanelHeight: '412',
    // Réglages d'intégrations fictifs (aucun serveur réel visé) : vérifient
    // seulement que la forme JSON survit et ne fait pas planter l'app.
    xttsSettings: JSON.stringify({ serverUrl: 'http://127.0.0.1:8020', language: 'fr-fr' }),
    sdSettings: JSON.stringify({ serverUrl: 'http://127.0.0.1:8188' }),
  };
}

// Amorce le profil e2e avec une forme 0.9.8 : écriture directe des clés
// `localStorage` puis rechargement, pour que l'app (re)boote en lisant ces
// valeurs — même méthode que `launchApp` pour la clé de workspace
// (`lib/launch.mjs`), documentée ici pour la migration. `raw` porte des paires déjà
// sérialisées (ex. JSON invalide volontaire) prioritaires sur les clés
// construites plus haut.
export async function seedLegacyProfile098(page, { shortcuts = LEGACY_SHORTCUTS_098, preferences = legacyPreferences098(), raw = {} } = {}) {
  const entries = {
    // `launchApp` doit ouvrir une première WebView avant que le parcours puisse
    // amorcer le profil. On retire donc explicitement les clés 0.9.9 que ce
    // premier boot a pu créer, afin que le rechargement parte bien d'une forme
    // 0.9.8 et exerce la migration réelle.
    'storyStudio.editorLayoutMigrationApplied': null,
    'storyStudio.free.bottomPanelOpen': null,
    'storyStudio.free.bottomPanelTab': null,
    'storyStudio.free.bottomPanelHeight': null,
    'storyStudio.advanced.bottomPanelOpen': null,
    'storyStudio.advanced.bottomPanelTab': null,
    'storyStudio.advanced.bottomPanelHeight': null,
    ...preferences,
    ...(shortcuts ? { storyStudioKeyboardShortcuts: JSON.stringify(shortcuts) } : {}),
    ...raw,
  };
  await page.evaluate((kv) => {
    for (const [key, value] of Object.entries(kv)) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }, entries);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  return entries;
}

export async function readLocalStorage(page, keys) {
  return page.evaluate((ks) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])), keys);
}

// Préférences → section Interface → « Modifier » (raccourcis). Nécessite un
// projet actif (le raccourci est gardé par `canOpenPreferences`). `shortcut`
// doit être la combinaison **effective** de `tabOptions` au moment de l'appel
// (le défaut Ctrl+Maj+O seulement si `tabOptions` n'a pas été personnalisé par
// le profil amorcé) : le parcours de migration personnalise justement
// `tabOptions` dans son profil 0.9.8 (voir `LEGACY_SHORTCUTS_098`), donc le
// défaut ne suffit pas après une migration réussie.
export async function openPreferences(page, { timeout = 15_000, shortcut = 'Control+Shift+O' } = {}) {
  await page.keyboard.press(shortcut);
  const modal = page.locator('.opts-modal-box, [class*="opts-screen"]').first();
  await modal.waitFor({ timeout });
}

export async function closePreferences(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

export async function openKeyboardShortcutsModal(page, { timeout = 15_000 } = {}) {
  const row = page.locator('.opts-row').filter({ hasText: 'Raccourcis clavier' }).first();
  await row.waitFor({ timeout });
  await clickButton(row, 'Modifier');
  const modal = page.locator('.keyboard-shortcuts-modal');
  await modal.waitFor({ timeout });
  return modal;
}

export async function closeKeyboardShortcutsModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// Texte du bouton de capture pour l'action affichée sous `label` exact
// (`KeyboardShortcutsModal.jsx`, `.opts-row-label` + `.keyboard-shortcut-capture`).
export async function shortcutCaptureText(page, label) {
  const row = page.locator('.keyboard-shortcut-row').filter({ has: page.locator('.opts-row-label', { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.waitFor({ timeout: 10_000 });
  return (await row.locator('.keyboard-shortcut-capture').innerText()).trim();
}

// ── Écran figé (projets réels) ───────────────────────────────────────────────
//
// Une attente qui n'aboutit pas ne doit pas consommer ses 3 ou 10 minutes de
// plafond quand l'app ne fait plus rien. « L'écran ne bouge plus » se constate
// sans spec : ni la capture de la fenêtre (empreinte des pixels), ni le
// journal IPC n'ont changé depuis `idleMs`. Une animation, une progression de
// la file de rendu ou une commande IPC suffisent à relancer le délai.

export class ScreenStalledError extends Error {
  constructor(label, detail) {
    super(`écran figé pendant « ${label} » depuis ${Math.round(detail.idleMs / 1000)} s`
      + (detail.screen?.modals?.length ? ` — boîte visible : ${detail.screen.modals[0].split('\n')[0]}` : ''));
    this.name = 'ScreenStalledError';
    this.detail = detail;
  }
}

// Ce qui est à l'écran, pour le message d'échec : les boîtes ouvertes (texte
// tronqué) et la présence de « Médias introuvables ».
export async function describeScreen(page) {
  const modals = page.locator(MODALS);
  const count = await modals.count().catch(() => 0);
  const texts = [];
  for (let index = 0; index < Math.min(count, 3); index += 1) {
    texts.push((await modals.nth(index).innerText().catch(() => '')).trim().slice(0, 300));
  }
  const missingMedia = await page.locator('[aria-label="Médias introuvables"]').count().catch(() => 0);
  return { modals: texts.filter(Boolean), missingMediaModal: missingMedia > 0 };
}

// Exécute `action()` et lève `ScreenStalledError` dès que l'écran et l'IPC
// restent immobiles `idleMs`. L'action abandonnée n'est pas annulée : l'appelant
// relance l'app avant de continuer.
export async function withStallGuard(page, events, label, action, { idleMs = 60_000, pollMs = 5_000 } = {}) {
  let finished = false;
  const running = action().finally(() => { finished = true; });
  running.catch(() => {});
  const watcher = (async () => {
    let lastHash = null;
    let lastIpc = -1;
    let since = Date.now();
    while (!finished) {
      await new Promise((done) => setTimeout(done, pollMs));
      if (finished) return null;
      const shot = await page.screenshot({ timeout: 10_000 }).catch(() => null);
      const hash = shot ? createHash('sha1').update(shot).digest('hex') : null;
      const ipcCount = events.ipc().length;
      if (hash !== lastHash || ipcCount !== lastIpc) {
        lastHash = hash;
        lastIpc = ipcCount;
        since = Date.now();
      } else if (Date.now() - since >= idleMs) {
        return { idleMs: Date.now() - since, screen: await describeScreen(page) };
      }
    }
    return null;
  })();
  const stalled = await Promise.race([running.then(() => null, () => null), watcher]);
  if (stalled) throw new ScreenStalledError(label, stalled);
  finished = true;
  return running;
}
