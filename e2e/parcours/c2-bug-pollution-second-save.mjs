// Constat majeur : séquence [nouveau projet → média A hors workspace,
// copie activée → 1er Ctrl+S (Save As implicite, chemin scripté hors
// workspace) → préférence de copie désactivée → média B → 2e Ctrl+S] a été
// observée écrivant dans le VRAI workspace (`Documents\story-studio`) au lieu
// du workspace injecté par le test, alors qu'aucune des deux préférences ni
// aucun chemin scripté ne désigne cet endroit. Auto-nettoyage intégré : si le
// garde-fou détecte une pollution, ce parcours supprime lui-même les seuls
// fichiers qu'il a pu y écrire (noms préfixés par le nom de ce projet de
// test), puis échoue quand même le contrôle pour que le fait reste visible.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { synthTone, difficultPathsRoot } from '../lib/fixtures.mjs';
import { setCopyImportedFilesPreference, dropOnTree } from '../lib/c2-helpers.mjs';

const PROJECT_LABEL = 'c2-bug-pollution-second-save';

export async function run() {
  const ctx = createRun('c2-bug-pollution-second-save');
  const workspaceDir = ctx.dir('workspace');
  const difficult = difficultPathsRoot(ctx.dir('medias-difficiles'));
  const projectPath = join(ctx.dir('projet'), `${PROJECT_LABEL}.mbah`);
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  try {
    await newProject(page, 'pack');
    await setCopyImportedFilesPreference(page, true);
    const mediaA = synthTone(difficult.spaces, 'histoire avec espaces.wav', 440);
    await dropOnTree(page, mediaA);
    await ctx.shot(page, '01-media-A-copie-on');

    await answerNext(page, 'ask', true);
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    ctx.check('1er enregistrement écrit', existsSync(projectPath));
    const dialogsAfterFirst = await dialogLog(page);

    await setCopyImportedFilesPreference(page, false);
    const mediaB = synthTone(difficult.accents, 'histoire accentuée éà.wav', 620);
    await dropOnTree(page, mediaB);
    await ctx.shot(page, '02-media-B-copie-off');
    // Volontairement AUCUN dialogue posé ici : c'est exactement la séquence
    // « accidentelle » (un 2e Ctrl+S sans rien de spécial) qui a déclenché le
    // constat lors de son observation initiale.
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2500);
    const dialogsAfterSecond = await dialogLog(page);

    ctx.check('aucune erreur console pendant tout le parcours', events.faults().length === 0, { faults: events.faults() });
    ctx.check(
      '[relevé] dialogLog complet (defaultPath de chaque boîte, à comparer au workspace injecté)',
      true,
      { workspaceDir, dialogsAfterFirst, dialogsAfterSecond },
    );
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop();
    if (stop.polluted.length > 0) {
      const removed = [];
      for (const path of stop.polluted) {
        if (path.includes(PROJECT_LABEL) || /histoire avec espaces|histoire accentu/i.test(path)) {
          try { unlinkSync(path); removed.push(path); } catch { /* laissé pour inspection manuelle */ }
        }
      }
      ctx.check(
        '[constat CRITIQUE] écriture détectée dans le vrai workspace (voir detail) — auto-nettoyage tenté',
        false,
        { polluted: stop.polluted, removed },
      );
    } else {
      ctx.check('rien écrit dans le vrai workspace cette fois (le constat peut être intermittent)', true);
    }
  }
  return ctx.finish();
}
