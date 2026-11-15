// « Agréger des packs » : deux petites archives du corpus fusionnées en
// un projet, généré puis relu (app + STUdio). Annulation dès la collecte :
// rien n'est écrit.
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { closeFunnel, goHome, returnHome } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { dropFiles } from '../lib/drop.mjs';
import { smallestArchives } from '../lib/corpus.mjs';
import { extractFixtureMedia } from '../lib/fixtures.mjs';
import { readbackPack, inventory, inventoryDiff } from '../lib/oracles.mjs';

const EDITABLE_DIR = '01 - Editable';

export async function run() {
  const ctx = createRun('c1-agreger-packs');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];
  try {
    const [sourceA, sourceB] = smallestArchives(EDITABLE_DIR, 2);
    const packA = join(ctx.dir('entrées'), 'pack-a.zip');
    const packB = join(ctx.dir('entrées'), 'pack-b.zip');
    copyFileSync(sourceA, packA);
    copyFileSync(sourceB, packB);
    const { image, audio } = extractFixtureMedia(ctx.dir('médias'));

    // --- Annulation dès la collecte : rien n'est écrit. ---
    events.setStep('annulation');
    await goHome(page);
    const beforeCancel = inventory(workspaceDir);
    await page.getByText('Agréger des packs', { exact: true }).click();
    await page.waitForTimeout(500);
    const closed = await closeFunnel(page);
    await goHome(page);
    const afterCancel = inventory(workspaceDir);
    ctx.check('annuler dès la collecte ferme le funnel', closed);
    ctx.check('annuler dès la collecte ne laisse rien dans le workspace', inventoryDiff(beforeCancel, afterCancel).added.length === 0, {
      diff: inventoryDiff(beforeCancel, afterCancel),
    });

    // --- Le funnel aboutit à un projet agrégé, généré et relu. ---
    events.setStep('collecte');
    await page.getByText('Agréger des packs', { exact: true }).click();
    await dropFiles(page, '[data-funnel-drop]', [packA, packB]);
    const listed = await page.getByText(/2 packs? · /).first()
      .waitFor({ timeout: 60_000 }).then(() => true, () => false);
    await ctx.shot(page, 'packs-choisis');
    ctx.check('les 2 archives déposées apparaissent dans la liste', listed);

    const continuer = page.locator('.funnel-foot .funnel-btn-primary');

    events.setStep('audio');
    await continuer.click(); // Packs -> Audio
    await answerNext(page, 'open', audio);
    await page.getByRole('button', { name: /Choisir un audio/ }).click();
    await page.waitForTimeout(500);

    events.setStep('image');
    await continuer.click(); // étape Audio → Image
    await answerNext(page, 'open', image);
    await page.getByRole('button', { name: /Choisir une image/ }).click();
    await page.waitForTimeout(500);

    events.setStep('metadonnees');
    await continuer.click(); // étape Image → Métadonnées (actions fixes dans la fiche intégrée)
    // Chunk lazy (React.lazy) chargé à froid par Vite dev à la première ouverture :
    // laisser large avant de conclure que l'étape ne se charge pas.
    const generateButton = page.locator('.pack-meta-footer').getByRole('button', { name: 'Générer le pack', exact: true });
    const metadataReady = await generateButton.waitFor({ timeout: 60_000 }).then(() => true, () => false);
    await ctx.shot(page, 'metadonnees');
    ctx.check('l’étape Métadonnées (PackNameModal embarqué) se charge', metadataReady);

    events.setStep('generation');
    const outDir = ctx.dir('sortie');
    let zip = null;
    let done = false;
    if (metadataReady) {
      await answerNext(page, 'open', outDir);
      await generateButton.click();
      done = await page.getByText('Pack généré', { exact: true }).first()
        .waitFor({ timeout: 300_000 }).then(() => true, () => false);
      await ctx.shot(page, 'apres-generation');
      const zipName = done ? readdirSync(outDir).find((name) => name.endsWith('.zip')) : null;
      zip = zipName ? join(outDir, zipName) : null;
    }
    ctx.check('le pack agrégé est généré', metadataReady ? Boolean(zip) : null, { done, outDirListing: existsSync(outDir) ? readdirSync(outDir) : [] });
    ctx.check('aucune erreur console pendant l’agrégation', events.faults().length === 0, { faults: events.faults() });

    if (zip) {
      const readback = await readbackPack(page, zip, ctx.dir('studio'));
      ctx.check('le pack agrégé est relu par l’app et accepté par STUdio', readback.ok, { readback });
    }

    // --- Le même brouillon peut être poursuivi dans l’éditeur par menus. ---
    events.setStep('editeur');
    await closeFunnel(page);
    // Attendre que l'assistant précédent soit vraiment fermé : son titre porte le même texte que la tuile.
    await page.locator('.funnel-head-title').waitFor({ state: 'detached', timeout: 15_000 });
    await goHome(page);
    await page.getByText('Agréger des packs', { exact: true }).click();
    await dropFiles(page, '[data-funnel-drop]', [packA, packB]);
    await page.getByText(/2 packs? · /).first().waitFor({ timeout: 60_000 });
    await continuer.click();
    await answerNext(page, 'open', audio);
    await page.getByRole('button', { name: /Choisir un audio/ }).click();
    await continuer.click();
    await answerNext(page, 'open', image);
    await page.getByRole('button', { name: /Choisir une image/ }).click();
    await page.getByRole('button', { name: 'Poursuivre dans l’éditeur par menus', exact: true }).click();
    await page.locator('[data-toolbar-id="project-menu"]').waitFor({ timeout: 60_000 });
    await ctx.shot(page, 'editeur-par-menus');
    await returnHome(page);
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false);
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception sur tout le parcours', allFaults.length === 0, { faults: allFaults });
    const stop = await app.stop();
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
