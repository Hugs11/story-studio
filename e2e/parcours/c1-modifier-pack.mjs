// « Modifier un pack existant » : zip ordinaire (menus, graphe), .7z,
// pack au format FS (dossier, converti par le harnais STUdio), enveloppe
// (liste, retour, choix, Continuer jusqu'à l'éditeur), archive
// d'erreur non-enveloppe (refus lisible), et annulation à mi-chemin.
//
// Archives choisies dynamiquement (les plus petites) sous des sous-dossiers
// de classement du corpus : aucun nom de pack réel n'est versionné ici.
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { closeFunnel, goHome, importPack, modalWithText, returnHome } from '../lib/actions.mjs';
import { smallestArchive, smallestArchives, smallestByExt } from '../lib/corpus.mjs';
import { convertToFsFolder } from '../studio/studio.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';

const EDITABLE_DIR = '01 - Editable';
const ENVELOPE_DIR = join('04 - Erreur import', 'Triage', '01 - Bundle multi-pack supportable');
const NON_ENVELOPE_ERROR_DIR = join('04 - Erreur import', 'Triage', '02 - Compression ZIP a adapter');

export async function run() {
  const ctx = createRun('c1-modifier-pack');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];
  try {
    // Deux petites archives éditables distinctes (menus, puis graphe).
    const [editableA, editableB] = smallestArchives(EDITABLE_DIR, 2);
    const zipMenus = join(ctx.dir('entrées'), 'ordinaire-menus.zip');
    const zipGraphe = join(ctx.dir('entrées'), 'ordinaire-graphe.zip');
    copyFileSync(editableA, zipMenus);
    copyFileSync(editableB, zipGraphe);

    events.setStep('zip-menus');
    await goHome(page);
    await importPack(page, zipMenus, { editor: 'menus' });
    await ctx.shot(page, 'zip-menus');
    ctx.check('zip ordinaire → Éditeur par menus : ouvre sans erreur', events.faults().length === 0, { faults: events.faults() });
    await returnHome(page);

    events.setStep('zip-graphe');
    await importPack(page, zipGraphe, { editor: 'graphe' });
    await ctx.shot(page, 'zip-graphe');
    ctx.check('zip ordinaire → Éditeur graphe : ouvre sans erreur', events.faults().length === 0, { faults: events.faults() });
    await returnHome(page);

    // --- .7z ---
    events.setStep('sept-zip');
    const sevenZipSource = smallestByExt(EDITABLE_DIR, '7z');
    const sevenZip = join(ctx.dir('entrées'), 'ordinaire.7z');
    copyFileSync(sevenZipSource, sevenZip);
    await importPack(page, sevenZip, { editor: 'menus' });
    await ctx.shot(page, 'sept-zip');
    ctx.check('.7z → éditeur : ouvre sans erreur', events.faults().length === 0, { faults: events.faults() });
    await returnHome(page);

    // --- Pack au format FS (dossier), converti par le harnais STUdio ---
    events.setStep('fs-folder');
    let fsFolder = null;
    let fsError = null;
    try {
      fsFolder = convertToFsFolder(editableA, ctx.dir('fs-source'));
    } catch (error) {
      fsError = error;
    }
    ctx.check('conversion FS (harnais STUdio) disponible pour la suite', Boolean(fsFolder), fsError ? { error: String(fsError) } : {});
    if (fsFolder) {
      await importPack(page, fsFolder, { editor: 'menus' });
      await ctx.shot(page, 'fs-folder');
      ctx.check('pack au format FS (dossier) → éditeur : ouvre sans erreur', events.faults().length === 0, { faults: events.faults() });
      await returnHome(page);
    } else {
      ctx.check('pack au format FS (dossier) → éditeur : ouvre sans erreur', null, { detail: 'conversion FS indisponible' });
    }

    // --- Annulation avant tout dépôt : ne laisse rien derrière ---
    events.setStep('annulation-avant-depot');
    const outDir = ctx.dir('sortie');
    const beforeCancel = inventory(workspaceDir);
    await page.getByText('Modifier un pack existant', { exact: true }).click();
    await page.waitForTimeout(500);
    const closedEarly = await closeFunnel(page);
    await goHome(page);
    const afterCancel = inventory(workspaceDir);
    ctx.check('annuler avant tout dépôt ferme le funnel', closedEarly);
    ctx.check('annuler avant tout dépôt ne laisse rien dans le workspace', inventoryDiff(beforeCancel, afterCancel).added.length === 0, {
      diff: inventoryDiff(beforeCancel, afterCancel),
    });

    // --- Archive d'erreur non-enveloppe : refus lisible, pas de plantage ---
    events.setStep('erreur-non-enveloppe');
    const errorSource = smallestArchive(NON_ENVELOPE_ERROR_DIR);
    const errorZip = join(ctx.dir('entrées'), 'erreur-non-enveloppe.zip');
    copyFileSync(errorSource, errorZip);
    const beforeRefus = inventory(workspaceDir);
    await page.getByText('Modifier un pack existant', { exact: true }).click();
    const { dropFiles } = await import('../lib/drop.mjs');
    await dropFiles(page, '[data-funnel-drop]', [errorZip]);
    const refusalVisible = await page.locator('.funnel-error, [role="alert"]').first()
      .waitFor({ timeout: 120_000 }).then(() => true, () => false);
    await ctx.shot(page, 'refus-non-enveloppe');
    const refusalText = refusalVisible ? (await page.locator('.funnel-error, [role="alert"]').first().innerText()).trim() : null;
    ctx.check('archive d’erreur (non-enveloppe) : refus lisible affiché', refusalVisible, { refusalText });
    ctx.check('archive d’erreur (non-enveloppe) : aucun plantage', events.faults().length === 0, { faults: events.faults() });
    // Annulation depuis l'écran de refus : ne laisse rien derrière.
    const closedAfterRefusal = await closeFunnel(page);
    await goHome(page);
    const afterRefus = inventory(workspaceDir);
    ctx.check('annuler depuis l’écran de refus ferme le funnel', closedAfterRefusal);
    ctx.check('annuler depuis l’écran de refus ne laisse rien dans le workspace', inventoryDiff(beforeRefus, afterRefus).added.length === 0, {
      diff: inventoryDiff(beforeRefus, afterRefus),
    });

    // --- Enveloppe : liste, « Continuer » sans sélection, « Choisir une autre
    // archive », puis choix + Continuer jusqu'à l'éditeur. ---
    events.setStep('enveloppe');
    const envelopeSource = smallestArchive(ENVELOPE_DIR);
    const envelope = join(ctx.dir('entrées'), 'enveloppe.zip');
    copyFileSync(envelopeSource, envelope);
    const continuer = page.getByRole('button', { name: /Continuer/ }).first();
    const firstChild = page.locator('[role="radio"]').first();
    const openEnvelope = async () => {
      await dropFiles(page, '[data-funnel-drop]', [envelope]);
      return continuer.waitFor({ timeout: 240_000 }).then(() => true, () => false);
    };
    await page.getByText('Modifier un pack existant', { exact: true }).click();
    const listAppeared = await openEnvelope();
    await ctx.shot(page, 'enveloppe-liste');
    ctx.check('enveloppe : la liste des packs s’affiche', listAppeared);
    if (listAppeared) {
      ctx.check('enveloppe : « Continuer » désactivé sans sélection', await continuer.isDisabled());
      const hasChild = await firstChild.count() > 0;
      ctx.check('enveloppe : au moins un pack listé', hasChild);

      // « Choisir une autre archive » depuis la liste : retour à la zone de dépôt.
      await page.getByRole('button', { name: /Choisir une autre archive/ }).click();
      const backToCollect = await page.getByText('Dépose ton pack ici').waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await ctx.shot(page, 'enveloppe-retour');
      ctx.check('enveloppe : « Choisir une autre archive » revient à la zone de dépôt', backToCollect);

      const listAgain = backToCollect && await openEnvelope();
      ctx.check('enveloppe : la liste revient après un nouveau dépôt', listAgain);
      if (hasChild && listAgain) {
        await firstChild.click();
        ctx.check('enveloppe : « Continuer » activé après sélection', await continuer.isEnabled());

        // Choix + Continuer : l'enfant extrait reprend le parcours d'un pack
        // ordinaire. Un pack éditable par les deux éditeurs demande lequel ;
        // un pack « graphe seulement » atterrit sans question.
        await continuer.click();
        const chooser = modalWithText(page, 'Choisir l’éditeur');
        const generate = page.getByRole('button', { name: /Générer le pack/ }).first();
        const errorAfterContinue = page.locator('.funnel-error, [role="alert"]').first();
        let outcome = 'timeout';
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          if (await chooser.count()) { outcome = 'chooser'; break; }
          if (await generate.isVisible().catch(() => false)) { outcome = 'editor'; break; }
          if (await errorAfterContinue.count()) { outcome = 'error'; break; }
          await page.waitForTimeout(500);
        }
        await ctx.shot(page, 'enveloppe-apres-continuer');
        const errorText = outcome === 'error' ? (await errorAfterContinue.innerText()).trim() : null;
        ctx.check('enveloppe : pas de refus « sorti de son dossier temporaire »', outcome !== 'error' && outcome !== 'timeout', { outcome, errorText });
        if (outcome === 'chooser') {
          await chooser.getByRole('button', { name: 'Éditeur par menus', exact: true }).click();
        }
        const landed = outcome === 'chooser' || outcome === 'editor'
          ? await generate.waitFor({ timeout: 180_000 }).then(() => true, () => false)
          : false;
        const funnelGone = landed && await modalWithText(page, 'Modifier un pack').first()
          .waitFor({ state: 'hidden', timeout: 30_000 }).then(() => true, () => false);
        await ctx.shot(page, 'enveloppe-editeur');
        ctx.check('enveloppe : le pack choisi s’ouvre dans l’éditeur', landed, { outcome });
        ctx.check('enveloppe : la fenêtre « Modifier un pack » se ferme à l’atterrissage', funnelGone);
        ctx.check('enveloppe : aucune erreur console après le choix', events.faults().length === 0, { faults: events.faults() });
        if (landed) {
          await returnHome(page);
        }
      }
    }
    if (await modalWithText(page, 'Modifier un pack').count()) await closeFunnel(page);
    await goHome(page);
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
