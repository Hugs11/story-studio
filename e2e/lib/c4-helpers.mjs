// Gestes et oracles propres aux invariants de l'éditeur graphe, au-dessus
// de `actions.mjs` et `c2-helpers.mjs`.
//
// Lire l'état du document sans sonde applicative : le `.mbah` sur disque porte
// `authoring.payload` (chaîne opaque, voir `store/projectModel/authoring.js`) ;
// `read_advanced_graph_view` (IPC déjà utilisée par l'app, `AdvancedGraphView`
// DTO — `native_pack/graph_view/dto.rs`) le projette en une vue dérivée qui
// porte `documentFingerprint`, une empreinte des octets exacts du payload lu.
// Comparer deux vues revient donc à comparer cette empreinte : un token opaque,
// jamais recalculé ici, jamais réémis vers le document.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MODALS, clickButton, waitValidationSettled } from './actions.mjs';

// Ne répare que les deux diagnostics de fin, par les boutons offerts à
// l'utilisateur. Les autres problèmes restent visibles et bloquants.
export async function repairGraphEndings(page) {
  const messages = [];
  const panel = page.locator('[aria-label="Éléments à corriger"]');
  const pill = page.locator('[data-toolbar-id="toggleValidation"]').first();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const validation = await waitValidationSettled(page);
    if (!validation.settled) throw new Error('Vérification des fins jamais terminée');
    if (!validation.count) return { repaired: messages.length, messages, remaining: 0 };
    await pill.hover();
    const opened = await panel.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    if (!opened) await pill.click();
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    const issue = panel.locator('.advanced-diagnostics__item').filter({
      hasText: /OK ou la fin automatique est actif sans destination utilisable|Cet Écran accessible ne permet aucune sortie, même par la molette/,
    }).first();
    if (!await issue.count()) {
      await page.keyboard.press('Escape');
      return { repaired: messages.length, messages, remaining: validation.count };
    }
    messages.push(await issue.locator('.advanced-diagnostics__message').filter({
      hasText: /OK ou la fin automatique est actif sans destination utilisable|Cet Écran accessible ne permet aucune sortie, même par la molette/,
    }).innerText());
    await issue.getByRole('button', { name: 'En faire une fin', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  throw new Error('Les diagnostics de fin persistent après 100 réparations');
}

export function readMbahProject(mbahPath) {
  return JSON.parse(readFileSync(mbahPath, 'utf8'));
}

// Lit le payload courant depuis le `.mbah` (déjà enregistré) et le fait
// projeter par Rust. Renvoie `{ project, view }` ; `view` est `null` si le
// codec refuse le payload (`view.error` porte alors le refus, jamais réécrit).
export async function readGraphView(page, mbahPath) {
  const project = readMbahProject(mbahPath);
  const payload = project?.authoring?.payload;
  if (typeof payload !== 'string') throw new Error(`Pas de payload d'auteur dans ${mbahPath}`);
  const view = await page.evaluate(
    (p) => window.__TAURI_INTERNALS__.invoke('read_advanced_graph_view', { payload: p }),
    payload,
  );
  return { project, view };
}

// Deux documents sont « le même » si l'empreinte des octets exacts du payload
// l'est (DTO de la vue, `native_pack/graph_view/dto.rs`) — jamais une
// comparaison profonde maison de la vue, qui pourrait diverger de ce que Rust
// considère identique.
export function sameDocument(viewA, viewB) {
  return !!viewA && !!viewB && viewA.documentFingerprint === viewB.documentFingerprint;
}

// Résumé lisible pour le rapport (pas un oracle : `sameDocument` l'est).
export function viewSummary(view) {
  if (!view) return null;
  return {
    fingerprint: view.documentFingerprint,
    counts: view.counts,
    stageNames: (view.stages ?? []).map((s) => (s.name?.presence === 'value' ? s.name.value : `(${s.uuid})`)),
    actionNames: (view.actions ?? []).map((a) => (a.name?.presence === 'value' ? a.name.value : `(${a.id})`)),
  };
}

export function diffViewSummaries(a, b) {
  if (!a || !b) return { comparable: false };
  return {
    comparable: true,
    counts: { before: a.counts, after: b.counts },
    stagesAdded: b.stageNames.filter((n) => !a.stageNames.includes(n)),
    stagesRemoved: a.stageNames.filter((n) => !b.stageNames.includes(n)),
    actionsAdded: b.actionNames.filter((n) => !a.actionNames.includes(n)),
    actionsRemoved: a.actionNames.filter((n) => !b.actionNames.includes(n)),
  };
}

// La liste des nœuds (`GraphSearchPanel.jsx`) est le chemin principal d'accès
// au graphe : le canvas est un `<canvas>` muet, rien n'y est adressable
// individuellement au DOM. Sélectionner par nom+nature y suffit pour tout
// geste piloté depuis l'Inspecteur.
export function graphNodeListItem(page, name, kind) {
  return page.locator(`li[role="option"][data-kind="${kind}"]`).filter({ hasText: name }).first();
}

export async function selectGraphNode(page, name, kind, { timeout = 15_000 } = {}) {
  const item = graphNodeListItem(page, name, kind);
  const found = await item.waitFor({ timeout }).then(() => true, () => false);
  if (!found) return false;
  await item.click();
  await page.waitForTimeout(200);
  return true;
}

// Sélectionne par chemin exact (`GraphSearchPanel.jsx` : id de la ligne =
// `advanced-option-<encodeURIComponent(path)>`) — utile quand deux nœuds
// partagent le même nom affiché (ex. juste après un collage) et qu'un
// identifiant issu de la vue IPC est la seule façon non ambiguë de viser
// « celui-là précisément ».
export async function selectGraphNodeByPath(page, path) {
  const id = `advanced-option-${encodeURIComponent(path)}`;
  const item = page.locator(`[id="${id}"]`);
  if (await item.count() === 0) return false;
  await item.click();
  await page.waitForTimeout(200);
  return true;
}

// La position écran d'un nœud peint, via la couche de survol HTML
// (`GraphNodeOverlays.jsx`, `data-node-path`) — le canvas lui-même
// n'expose rien au DOM (commentaire de tête de `GraphCanvasStage.jsx`),
// mais cette couche donne les coordonnées exactes pour un clic ou un
// glisser piloté par coordonnées (`page.mouse`), sans deviner une position.
export async function nodeOverlayCenter(page, path) {
  const overlay = page.locator(`[data-node-path="${path}"]`).first();
  if (await overlay.count() === 0) return null;
  const box = await overlay.boundingBox();
  if (!box) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Un point écran sur le corps d'un nœud que ne recouvre aucun autre nœud : les
// Écrans naissent en cascade (décalage de quelques dizaines de pixels), le
// centre de l'un est donc souvent sous la carte d'un autre, et le moteur
// désigne alors le nœud du dessus. Cherche, dans la boîte rendue du nœud
// (marge de 10 px pour éviter les bords et les prises), un point hors de
// toutes les autres boîtes et reçu par le canvas ; null si aucun. Les zones
// de saisie des séparateurs peuvent déborder dans la boîte du canvas.
export async function freePointOnNode(page, path) {
  return page.evaluate((nodePath) => {
    const host = document.querySelector('.advanced-canvas__host');
    const { cy } = host._cyreg;
    const node = cy.$id(nodePath);
    if (node.empty()) return null;
    const own = node.renderedBoundingBox();
    const others = cy.nodes().filter((other) => other.id() !== nodePath).map((other) => other.renderedBoundingBox());
    const origin = host.getBoundingClientRect();
    const margin = 10;
    // Grille 9×9 dans la boîte, essayée du centre vers les bords.
    const cells = [];
    for (let i = 0; i < 9; i += 1) for (let j = 0; j < 9; j += 1) cells.push([(i + 0.5) / 9, (j + 0.5) / 9]);
    cells.sort((p, q) => Math.hypot(p[0] - 0.5, p[1] - 0.5) - Math.hypot(q[0] - 0.5, q[1] - 0.5));
    for (const [fx, fy] of cells) {
      const x = own.x1 + margin + fx * (own.w - 2 * margin);
      const y = own.y1 + margin + fy * (own.h - 2 * margin);
      const covered = others.some((box) => x >= box.x1 - 4 && x <= box.x2 + 4 && y >= box.y1 - 4 && y <= box.y2 + 4);
      const inHost = x > 0 && y > 0 && x < origin.width && y < origin.height;
      if (covered || !inHost) continue;
      const hit = document.elementFromPoint(origin.left + x, origin.top + y);
      if (hit?.tagName === 'CANVAS' && host.contains(hit)) {
        return { x: origin.left + x, y: origin.top + y };
      }
    }
    return null;
  }, path);
}

export async function createGraphStage(page) {
  const ok = await clickButton(page, /Créer un Écran/, { timeout: 5_000 });
  if (ok) await page.waitForTimeout(400);
  return ok;
}

export async function createGraphAction(page) {
  const ok = await clickButton(page, /Créer une liste de choix/, { timeout: 5_000 });
  if (ok) await page.waitForTimeout(400);
  return ok;
}

// Renomme le nœud actuellement sélectionné (sélection unique) par F2, en
// passant par le champ « Nom » de l'Inspecteur (`NodeNameEditor.jsx` — Entrée
// valide, Échap annule).
export async function renameSelectedNode(page, newName) {
  await page.keyboard.press('F2');
  // `exact: true` : sans lui, `getByLabel` matche aussi, en sous-chaîne
  // insensible à la casse, le bouton de la fiche du pack dans la barre de
  // titre (aria-label « … Modifier le **nom** et les métadonnées du pack »),
  // souvent trouvé en premier dans l'ordre du DOM.
  const field = page.getByLabel('Nom', { exact: true }).first();
  await field.waitFor({ timeout: 5_000 });
  await field.fill(newName);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

// Choisit, dans un `<select>` de `NodePicker.jsx`, la première `<option>` dont
// le texte commence par `name` (le picker peut suffixer « (sans nom) » ou
// « — identifiant dupliqué » : `selectOption({ label })` de Playwright exige
// une égalité EXACTE et n'accepte pas de RegExp pour `label`, d'où ce détour
// par `value`, l'attribut qui porte le chemin du nœud).
export async function selectNodePickerOption(selectLocator, name) {
  const value = await selectLocator.evaluate((select, wanted) => {
    const match = [...select.options].find((option) => option.textContent?.trim().startsWith(wanted));
    return match ? match.value : null;
  }, name);
  if (!value) throw new Error(`Aucune option « ${name}… » dans ce sélecteur.`);
  await selectLocator.selectOption({ value });
}

const inspector = (page) => page.locator('.advanced-panel--inspector');

// Depuis l'Inspecteur d'une Action (Liste de choix) déjà sélectionnée :
// « Relier un Écran », touche OK pré-choisie, pose la transition OK de l'Écran
// choisi vers cette Action (WireForm, `ActionEditor.jsx`).
export async function wireStageOkToSelectedAction(page, stageName) {
  await clickButton(inspector(page), /Relier un Écran/, { timeout: 5_000 });
  const picker = page.locator('#advanced-wire-ok');
  await picker.waitFor({ timeout: 5_000 });
  await selectNodePickerOption(picker, stageName);
  await clickButton(inspector(page), /^Relier$/, { timeout: 5_000 });
  await page.waitForTimeout(300);
}

// Depuis l'Inspecteur d'une Action (Liste de choix) déjà sélectionnée :
// « Ajouter un choix » insère un nouveau choix vers l'Écran choisi.
export async function addActionDestination(page, stageName) {
  // Restreint à l'Inspecteur : les prises du graphe portent aussi le nom
  // « Ajouter un choix » (`graphLinkDraft.js`) et précèdent l'Inspecteur dans le DOM.
  await clickButton(inspector(page), /Ajouter un choix/, { timeout: 5_000 });
  const picker = page.locator('#advanced-insert-target');
  await picker.waitFor({ timeout: 5_000 });
  await selectNodePickerOption(picker, stageName);
  await clickButton(inspector(page), /Insérer/, { timeout: 5_000 });
  await page.waitForTimeout(300);
}

// Depuis l'Inspecteur d'une Action déjà sélectionnée : « Gestes du choix N » →
// « Modifier… » → Écran visé → « Changer l’Écran ». Une liste naît avec un
// choix « Écran à choisir » non raccordé, que l'export refuse tant qu'il reste.
export async function retargetActionChoice(page, choiceNumber, stageName) {
  await page.getByRole('button', { name: `Gestes du choix ${choiceNumber}` }).first().click();
  await page.locator('.ctx-menu').getByRole('menuitem', { name: /^Modifier/ }).first().click();
  const picker = page.locator('#advanced-retarget-target');
  await picker.waitFor({ timeout: 5_000 });
  await selectNodePickerOption(picker, stageName);
  await clickButton(inspector(page), /Changer l.Écran/, { timeout: 5_000 });
  await page.waitForTimeout(400);
}

// Empreintes utiles au rapport : commandes IPC en échec (kind `ipc.error`) et
// lignes `ERROR` du log Rust — deux signaux que `events.faults()` ne porte pas
// (limité aux erreurs console et exceptions JS).
export function ipcErrors(events) {
  return events.all().filter((event) => event.kind === 'ipc.error');
}

export function tauriLogErrors(runDir) {
  const path = join(runDir, 'tauri-dev.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => /ERROR/.test(line));
}

// Attend que le bouton « Générer le pack » soit présent (barre d'outils), sans
// exiger qu'il soit actif — utile pour un projet dont la fiche est incomplète.
export async function waitAdvancedToolbarReady(page, { timeout = 60_000 } = {}) {
  await page.getByRole('button', { name: /Générer le pack/ }).first().waitFor({ timeout });
}

export { MODALS, clickButton };
