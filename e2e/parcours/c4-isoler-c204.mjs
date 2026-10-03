// Isolation d'un défaut : premier enregistrement en mode graphe
// silencieusement en échec après [dépôt de média + bascule de préférence]).
//
// Fait varier UN facteur à la fois, deux fois chacun, dans une fenêtre neuve à
// chaque tentative (comme la Phase A/B de `c2-graphe.mjs` : un enchaînement
// « reprise → retour accueil → nouveau projet » dans la MÊME fenêtre a déjà
// fait échouer silencieusement un enregistrement suivant sans rapport avec la
// cause cherchée ici — l'isolation évite de mélanger les deux).
//
// (a) dépôt de média seul ; (b) bascule de préférence seule ; (c) les deux ;
// (d) projet graphe neuf vide (témoin, déjà confirmé sain) ; (e) projet graphe
// issu d'un import.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, importPack } from '../lib/actions.mjs';
import { answerNext, dialogLog } from '../lib/dialogs.mjs';
import { synthTone } from '../lib/fixtures.mjs';
import {
  setCopyImportedFilesPreference,
  dropOnMediaExplorer,
  keepSessionMediaIfPrompted,
} from '../lib/c2-helpers.mjs';
import { ipcErrors, tauriLogErrors } from '../lib/c4-helpers.mjs';
import { smallestArchive } from '../lib/corpus.mjs';

const VARIANTS = [
  { id: 'a-media-seul', label: 'dépôt de média seul' },
  { id: 'b-preference-seule', label: 'bascule de préférence seule' },
  { id: 'c-media-et-preference', label: 'média + bascule de préférence' },
  { id: 'd-neuf-vide', label: 'projet graphe neuf, vide' },
  { id: 'e-issu-import', label: 'projet graphe issu d’un import' },
];
const ATTEMPTS_PER_VARIANT = 2;

async function runAttempt(ctx, variant, attemptNumber) {
  const attemptDir = ctx.dir(variant.id, `tentative-${attemptNumber}`);
  const workspaceDir = join(attemptDir, 'workspace');
  // `fresh: true` : chaque tentative part d'un profil e2e vierge (aucun
  // récent d'une tentative précédente), condition de la vraie isolation
  // recherchée par ce parcours — sans quoi un récent nommé identiquement
  // (même libellé « Projet C4 isolation ») fait échouer `newProject()` sur les
  // tentatives suivantes (collision de texte entre la tuile de mode et le
  // sous-titre de la ligne récente, cf. `actions.mjs`).
  const app = await launchApp({ runDir: attemptDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const detail = { variant: variant.id, attempt: attemptNumber };
  try {
    events.setStep(`${variant.id}-${attemptNumber}`);
    let archive = null;
    if (variant.id === 'e-issu-import') {
      archive = smallestArchive('01 - Editable');
      await importPack(page, archive, { editor: 'graphe' });
    } else {
      await newProject(page, 'advanced');
    }

    if (variant.id === 'b-preference-seule' || variant.id === 'c-media-et-preference') {
      await setCopyImportedFilesPreference(page, true);
    }
    if (variant.id === 'a-media-seul' || variant.id === 'c-media-et-preference') {
      const media = synthTone(ctx.dir(variant.id, 'medias'), `media-${attemptNumber}.wav`, 880);
      await dropOnMediaExplorer(page, media);
    }

    await ctx.shot(page, `${variant.id}-${attemptNumber}-avant-enregistrement`);

    const projectPath = join(ctx.dir(variant.id, `tentative-${attemptNumber}`, 'projet'), 'Projet C4 isolation.mbah');
    await answerNext(page, 'save', projectPath);
    await page.keyboard.press('Control+s');
    await keepSessionMediaIfPrompted(page);
    await page.waitForTimeout(3000);
    const saveLog = (await dialogLog(page)).filter((entry) => entry.kind === 'save');
    const written = existsSync(projectPath);
    if (!written) {
      // Un second essai, comme dans `c2-graphe.mjs` (focus reparti sur le
      // canvas) : un champ resté focus a pu absorber le premier Ctrl+S.
      await page.locator('.diagram-canvas, .rf-canvas, main').first().click({ position: { x: 20, y: 20 } }).catch(() => {});
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(3000);
    }
    await ctx.shot(page, `${variant.id}-${attemptNumber}-apres-ctrls`);

    const titleBarDirty = await page.locator('[data-toolbar-id="project-menu"]').innerText().catch(() => null);

    detail.archive = archive ? archive.split(/[\\/]/).pop() : null;
    detail.dialogLog = saveLog;
    detail.fileWritten = existsSync(projectPath);
    detail.fileSizeBytes = detail.fileWritten ? (await import('node:fs')).statSync(projectPath).size : null;
    detail.consoleFaults = events.faults();
    detail.ipcErrors = ipcErrors(events);
    detail.titleBarAfterSave = titleBarDirty;
    ctx.check(
      `[${variant.label}] tentative ${attemptNumber} — .mbah écrit après Ctrl+S`,
      detail.fileWritten,
      detail,
    );
  } catch (error) {
    ctx.check(`[${variant.label}] tentative ${attemptNumber} — parcours interrompu : ${error.message}`, false, { stack: error.stack, ...detail });
  } finally {
    const stop = await app.stop();
    detail.logErrors = tauriLogErrors(attemptDir);
    ctx.check(
      `[${variant.label}] tentative ${attemptNumber} — rien écrit dans le vrai workspace`,
      stop.polluted.length === 0,
      { polluted: stop.polluted },
    );
    if (detail.logErrors.length) {
      ctx.check(`[${variant.label}] tentative ${attemptNumber} — lignes ERROR dans tauri-dev.log`, null, { logErrors: detail.logErrors });
    }
  }
  return detail;
}

export async function run() {
  const ctx = createRun('c4-isoler-c204');
  const results = [];
  for (const variant of VARIANTS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_VARIANT; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const detail = await runAttempt(ctx, variant, attempt);
      results.push({ variant: variant.id, attempt, ...detail });
    }
  }

  const byVariant = {};
  for (const variant of VARIANTS) {
    const attempts = results.filter((r) => r.variant === variant.id);
    byVariant[variant.id] = {
      label: variant.label,
      writtenCount: attempts.filter((a) => a.fileWritten).length,
      total: attempts.length,
    };
  }
  ctx.check('résumé des 5 variantes (2 tentatives chacune) — voir extra.byVariant', true, { byVariant });

  return ctx.finish({ results, byVariant });
}
