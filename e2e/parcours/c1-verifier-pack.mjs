// « Vérifier un pack » : le funnel aboutit sur une archive du corpus ;
// si une correction est proposée, elle est dirigée vers le dossier du run
// (shim `save`) et le zip corrigé est relu (`readbackPack`). Annulation dès
// la collecte : rien n'est écrit.
import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { MODALS, clickButton, closeFunnel, goHome } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { smallestArchive } from '../lib/corpus.mjs';
import { readbackPack, inventory, inventoryDiff } from '../lib/oracles.mjs';

const EDITABLE_DIR = '01 - Editable';
// Repli si le premier candidat (le plus petit d'« Editable ») ne propose
// aucune correction automatique : cette catégorie est justement composée de
// packs déjà repérés comme perfectibles, donc plus susceptibles d'exercer le
// chemin d'écriture du zip corrigé.
const FALLBACK_DIR = join('02 - Lecture seule', 'Triage', '01 - Candidat hierarchie simple');

// Dépose puis analyse une archive dans le funnel déjà ouvert (à la collecte).
// Renvoie { reportVisible, canFix, primaryText }.
async function analyzeCandidate(ctx, page, events, zip, label) {
  events.setStep(`analyse-${label}`);
  await page.getByText('Vérifier un pack', { exact: true }).click();
  const { dropFiles } = await import('../lib/drop.mjs');
  // Le dépôt déclenche déjà l'analyse (onFiles → analyzePath) : pas besoin
  // de cliquer « Analyser ».
  await dropFiles(page, '[data-funnel-drop]', [zip]);
  const reportVisible = await page.getByText('Rapport', { exact: true }).first()
    .waitFor({ timeout: 180_000 }).then(() => true, () => false);
  await ctx.shot(page, `rapport-${label}`);
  ctx.check(`« Vérifier un pack » (${label}) aboutit à un rapport`, reportVisible);
  ctx.check(`aucune erreur console pendant l’analyse (${label})`, events.faults().length === 0, { faults: events.faults() });
  if (!reportVisible) return { reportVisible, canFix: false, primaryText: null };
  const primary = page.locator('.funnel-foot .funnel-btn-primary');
  const primaryText = (await primary.innerText()).trim();
  const canFix = /Corriger le pack/.test(primaryText);
  ctx.check(`une correction est proposée pour ce pack (${label})`, canFix ? true : null, { primaryText });
  return { reportVisible, canFix, primaryText };
}

export async function run() {
  const ctx = createRun('c1-verifier-pack');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];
  try {
    const source = smallestArchive(EDITABLE_DIR);
    const zip = join(ctx.dir('entrées'), 'pack à vérifier.zip');
    copyFileSync(source, zip);
    const outDir = ctx.dir('sortie');

    // --- Annulation dès la collecte : rien n'est écrit. ---
    events.setStep('annulation');
    await goHome(page);
    const beforeCancel = inventory(workspaceDir);
    await page.getByText('Vérifier un pack', { exact: true }).click();
    await page.waitForTimeout(500);
    const closed = await closeFunnel(page);
    await goHome(page);
    const afterCancel = inventory(workspaceDir);
    ctx.check('annuler dès la collecte ferme le funnel', closed);
    ctx.check('annuler dès la collecte ne laisse rien dans le workspace', inventoryDiff(beforeCancel, afterCancel).added.length === 0, {
      diff: inventoryDiff(beforeCancel, afterCancel),
    });

    // --- Le funnel aboutit (premier candidat : le plus petit d'« Editable ») ---
    let { canFix } = await analyzeCandidate(ctx, page, events, zip, 'candidat 1');

    // Repli : si ce candidat n'appelle aucune correction, en essayer un
    // second pour exercer aussi l'écriture du zip corrigé et sa relecture.
    if (!canFix) {
      const fallbackSource = smallestArchive(FALLBACK_DIR);
      const fallbackZip = join(ctx.dir('entrées'), 'pack à vérifier (2).zip');
      copyFileSync(fallbackSource, fallbackZip);
      await closeFunnel(page);
      await goHome(page);
      ({ canFix } = await analyzeCandidate(ctx, page, events, fallbackZip, 'candidat 2'));
    }

    {
      events.setStep('correction');
      if (canFix) {
        const primary = page.locator('.funnel-foot .funnel-btn-primary');
        await primary.click(); // step 1 → step 2 (« Voici ce qui va être corrigé »)
        await primary.waitFor({ timeout: 10_000 });
        await primary.click(); // step 2 : « Créer le pack corrigé » → ouvre les métadonnées
        const metaSubmit = page.getByRole('button', { name: 'Corriger le pack' });
        await metaSubmit.waitFor({ timeout: 15_000 });
        // Un titre manquant/à corriger désactive la soumission (« Titre du
        // pack » vide) : le remplir, comme le ferait un auteur, plutôt que
        // forcer un clic sur un bouton désactivé.
        if (await metaSubmit.isDisabled()) {
          const titleInput = page.getByPlaceholder('Titre du pack');
          if (await titleInput.count()) {
            await titleInput.fill('Pack corrigé (parcours C1)');
            await page.waitForTimeout(300);
          }
        }
        // Modifier le titre déclenche la boîte « Générer un nouvel UUID ? » :
        // la traverser (garder l'UUID d'origine), comme `generatePack`.
        const uuidPrompt = page.locator(MODALS).filter({ hasText: 'Générer un nouvel UUID' });
        if (await uuidPrompt.first().isVisible().catch(() => false)) {
          await clickButton(uuidPrompt.first(), /Conserver l.UUID actuel/);
          await page.waitForTimeout(300);
        }
        await ctx.shot(page, 'metadonnees-correction');
        const submittable = await metaSubmit.isEnabled();
        ctx.check('la fiche de métadonnées permet de soumettre la correction (titre renseigné)', submittable ? true : null, {
          detail: submittable ? undefined : 'bouton « Corriger le pack » resté désactivé malgré un titre renseigné — à arbitrer',
        });
        if (submittable) {
          await answerNext(page, 'open', outDir); // dossier de sortie (dialogue directory)
          await metaSubmit.click();
          const done = await page.getByText('Pack corrigé créé', { exact: true })
            .waitFor({ timeout: 180_000 }).then(() => true, () => false);
          await ctx.shot(page, 'pack-corrige');
          ctx.check('le pack corrigé est généré', done);
          if (done) {
            const listing = readdirSync(outDir).filter((name) => name.endsWith('.zip'));
            const fixedZip = listing.length ? join(outDir, listing[listing.length - 1]) : null;
            ctx.check('un zip corrigé a été écrit dans le dossier scripté', Boolean(fixedZip), { listing });
            if (fixedZip) {
              const readback = await readbackPack(page, fixedZip, ctx.dir('studio'));
              ctx.check('le zip corrigé est relu par l’app et accepté par STUdio', readback.ok, { readback });
            }
          }
        }
      }
    }
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
