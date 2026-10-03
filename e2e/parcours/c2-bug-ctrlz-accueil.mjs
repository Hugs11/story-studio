// Non-régression : le choix initial du type ne fait pas partie de
// l'historique. Ctrl+Z juste après création/enregistrement conserve donc
// l'éditeur, et le Ctrl+S suivant conserve exactement le fichier valide.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, projectMenuButton } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';

export async function run() {
  const ctx = createRun('c2-bug-ctrlz-accueil');
  const workspaceDir = ctx.dir('workspace');
  const projectPath = join(ctx.dir('projet'), 'Projet C2 (bug Ctrl+Z).mbah');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  try {
    // 1. Nouveau projet, premier enregistrement (hors workspace, chemin scripté).
    await newProject(page, 'pack');
    await ctx.shot(page, '01-nouveau-projet');
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(3000);
    ctx.check('le projet est bien enregistré une première fois', existsSync(projectPath));
    const contentAfterFirstSave = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : '';
    const firstParsed = contentAfterFirstSave ? JSON.parse(contentAfterFirstSave) : null;
    ctx.check('le fichier contient un projectType et un uuid après le 1er enregistrement', firstParsed?.projectType === 'pack' && !!firstParsed?.packMetadata?.uuid, { firstParsed });

    // 2. Ctrl+Z : rien à annuler à ce stade (aucune modification depuis la création).
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(800);
    await ctx.shot(page, '02-apres-ctrl-z');
    const backAtHome = await page.getByText('Modifier un pack existant').first().isVisible().catch(() => false);
    const editorStillThere = await projectMenuButton(page).count();
    ctx.check(
      'Ctrl+Z juste après création conserve l’éditeur (aucune étape initiale à annuler)',
      !backAtHome && editorStillThere > 0,
      { backAtHome, editorStillThere },
    );

    // 3. Ctrl+S « accidentel » ensuite, sans dialogue posé (aucun n'est attendu
    // si l'app est cohérente à l'accueil ; le fait qu'il se passe quelque chose
    // sur le fichier déjà enregistré est justement le constat).
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2500);
    const log = await dialogLog(page);
    const contentAfterCtrlS = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : '';
    const secondParsed = contentAfterCtrlS ? JSON.parse(contentAfterCtrlS) : null;
    ctx.check(
      'Ctrl+S après ce Ctrl+Z conserve à l’octet près le fichier valide',
      contentAfterCtrlS === contentAfterFirstSave
        && secondParsed?.projectType === 'pack'
        && !!secondParsed?.packMetadata?.uuid,
      { secondParsed, dialogLogAfter: log },
    );
    await ctx.shot(page, '03-apres-ctrl-s-accidentel');

    ctx.check('aucune erreur console pendant tout le parcours', events.faults().length === 0, { faults: events.faults() });
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop();
    ctx.check('rien écrit dans le vrai workspace (garde-fou)', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}
