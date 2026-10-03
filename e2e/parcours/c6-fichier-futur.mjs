// Fichier « futur » : copie d'un `.mbah` réel dont `schemaVersion` est
// porté au-delà de ce que l'app connaît (`ADVANCED_SCHEMA_VERSION = 4` dans
// `src/store/projectModel/authoring.js` ; `readProjectEnvelope`,
// `src/store/projectModel/envelope.js`, refuse tout `schemaVersion > 4`, avant
// même la migration ou la normalisation — `decodeProjectFile`,
// `src/store/projectModel/codec.js`). Oracle : refus propre, message
// compréhensible, projet courant intact, rien d'écrit.
//
// Contre-épreuve : la même copie mais avec `schemaVersion` ramené à une valeur
// connue doit s'ouvrir normalement — ce qui isole le refus au seul champ de
// version, pas à une autre corruption introduite par la manipulation du fichier.
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { goHome, newProject, projectMenuButton, modalWithText } from '../lib/actions.mjs';
import { openProjectDialog, saveProjectAsExplicit } from '../lib/c2-helpers.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';

const SOURCE_NAME = 'histoire simple 1';
const FUTURE_SCHEMA_VERSION = 99;

function sourcePath() {
  if (process.env.SS_E2E_C6_PROJECTS_DIR) return join(process.env.SS_E2E_C6_PROJECTS_DIR, `${SOURCE_NAME}.mbah`);
  return join(homedir(), 'Documents', 'story-studio', 'sauvegardes', `${SOURCE_NAME}.mbah`);
}

export async function run() {
  const ctx = createRun('c6-fichier-futur');
  const source = sourcePath();
  if (!existsSync(source)) {
    ctx.check(`le projet source (${SOURCE_NAME}) est présent`, false, { source });
    return ctx.finish();
  }

  const workDir = ctx.dir('fichiers');
  const original = JSON.parse(readFileSync(source, 'utf8'));
  const originalSchemaVersion = original.schemaVersion;

  const futurePath = join(workDir, `${SOURCE_NAME} (futur).mbah`);
  writeFileSync(futurePath, JSON.stringify({ ...original, schemaVersion: FUTURE_SCHEMA_VERSION }, null, 2));

  const controlPath = join(workDir, `${SOURCE_NAME} (controle).mbah`);
  writeFileSync(controlPath, JSON.stringify({ ...original, schemaVersion: originalSchemaVersion }, null, 2));

  const workspaceDir = ctx.dir('workspace');
  const session = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  try {
    // Projet courant reconnaissable, pour vérifier qu'il reste intact après le refus.
    await newProject(session.page, 'pack');
    await session.page.keyboard.press('Control+Shift+N'); // un dossier, pour avoir un état à préserver
    await session.page.waitForTimeout(500);
    await session.page.keyboard.press('Escape');
    await session.page.waitForTimeout(300);
    // Enregistré avant la tentative d'ouverture : un projet non enregistré
    // ferait apparaître la boîte « Projet non enregistré » avant même que
    // l'app n'essaie de lire le fichier futur, ce qui n'est pas ce qu'on teste
    // ici (le refus du fichier, pas la garde de perte de travail — déjà
    // couverte ailleurs, ex. dans `c2-menus.mjs`).
    const currentSavePath = join(workDir, 'projet-courant.mbah');
    await saveProjectAsExplicit(session.page, currentSavePath);
    const nodeCountBefore = await session.page.locator('[data-tree-node-id]').count();
    const breadcrumbBefore = await projectMenuButton(session.page).innerText().catch(() => null);

    const before = inventory(workspaceDir);

    const { answerNext } = await import('../lib/dialogs.mjs');
    await answerNext(session.page, 'open', futurePath);
    await session.page.keyboard.press('Control+o');
    const errorDialog = modalWithText(session.page, 'Ouverture du projet');
    const appeared = await errorDialog.first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const message = appeared ? (await errorDialog.first().innerText().catch(() => '')).trim() : null;
    ctx.check('fichier futur : refus propre par une boîte de dialogue lisible', appeared, { message });
    ctx.check('fichier futur : le message mentionne la version de schéma', appeared && /schema|schéma|version/i.test(message ?? ''), { message });
    await ctx.shot(session.page, 'refus-fichier-futur');

    if (appeared) {
      const okButton = errorDialog.getByRole('button').first();
      if (await okButton.count()) await okButton.click();
      await session.page.waitForTimeout(300);
    }

    const nodeCountAfter = await session.page.locator('[data-tree-node-id]').count();
    const breadcrumbAfter = await projectMenuButton(session.page).innerText().catch(() => null);
    ctx.check('fichier futur : le projet courant est intact (même nombre de nœuds)', nodeCountAfter === nodeCountBefore, { nodeCountBefore, nodeCountAfter });
    ctx.check('fichier futur : le fil d’Ariane du projet courant est inchangé', breadcrumbAfter === breadcrumbBefore, { breadcrumbBefore, breadcrumbAfter });

    const after = inventory(workspaceDir);
    const diff = inventoryDiff(before, after);
    ctx.check('fichier futur : rien d’écrit dans le workspace de la session', diff.added.length === 0 && diff.changed.length === 0, diff);

    // ── Contre-épreuve : même fichier, version ramenée à une valeur connue ──
    await answerNext(session.page, 'open', controlPath);
    await session.page.keyboard.press('Control+o');
    const opened = await projectMenuButton(session.page).waitFor({ timeout: 30_000 }).then(() => true, () => false);
    ctx.check('contre-épreuve : la même copie avec un schemaVersion connu s’ouvre normalement', opened, { controlPath, originalSchemaVersion });
    await ctx.shot(session.page, 'contre-epreuve-ouverture-normale');

    // Un refus attendu se journalise délibérément en `console.error`
    // (`logger.error('load:error error=...')`, `useProjectLoading.js`) : c'est
    // la trace diagnostique du rejet propre, pas un défaut. Seule une erreur
    // qui ne porte PAS ce message attendu (`ProjectFormatError`,
    // `UNSUPPORTED_SCHEMA_VERSION`) compterait comme un fait anormal ici.
    const unexpectedFaults = session.events.faults()
      .filter((fault) => !fault.text?.includes('UNSUPPORTED_SCHEMA_VERSION'));
    ctx.check('aucune erreur console ni exception inattendue', unexpectedFaults.length === 0, { unexpectedFaults, allFaults: session.events.faults() });
  } finally {
    const stop = await session.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace (fin de parcours)', stop.polluted.length === 0, { polluted: stop.polluted });
  }

  return ctx.finish();
}
