// Faits relevés (pas des verdicts) sur un projet minimal construit
// par le script (Éditeur par menus) :
//   - un dossier vide fait-il refuser la simulation « Simuler depuis ici » ?
//   - une histoire dont le fichier audio a disparu (« un fichier que le disque
//     ne rend plus », cf. commentaire de `FlatSimulator.jsx`) se joue-t-elle
//     en silence, ou bloque-t-elle l'écoute ?
//
// Pour le second fait : une histoire construite à la main (dépôt d'un seul
// fichier) reste incomplète (deux champs audio distincts — « Audio de
// sélection » et « Histoire complète » — dont un seul se remplit par un
// simple dépôt sur l'arbre), ce qui fait refuser la projection pour une tout
// autre raison (« … à corriger ») que celle qu'on veut observer. On préfère
// donc une archive corpus **complète et valide**, dont on retire ensuite un
// asset audio à la pince (7z) avant de la poser dans l'arbre et de la
// simuler : c'est exactement le chemin de code visé (`get_pack_asset` échoue
// sur un nom d'entrée absent du zip), sans dépendre d'un projet à moitié
// construit.
import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject } from '../lib/actions.mjs';
import { smallestArchive } from '../lib/corpus.mjs';
import { invokeTauri } from '../lib/oracles.mjs';
import { dropFiles } from '../lib/drop.mjs';
import { REPO_DIR } from '../lib/config.mjs';
import { waitForSimulator, closeSimulator, readStageState, DEFAULT_SCRIPT, runTrace } from '../lib/simulator.mjs';

const SEVEN_ZIP = join(REPO_DIR, 'src-tauri', 'tools', '7z.exe');

export async function run() {
  const ctx = createRun('c3b-faits');
  const workspaceDir = ctx.dir('workspace');
  const mediaDir = ctx.dir('medias');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page } = app;
  const allFaults = [];

  try {
    await newProject(page, 'pack');
    await ctx.shot(page, '01-nouveau-projet');

    // ---- Dossier vide : « Simuler depuis ici » ----
    const addFolder = page.locator('[data-media-tool="add-folder"]').first();
    await addFolder.waitFor({ timeout: 15_000 });
    await addFolder.click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape').catch(() => {}); // sort d'un éventuel renommage inline
    const folderRow = page.locator('.tree-item--menu').first();
    const folderFound = await folderRow.count() > 0;
    ctx.check('un dossier vide a bien été créé', folderFound);
    if (folderFound) {
      await folderRow.click({ button: 'right' });
      const menu = page.locator('.ctx-menu');
      await menu.waitFor({ timeout: 5_000 });
      const item = menu.getByRole('menuitem', { name: /Simuler depuis ici/ }).first();
      const itemDisabled = await item.getAttribute('aria-disabled').catch(() => null);
      await item.click({ force: true });
      await page.waitForTimeout(1500);
      await ctx.shot(page, '02-apres-simuler-dossier-vide');
      const simOpen = await page.locator('.lunii-sim').first().count() > 0;
      const noticeEl = page.locator('.floating-simulator-notice, .floating-simulator').first();
      const noticeText = await noticeEl.innerText().catch(() => null);
      let stateIfOpen = null;
      if (simOpen) stateIfOpen = await readStageState(page);
      ctx.check(
        'fait : dossier vide + « Simuler depuis ici » (relevé, pas un verdict — refus, notice, ou démarrage silencieux depuis la racine ?)',
        true,
        { menuItemDisabled: itemDisabled, simulatorOpened: simOpen, noticeText, stateIfOpen },
      );
      if (simOpen) await closeSimulator(page).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }

    // ---- Histoire dont l'audio a disparu (asset retiré d'une copie de zip) ----
    const source = smallestArchive('01 - Editable');
    const copyDir = ctx.dir('pack-source');
    const originalCopy = join(copyDir, 'original.zip');
    const corruptedCopy = join(copyDir, 'corrompu.zip');
    copyFileSync(source, originalCopy);
    copyFileSync(source, corruptedCopy);

    const rawStory = JSON.parse(await invokeTauri(page, 'load_pack_zip', { zipPath: originalCopy }));
    const audioStage = (rawStory.stageNodes ?? []).find((s) => s.audio);
    ctx.check('l’archive corpus choisie porte au moins un Écran audio', Boolean(audioStage), {
      assetName: audioStage?.audio ?? null,
    });

    if (audioStage) {
      const del = spawnSync(SEVEN_ZIP, ['d', corruptedCopy, `assets/${audioStage.audio}`], { encoding: 'utf8' });
      ctx.check('l’asset audio a bien été retiré de la copie (7z d)', del.status === 0, {
        assetName: audioStage.audio, stdout: del.stdout?.slice(-500), stderr: del.stderr?.slice(-500),
      });

      // Baseline : la copie intacte se joue normalement (tree drop + « Simuler
      // ce pack… », même geste que la parité menus).
      await dropFiles(page, '[data-os-drop-zone="treepanel"]', [originalCopy]);
      await page.waitForTimeout(2000);
      let zipNode = page.locator('.tree-item--zip').last();
      await zipNode.waitFor({ timeout: 15_000 });
      await zipNode.click({ button: 'right' });
      let menu = page.locator('.ctx-menu');
      await menu.waitFor({ timeout: 5_000 });
      await menu.getByRole('menuitem', { name: /Simuler ce pack/ }).first().click();
      await waitForSimulator(page);
      const baselineTrace = await runTrace(page, DEFAULT_SCRIPT.slice(0, 6));
      await ctx.shot(page, '03-pack-intact-simule');
      const baselineHadAudio = baselineTrace.steps.some((s) => s.after.playbackVisible);
      ctx.check('fait : la copie intacte de l’archive joue au moins un son sur les premiers pas', baselineHadAudio, {
        steps: baselineTrace.steps.map((s) => ({ title: s.after.title, playbackVisible: s.after.playbackVisible })),
      });
      await closeSimulator(page).catch(() => {});
      await page.waitForTimeout(300);

      // La copie corrompue (asset manquant) posée dans le même arbre, puis simulée.
      await dropFiles(page, '[data-os-drop-zone="treepanel"]', [corruptedCopy]);
      await page.waitForTimeout(2000);
      zipNode = page.locator('.tree-item--zip').last();
      await zipNode.waitFor({ timeout: 15_000 });
      await zipNode.click({ button: 'right' });
      menu = page.locator('.ctx-menu');
      await menu.waitFor({ timeout: 5_000 });
      await menu.getByRole('menuitem', { name: /Simuler ce pack/ }).first().click();
      const opened = await waitForSimulator(page).then(() => true, () => false);
      const trace = opened ? await runTrace(page, DEFAULT_SCRIPT.slice(0, 8), { autoWaitMs: 6_000 }) : null;
      await ctx.shot(page, '04-pack-asset-manquant-simule');
      ctx.check(
        'fait : archive avec asset audio manquant — la simulation s’ouvre quand même et n’hurle pas indéfiniment (pas de blocage réel)',
        opened && trace?.stuckAt === null,
        {
          opened,
          stuckAt: trace?.stuckAt ?? null,
          steps: trace?.steps.map((s) => ({ requested: s.requested, executed: s.executed, title: s.after.title, playbackVisible: s.after.playbackVisible })),
        },
      );
      if (opened) await closeSimulator(page).catch(() => {});
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...app.events.faults());
    ctx.check('aucune erreur console ni exception cumulée', allFaults.length === 0, { faultsTotal: allFaults.length, faults: allFaults.slice(0, 20) });
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }

  return ctx.finish();
}
