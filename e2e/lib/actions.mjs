// Gestes d'auteur réutilisables, vérifiés sur l'app réelle.
//
// Sélecteurs : rôles et textes visibles. Certains conteneurs portent
// `aria-hidden`, et les boîtes de l'app sont souvent des `alertdialog` :
// `clickButton` retombe donc sur le texte visible.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dropFiles } from './drop.mjs';
import { answerNext, discardPendingAnswer } from './dialogs.mjs';

export const MODALS = '[role="dialog"], [role="alertdialog"]';

export async function clickButton(scope, name, { timeout = 0 } = {}) {
  const started = Date.now();
  do {
    let target = scope.getByRole('button', { name }).first();
    if (await target.count() === 0) target = scope.locator('button:visible').filter({ hasText: name }).first();
    if (await target.count()) {
      await target.click();
      return true;
    }
    if (timeout) await new Promise(done => setTimeout(done, 250));
  } while (Date.now() - started < timeout);
  return false;
}

export function modalWithText(page, text) {
  return page.locator(MODALS).filter({ hasText: text });
}

export async function goHome(page) {
  await page.getByText('Modifier un pack existant').waitFor({ timeout: 60_000 });
}

// Nom exact de chaque tuile de l'accueil (`ModeSelector.jsx`) par mode.
const EDITOR_TILE_NAME = {
  simple: 'Éditeur simplifié',
  pack: 'Éditeur par menus',
  advanced: 'Éditeur graphe',
};

// Bouton « Projet » de la barre d'outils (`data-toolbar-id`, stable) : le
// nom accessible seul ('Projet') matche aussi, en sous-chaîne, le fil
// d'Ariane du nom de projet dès qu'il commence par « Projet » (ex. « Projet
// A », ou même « Projet non enregistré »), ce qui viole le mode strict de
// Playwright dès que ce fil d'Ariane est lui-même un bouton.
export function projectMenuButton(page) {
  return page.locator('[data-toolbar-id="project-menu"]');
}

/**
 * Depuis l'accueil : ouvre un nouveau projet dans le mode donné
 * ('simple' | 'pack' | 'advanced'). Rend la main quand l'éditeur est affiché
 * (barre d'outils « Projet » visible ; pour 'advanced', attend en plus que
 * « Générer le pack » soit actif, l'ouverture du graphe prenant quelques
 * secondes).
 */
export async function newProject(page, mode, { timeout = 120_000 } = {}) {
  const name = EDITOR_TILE_NAME[mode];
  if (!name) throw new Error(`Mode d'éditeur inconnu : ${mode}`);
  // Dès qu'un projet de ce mode figure déjà dans les récents (accueil), sa
  // ligne porte un sous-titre (`.mode-proj-sub`) dont le texte est
  // **exactement** le même que celui de la tuile de mode (`.mode-tile-name`) —
  // `getByText(name, { exact: true })` viole alors le mode strict de Playwright
  // (deux éléments trouvés). Scopé à la tuile, qui seule porte cette classe.
  const tile = page.locator('.mode-tile-name', { hasText: new RegExp(`^${name}$`) }).first();
  // `waitFor` avant `count()` : sans lui, un appel juste après le chargement de
  // l'accueil (tuiles pas encore montées) lit `count() === 0` et retombe sur le
  // repli ambigu ci-dessous, qui échoue alors pour de vrai une fois les tuiles
  // rendues.
  await tile.waitFor({ timeout: 15_000 }).catch(() => {});
  if (await tile.count()) {
    await tile.click();
  } else {
    await page.getByText(name, { exact: true }).click();
  }
  const creationError = page.locator(MODALS).filter({ hasText: /Impossible de créer le projet/ }).first();
  // Un refus explicite doit remonter avec son message, sans attendre l'éditeur.
  await Promise.race([
    projectMenuButton(page).waitFor({ timeout }),
    creationError.waitFor({ timeout }).then(async () => {
      throw new Error((await creationError.innerText()).trim());
    }),
  ]);
  if (mode === 'advanced') {
    await page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout });
  }
}

/**
 * Retour à l'accueil depuis un éditeur, par l'interface (menu « Projet » →
 * « Retour à l'accueil »), pas par navigation directe. Un projet neuf est
 * dirty dès sa création : la boîte « Projet non enregistré » est traitée par
 * « Quitter sans enregistrer » ; sur un projet déjà enregistré, la boîte est
 * « Modifications non enregistrées » et le bouton « Ne pas enregistrer » (le fait
 * que cette boîte apparaisse n'est pas masqué, on la traverse simplement pour
 * continuer le parcours).
 */
export async function returnHome(page, { timeout = 30_000, discardUnsaved = true } = {}) {
  await projectMenuButton(page).click();
  await page.getByRole('menuitem', { name: /Retour à l.accueil/ }).click();
  if (discardUnsaved) {
    const confirm = modalWithText(page, /Projet non enregistré|Modifications non enregistrées/);
    const appeared = await confirm.first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (appeared) await clickButton(confirm.first(), /Quitter sans enregistrer|Ne pas enregistrer/);
  }
  await goHome(page);
  await page.waitForTimeout(200);
}

// Ferme le funnel ouvert par son bouton « Fermer » (croix du châssis commun).
// Sans effet si le bouton est désactivé (fermeture bloquée pendant une
// opération en cours) : l'appelant doit alors attendre la fin de l'opération.
// Portée à `[role="dialog"]` : le bouton natif de fermeture de la fenêtre
// (coin haut-droit de l'app) porte lui aussi `title="Fermer"`, donc le même
// nom accessible.
export async function closeFunnel(page) {
  const closeBtn = page.locator(MODALS).getByRole('button', { name: 'Fermer' }).first();
  await closeBtn.waitFor({ timeout: 15_000 });
  if (await closeBtn.isDisabled()) return false;
  await closeBtn.click();
  return true;
}

/**
 * « Modifier un pack existant » → dépôt de l'archive → choix de l'éditeur.
 * `editor` : 'menus' ou 'graphe'. Rend la main quand l'éditeur est affiché.
 */
export async function importPack(page, archivePath, { editor = 'menus', timeout = 180_000 } = {}) {
  await page.getByText('Modifier un pack existant').click();
  await dropFiles(page, '[data-funnel-drop]', [archivePath]);
  const chooser = modalWithText(page, 'Choisir l’éditeur');
  const name = editor === 'graphe' ? 'Éditeur graphe' : 'Éditeur par menus';
  await chooser.waitFor({ timeout }).catch(() => {});
  if (await chooser.count()) {
    await chooser.getByRole('button', { name, exact: true }).click();
  }
  await page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout });
  // Sur un pack volumineux (beaucoup de médias), l'éditeur (arbre, barre d'outils)
  // peut déjà s'afficher intégralement pendant que le funnel « Modifier un
  // pack » (`EditPackFunnel`, châssis `role="dialog"` intitulé « Modifier un
  // pack », toujours visible en phase `busy` : « Décompression du pack… » /
  // « Ouverture de l'Éditeur graphe… ») reste encore affiché par-dessus pour
  // une bonne minute — observé jusqu'à 150 s sur un pack à 84 médias, avant de
  // disparaître de lui-même. Tant qu'il est là, Ctrl+G n'a aucun effet
  // (silencieux). Sans cette attente, l'appelant presse Ctrl+G trop tôt et
  // n'obtient ni fiche ni génération, pour un motif qui ressemble à tort à un
  // blocage applicatif (bouton désactivé ou attente sans fin).
  await modalWithText(page, 'Modifier un pack').first().waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => {});
}

/**
 * « Générer le pack » (Ctrl+G) → fiche du pack → « Appliquer & générer » →
 * révision d'UUID éventuelle → dossier de sortie scripté. Attend l'archive.
 * `uuid` : 'keep' (garder l'UUID d'origine) ou 'new'.
 * Renvoie `{ zip, prompts }` ; `prompts` relève le texte des choix traversés.
 */
// La pastille de validation, une fois la vérification terminée : son état (`ok`
// / `issues`) et son compteur « à corriger ». Sur un gros `.7z`,
// « Vérification… » dure plus longtemps que la marge historique de 15 s, et le
// bouton « Générer le pack » y reste désactivé sans que ce soit un refus. On
// attend donc la fin réelle de la vérification (pastille sortie de
// `is-verifying`, plus de « Lecture du graphe… »), stable 2 s, avant de
// conclure.
export async function waitValidationSettled(page, { timeout = 300_000 } = {}) {
  const pill = page.locator('[data-toolbar-id="toggleValidation"]').first();
  const loading = page.getByText('Lecture du graphe…');
  const deadline = Date.now() + timeout;
  let stableSince = null;
  while (Date.now() < deadline) {
    const present = await pill.count();
    const verifying = present && /is-verifying/.test((await pill.getAttribute('class').catch(() => '')) ?? '');
    const busy = verifying || (await loading.count()) > 0;
    if (!busy && present) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 2_000) {
        const count = Number((await pill.locator('.validation-pill-count').innerText().catch(() => '0')).trim()) || 0;
        return { settled: true, count };
      }
    } else {
      stableSince = null;
    }
    await page.waitForTimeout(500);
  }
  return { settled: false, count: null };
}

const GENERATION_COMMANDS = new Set(['generate_pack', 'export_advanced_pack']);

/**
 * « Générer le pack » (Ctrl+G) → fiche du pack → « Appliquer & générer » →
 * révision d'UUID éventuelle → dossier de sortie scripté. Attend l'archive.
 * `uuid` : 'keep' (garder l'UUID d'origine) ou 'new'.
 * `events` (facultatif, `attachCollectors`) : exige qu'une commande de
 * génération parte après « Appliquer & générer ».
 * Renvoie `{ zip, prompts }` ; `prompts` relève le texte des choix traversés.
 */
export async function generatePack(page, outDir, { uuid = 'keep', timeout = 600_000, events = null } = {}) {
  try {
    return await generatePackWithDialog(page, outDir, { uuid, timeout, events });
  } finally {
    await discardPendingAnswer(page, 'open', outDir);
  }
}

async function generatePackWithDialog(page, outDir, { uuid, timeout, events }) {
  const before = new Set(existsSync(outDir) ? readdirSync(outDir) : []);
  const listing = () => (existsSync(outDir) ? readdirSync(outDir) : []);
  // Une boîte d'import encore ouverte (« Décompression du pack… ») rend
  // Ctrl+G sans effet : on attend sa disparition.
  const importingModal = page.locator(MODALS).filter({ hasText: /Décompression|Modifier un pack/i });
  await importingModal.first().waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => {});
  const validation = await waitValidationSettled(page);
  if (!validation.settled) {
    return { zip: null, refusal: 'vérification jamais terminée (« Vérification… » ou « Lecture du graphe… » persistant)', prompts: [], outDirListing: listing() };
  }
  // « Désactivé » n'est un refus que vérification terminée et « à corriger » > 0.
  const genButton = page.getByRole('button', { name: /Générer le pack/ }).first();
  if (validation.count > 0 && await genButton.count() && await genButton.isDisabled().catch(() => false)) {
    return { zip: null, refusal: `génération bloquée : ${validation.count} à corriger`, blockingCount: validation.count, prompts: [], outDirListing: listing() };
  }
  await answerNext(page, 'open', outDir);
  await page.keyboard.press('Control+g');
  const prompts = [];
  await clickButton(page, /Appliquer\s*&\s*générer/, { timeout: 30_000 });
  const clickedAt = Date.now();
  const revision = modalWithText(page, 'Nouvelle révision');
  await revision.waitFor({ timeout: 5_000 }).catch(() => {});
  if (await revision.count()) {
    prompts.push((await revision.innerText()).trim());
    await clickButton(revision, uuid === 'new' ? /Générer un nouvel UUID/ : /Garder l.UUID d.origine/);
  }
  // Piège : un clic accepté sans qu'aucune génération ne parte, puis 600 s
  // d'attente. On exige un démarrage visible sous 30 s — commande IPC de
  // génération, ou archive écrite — et on échoue vite sinon, sans le masquer :
  // ce peut être un bug de l'app.
  if (events) {
    const startDeadline = Date.now() + 30_000;
    let startedGeneration = false;
    while (Date.now() < startDeadline && !startedGeneration) {
      startedGeneration = events.ipc().some((entry) => entry.at >= clickedAt - 1_000 && GENERATION_COMMANDS.has(entry.cmd))
        || listing().some((name) => !before.has(name));
      if (!startedGeneration) await page.waitForTimeout(500);
    }
    if (!startedGeneration) {
      return { zip: null, refusal: 'génération non démarrée (aucune commande de génération 30 s après « Appliquer & générer »)', notStarted: true, prompts, outDirListing: listing() };
    }
  }
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const fresh = readdirSync(outDir).filter(name => !before.has(name));
    const zip = fresh.find(name => name.endsWith('.zip'));
    if (zip) {
      await page.waitForTimeout(1000);
      return { zip: join(outDir, zip), prompts, outDirListing: readdirSync(outDir) };
    }
    const refusal = page.locator(MODALS).filter({ hasText: /Impossible|refus|interrompu/i });
    if (await refusal.count()) {
      return { zip: null, refusal: (await refusal.first().innerText()).trim(), prompts, outDirListing: readdirSync(outDir) };
    }
    await page.waitForTimeout(1000);
  }
  return { zip: null, timeout: true, prompts, outDirListing: readdirSync(outDir) };
}
