// Parcours de fumée : prouve que la boîte à outils tient debout sur l'app
// réelle, et que ses oracles savent dire non.
//
// Pack synthétique du dépôt (profil `export-mvp` de
// `scripts/advanced-export-fixtures.mjs`), fabriqué à chaque run pour ne
// jamais rejouer une archive périmée restée sur le disque : aucune donnée
// personnelle. Étapes : import (éditeur par menus) → génération → relecture
// app + STUdio → contre-épreuve sur une archive tronquée → enregistrement →
// rechargement → réouverture par les récents → seconde génération identique.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProfile } from '../../scripts/advanced-export-fixtures.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { generatePack, goHome, importPack } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { readbackPack, samePackContent } from '../lib/oracles.mjs';
import { repairGraphEndings } from '../lib/c4-helpers.mjs';

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export async function run() {
  const ctx = createRun('fumee');
  const source = join(ctx.dir('entrées'), 'pack de fumée é.zip');
  writeFileSync(source, buildProfile('export-mvp').zip);
  const outDir = ctx.dir('sortie à accents');
  const projectPath = join(ctx.dir('projet enregistré'), 'Projet de fumée.mbah');

  const workspaceDir = ctx.dir('workspace');
  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;
  const allFaults = [];
  try {
    events.setStep('accueil');
    await goHome(page);
    await ctx.shot(page, 'accueil');
    ctx.check('accueil affiché sans erreur', events.faults().length === 0);

    events.setStep('import');
    await importPack(page, source, { editor: 'graphe' });
    await ctx.shot(page, 'editeur');
    ctx.check('pack ouvert dans un éditeur', true);

    const endings = await repairGraphEndings(page);
    ctx.check('la fin synthétique accessible réparée par « En faire une fin »', endings.repaired === 1 && endings.remaining === 0, endings);

    events.setStep('generation-1');
    const first = await generatePack(page, outDir, { uuid: 'keep' });
    await ctx.shot(page, 'apres-generation-1');
    ctx.check('archive produite', Boolean(first.zip), first);
    const exportDialog = (await dialogLog(page)).find(entry => entry.kind === 'open');
    ctx.check('dossier de sortie demandé par l’app', Boolean(exportDialog), { defaultPath: exportDialog?.args?.[0]?.defaultPath });

    if (first.zip) {
      const readback = await readbackPack(page, first.zip, ctx.dir('studio-1'));
      ctx.check('archive relue par l’app et acceptée par STUdio', readback.ok, { readback });

      // Contre-épreuve : un oracle qui ne sait pas dire non ne prouve rien.
      const broken = join(ctx.dir('contre-epreuve'), 'tronquée.zip');
      const bytes = readFileSync(first.zip);
      writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));
      const negative = await readbackPack(page, broken, ctx.dir('studio-contre-epreuve'));
      ctx.check('contre-épreuve : archive tronquée refusée', negative.ok === false, { negative });
    }

    events.setStep('enregistrement');
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    ctx.check('projet enregistré à l’emplacement choisi', existsSync(projectPath));
    await ctx.shot(page, 'apres-enregistrement');

    // Réouverture comme un utilisateur : fermer l'app, la relancer (même
    // profil e2e), rouvrir le projet depuis les récents de l'accueil.
    events.setStep('reouverture');
    allFaults.push(...events.faults());
    const firstStop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace (1er lancement)', firstStop.polluted.length === 0, { polluted: firstStop.polluted });
    app = await launchApp({ runDir: ctx.dir('relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    await goHome(page);
    const recent = page.locator('button.mode-proj-row').first();
    const hasRecent = await recent.count() > 0;
    ctx.check('le projet figure dans les récents', hasRecent);
    if (hasRecent) {
      await recent.click();
      const ready = await page.locator('button:enabled').filter({ hasText: /Générer le pack/ }).first()
        .waitFor({ timeout: 120_000 }).then(() => true, () => false);
      await ctx.shot(page, 'reouverture');
      ctx.check('éditeur prêt après réouverture (« Générer le pack » actif en moins de 2 min)', ready);
      if (!ready) throw new Error('Éditeur non prêt après réouverture');

      events.setStep('generation-2');
      const second = await generatePack(page, outDir, { uuid: 'keep' });
      ctx.check('seconde archive produite', Boolean(second.zip), second);
      if (first.zip && second.zip) {
        const content = samePackContent(first.zip, second.zip);
        ctx.check('enregistrer / rouvrir / regénérer donne le même contenu d’archive', content.same, {
          differences: content.differences,
          sameBytes: sha256(first.zip) === sha256(second.zip),
        });
        // Contre-épreuve : le pack source, lui, diffère de l'archive produite.
        ctx.check('contre-épreuve : la comparaison voit une archive différente', !samePackContent(first.zip, source).same);
      }
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false);
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception sur tout le parcours', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    ctx.check('rien d’écrit dans le vrai workspace', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }
  return ctx.finish({ dialogs: undefined });
}
