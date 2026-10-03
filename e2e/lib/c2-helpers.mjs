// Gestes propres à la matrice des chemins, au-dessus de `actions.mjs`.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dropFiles } from './drop.mjs';
import { clickButton, MODALS } from './actions.mjs';
import { answerNext } from './dialogs.mjs';
import {
  nodeOverlayCenter, createGraphAction, selectGraphNode, selectNodePickerOption, wireStageOkToSelectedAction,
} from './c4-helpers.mjs';

// Ouvre les Préférences (Ctrl+Maj+O), pose le réglage « Copier les fichiers
// importés dans l'emplacement de travail » à `desiredOn`, puis referme.
// Le bouton (`Toggle.jsx`) n'a pas de nom accessible ici (pas d'`ariaLabel`
// passé par `ProjectsMediaSection`) : on le cible par la ligne qui porte le
// texte visible.
export async function setCopyImportedFilesPreference(page, desiredOn) {
  await page.keyboard.press('Control+Shift+O');
  const row = page.locator('.opts-row').filter({ hasText: 'Copier les fichiers importés' }).first();
  await row.waitFor({ timeout: 15_000 });
  const toggle = row.locator('button.tog').first();
  const isOn = (await toggle.getAttribute('aria-pressed')) === 'true';
  let clicked = false;
  if (isOn !== desiredOn) {
    await toggle.click();
    clicked = true;
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return { was: isOn, clicked };
}

// Dépôt synthétique sur l'arbre (Éditeur simplifié / par menus) : crée une
// entrée (histoire) référencée, contrairement à un dépôt en médiathèque seule.
export async function dropOnTree(page, filePath) {
  await dropFiles(page, '[data-os-drop-zone="treepanel"]', [filePath]);
  await page.waitForTimeout(1500);
}

// Ouvre la médiathèque (bouton « Médias » de la barre du bas, visible
// seulement quand le panneau est fermé) puis y dépose un fichier.
export async function openMediaExplorer(page) {
  const bottomButton = page.locator('button.rq-bottombar-btn').filter({ hasText: 'Médias' }).first();
  if (await bottomButton.count()) {
    await bottomButton.click();
    await page.waitForTimeout(300);
  }
  // Le panneau mémorise son onglet d'un lancement à l'autre : un parcours
  // précédent a pu le laisser sur « File de rendu », qui masque la médiathèque.
  const mediaTab = page.locator('.bottom-workspace-tabs button').filter({ hasText: 'Médias' }).first();
  if (await mediaTab.count()) {
    await mediaTab.click();
    await page.waitForTimeout(300);
  }
  await page.locator('[data-os-drop-zone="mediaexplorer"]').first().waitFor({ timeout: 30_000 });
}

export async function dropOnMediaExplorer(page, filePath) {
  await openMediaExplorer(page);
  await dropFiles(page, '[data-os-drop-zone="mediaexplorer"]', [filePath]);
  await page.waitForTimeout(1500);
}

// Boîte « Médias introuvables » (`MissingMediaRelinkModal`, aria-label dédié) :
// présente seulement si l'audit de chemins trouve au moins un média manquant.
export function missingMediaModal(page) {
  return page.locator('[aria-label="Médias introuvables"]');
}

export async function hasMissingMediaModal(page, timeout = 6_000) {
  return missingMediaModal(page).first().waitFor({ timeout }).then(() => true, () => false);
}

// La boîte peut apparaître à l'ouverture d'un projet dont un média n'est plus
// au chemin enregistré (fait réel, pas un bug de l'outillage). On la relève
// (nombre de lignes, premiers noms) puis on la ferme par « Ignorer tout » :
// rien n'est relié, rien n'est modifié sur disque. Partagée par plusieurs parcours.
export async function dismissMissingMediaModalIfPresent(page, { timeout = 6_000 } = {}) {
  const modal = missingMediaModal(page);
  const appeared = await modal.first().waitFor({ timeout }).then(() => true, () => false);
  if (!appeared) return { appeared: false, missingCount: 0 };
  const missingCount = await modal.locator('.relink-row').count().catch(() => null);
  const names = await modal.locator('.relink-row-name').allInnerTexts().catch(() => []);
  await modal.getByRole('button', { name: 'Ignorer tout' }).click().catch(() => {});
  const closed = await modal.first().waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false);
  return { appeared: true, closed, missingCount, names: names.slice(0, 10) };
}

// Enregistrement explicite (première fois : agit comme « Enregistrer sous »,
// `saveProject` avec `existingPath` null ouvre le dialogue `save`).
export async function saveProjectAs(page, targetPath, { shortcut = 'Control+s' } = {}) {
  const { answerNext } = await import('./dialogs.mjs');
  await answerNext(page, 'save', targetPath);
  await page.keyboard.press(shortcut);
  await keepSessionMediaIfPrompted(page);
  await page.waitForTimeout(2500);
}

export async function keepSessionMediaIfPrompted(page, { timeout = 1500 } = {}) {
  const keepButton = page.getByRole('button', { name: /(?:Conserver|Garder) la sélection/ }).first();
  const prompted = await keepButton.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  if (prompted) await keepButton.click();
  return prompted;
}

export async function saveProjectAsExplicit(page, targetPath) {
  return saveProjectAs(page, targetPath, { shortcut: 'Control+Shift+s' });
}

export async function openProjectDialog(page, path, { timeout = 60_000 } = {}) {
  const { answerNext } = await import('./dialogs.mjs');
  await answerNext(page, 'open', path);
  await page.keyboard.press('Control+o');
  const { projectMenuButton } = await import('./actions.mjs');
  return projectMenuButton(page).waitFor({ timeout }).then(() => true, () => false);
}

// Bascule « Utiliser un workspace pour les nouveaux projets » (même écran de
// Préférences). Contrairement à la préférence de copie, elle n'a pas non plus
// de nom accessible dédié : ciblée par la ligne qui porte son texte visible.
export async function setUseWorkspaceForNewProjectsPreference(page, desiredOn) {
  await page.keyboard.press('Control+Shift+O');
  const row = page.locator('.opts-row').filter({ hasText: 'Utiliser un workspace pour les nouveaux projets' }).first();
  await row.waitFor({ timeout: 15_000 });
  const toggle = row.locator('button.tog').first();
  const isOn = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (isOn !== desiredOn) await toggle.click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return { was: isOn };
}

// ── Remplir un éditeur par ses champs ────────────────────────────────────────
//
// Les champs de média (`AudioField`, `ImageField`) ouvrent le dialogue `open`
// (shimmé) quand on clique leur zone vide ; une image passe ensuite par
// l'éditeur d'image (`ImageEditorModal`, bouton « Utiliser cette image »),
// comme pour un auteur.

// Carte d'éditeur visible par son titre (`.card-title`) : « Dossier »
// (`MenuEditor`), « L'histoire » (`StoryEditor`), « Récit complet »
// (`RootEditor`, simplifié). La carte racine a sa propre classe :
// `.root-identity-card`.
export function editorCard(page, title) {
  return page.locator('.card:visible')
    .filter({ has: page.locator('.card-title', { hasText: new RegExp(`^${title}$`) }) })
    .first();
}

// Champ audio vide dont le libellé est `label` (texte de `.audio-empty-text`) :
// clic, fichier scripté, puis attente de l'état rempli (la zone vide disparaît).
export async function pickAudioField(page, scope, label, filePath, { timeout = 15_000 } = {}) {
  const empty = scope.locator('.audio-empty-import').filter({ hasText: label }).first();
  if (!await empty.waitFor({ timeout }).then(() => true, () => false)) return false;
  await answerNext(page, 'open', filePath);
  await empty.click();
  return empty.waitFor({ state: 'detached', timeout }).then(() => true, () => false);
}

// Champ image vide du `scope` : clic, fichier scripté, « Utiliser cette image »
// (actif une fois l'image chargée), puis attente de l'aperçu rempli.
export async function pickImageField(page, scope, filePath, { timeout = 30_000 } = {}) {
  const empty = scope.locator('.image-drop.empty').first();
  if (!await empty.waitFor({ timeout: 15_000 }).then(() => true, () => false)) return false;
  await answerNext(page, 'open', filePath);
  await empty.click();
  const editor = page.locator('.image-editor-box');
  if (!await editor.waitFor({ timeout }).then(() => true, () => false)) return false;
  await editor.getByRole('button', { name: 'Utiliser cette image' }).click({ timeout });
  await editor.waitFor({ state: 'hidden', timeout }).catch(() => {});
  return scope.locator('.image-drop.filled').first().waitFor({ timeout }).then(() => true, () => false);
}

// Titre du pack par la fiche (bandeau « titre · âge · version » de la barre de
// titre → `PackNameModal`, champ « Titre du pack », « Appliquer »). Sans titre,
// « Appliquer & générer » reste désactivé (« Renseigne le titre du pack avant
// de générer. ») et `generatePack` attendrait une archive qui ne viendra pas.
export async function setPackTitle(page, title, { timeout = 15_000 } = {}) {
  await page.locator('.chrome-titlebar-pack-recap').click();
  const sheet = page.locator('.pack-meta-modal');
  if (!await sheet.waitFor({ timeout }).then(() => true, () => false)) return false;
  await sheet.locator('.pack-meta-field-row').filter({ hasText: 'Titre du pack' }).locator('input').first().fill(title);
  await sheet.getByRole('contentinfo').getByRole('button', { name: 'Appliquer', exact: true }).click();
  return sheet.waitFor({ state: 'hidden', timeout }).then(() => true, () => false);
}

// Menu contextuel d'un nœud de l'arbre (`TreeNode.jsx`, `data-tree-node-id` /
// `data-media-node-type`) puis une de ses entrées (`treeContextMenuActions.jsx`).
export async function treeNodeAction(page, node, itemName, { timeout = 15_000 } = {}) {
  await node.waitFor({ timeout });
  await node.scrollIntoViewIfNeeded();
  await node.click({ button: 'right' });
  const item = page.locator('.ctx-menu').getByRole('menuitem', { name: itemName }).first();
  if (!await item.waitFor({ timeout: 5_000 }).then(() => true, () => false)) return false;
  await item.click();
  await page.waitForTimeout(500);
  return true;
}

export function treeRoot(page) {
  return page.locator('[data-tree-node-id="root"]').first();
}

export function treeFolder(page, name = null) {
  const folders = page.locator('[data-media-node-type="menu"]');
  return (name ? folders.filter({ hasText: name }) : folders).first();
}

// ── Éditeur graphe : médias et raccord ───────────────────────────────────────

function graphStageRow(page, stageName) {
  return page.locator('li[role="option"][data-kind="stage"]').filter({ hasText: stageName }).first();
}

// Pose un média de la médiathèque sur un Écran par le geste de dépôt :
// glisser de la tuile (`MediaTile.jsx`, pointeur) jusqu'au nœud peint, dont la
// position vient de la couche de survol (`GraphNodeOverlays.jsx`,
// `data-node-path`, sans capture du pointeur : le canvas reçoit le survol et
// `nodeAtPointer` désigne l'Écran). Le canvas relit le nœud au relâchement et
// part en `set-stage-media`. Si aucun geste ne part (glisser au pointeur non
// concluant), repli sur le bouton « Utiliser sur « Écran » » de la
// médiathèque, qui appelle la même fonction (`dropMediaOnStage`). Rend la voie
// suivie : 'depot-canvas', 'bouton-utiliser-sur' ou null.
export async function assignMediaToGraphStage(page, events, { fileStem, stageName, timeout = 15_000 }) {
  const row = graphStageRow(page, stageName);
  if (!await row.waitFor({ timeout }).then(() => true, () => false)) return { via: null, reason: 'Écran absent de la liste' };
  // L'Écran inspecté est la cible publiée pour la médiathèque.
  await row.click();
  await page.waitForTimeout(300);
  await openMediaExplorer(page);
  const tile = page.locator('.media-explorer [data-media-id]').filter({ hasText: fileStem }).first();
  if (!await tile.waitFor({ timeout }).then(() => true, () => false)) return { via: null, reason: 'tuile absente de la médiathèque' };
  await tile.scrollIntoViewIfNeeded();
  const rowId = await row.getAttribute('id');
  const path = rowId?.startsWith('advanced-option-') ? decodeURIComponent(rowId.slice('advanced-option-'.length)) : null;
  const startedAt = Date.now();
  const gestureSent = () => events.ipc().some((entry) => entry.at >= startedAt
    && entry.cmd === 'apply_advanced_gesture'
    && entry.body?.gesture?.gesture === 'set-stage-media');

  const target = path ? await nodeOverlayCenter(page, path) : null;
  const from = await tile.boundingBox();
  if (target && from) {
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Au-delà du seuil de 6 px de `MediaTile`, puis jusqu'au nœud.
    await page.mouse.move(start.x + 12, start.y - 12, { steps: 3 });
    await page.mouse.move(target.x, target.y, { steps: 20 });
    await page.waitForTimeout(200);
    await page.mouse.move(target.x + 1, target.y + 1);
    await page.mouse.up();
    await page.waitForTimeout(1500);
    if (gestureSent()) return { via: 'depot-canvas', path };
  }
  await tile.click();
  const use = page.locator('.media-selection-bar').getByRole('button', { name: /^Utiliser sur « / }).first();
  if (!await use.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
    return { via: null, path, overlay: !!target, reason: 'ni dépôt ni bouton « Utiliser sur »' };
  }
  await use.click();
  await page.waitForTimeout(1500);
  return { via: gestureSent() ? 'bouton-utiliser-sur' : null, path, overlay: !!target };
}

// Relie `fromStage` (sortie OK) à `toStage` par une nouvelle liste de choix,
// par l'Inspecteur (`ActionEditor.jsx`) : « Créer une liste de choix » (née avec
// un choix « Écran à choisir »), « Gestes du choix 1 » → « Modifier… » → Écran
// visé → « Changer l’Écran », puis « Relier un Écran » sur la touche OK.
export async function linkStagesThroughNewList(page, fromStage, toStage) {
  if (!await createGraphAction(page)) return { ok: false, step: 'créer la liste' };
  if (!await selectGraphNode(page, 'Liste 1', 'action')) return { ok: false, step: 'sélectionner Liste 1' };
  await page.getByRole('button', { name: 'Gestes du choix 1' }).first().click();
  const edit = page.locator('.ctx-menu').getByRole('menuitem', { name: /^Modifier/ }).first();
  if (!await edit.waitFor({ timeout: 5_000 }).then(() => true, () => false)) return { ok: false, step: 'menu du choix 1' };
  await edit.click();
  const picker = page.locator('#advanced-retarget-target');
  if (!await picker.waitFor({ timeout: 5_000 }).then(() => true, () => false)) return { ok: false, step: 'formulaire « Modifier »' };
  await selectNodePickerOption(picker, toStage);
  await clickButton(page, /Changer l.Écran/, { timeout: 5_000 });
  await page.waitForTimeout(400);
  await wireStageOkToSelectedAction(page, fromStage);
  return { ok: true };
}

export { MODALS, clickButton };

// Sous-dossiers gérés que l'app crée pour les médias d'un projet. Un projet
// enregistré range ses médias dans l'emplacement de travail : aucun de ces
// dossiers ne doit apparaître à côté de son `.mbah`.
const MANAGED_MEDIA_DIRS = ['fichiers-importes', 'enregistrements', 'voix-generees', 'images-generees'];

export function managedDirsBeside(projectDir) {
  return MANAGED_MEDIA_DIRS.filter((name) => existsSync(join(projectDir, name)));
}

// Copie gérée d'un média source (`{projet}__{nom}` ou dérivé), cherchée dans
// un sous-dossier géré : le nom exact n'est jamais supposé.
export function findManagedCopy(rootDir, sourceName, category = 'fichiers-importes') {
  const dir = join(rootDir, category);
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).find((name) => name.endsWith(`__${sourceName}`) || name === sourceName);
  return found ? join(dir, found) : null;
}
