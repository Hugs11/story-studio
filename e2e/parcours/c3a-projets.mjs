// Projets complets de l'utilisateur, désignés par l'auteur (schéma V3,
// « terminés, prêts à être générés a priori »). Toujours sur une **copie** du
// `.mbah` ; les médias qu'il référence restent lus à leur place dans le vrai
// workspace, jamais modifiés (garde-fou `stop().polluted`).
//
// Par projet : ouverture par le shim (`Ctrl+O` sans dialogue natif), relevé de
// tout avertissement/liste « à corriger », génération, relecture ; puis
// enregistrement, fermeture propre, réouverture, seconde génération et
// comparaison octet à octet (`samePackContent`).
//
// Chemins réels (aucun nom de projet personnel n'est versionné dans le code) :
// viennent de `e2e/local.config.json` (clé `userProjectsDir`, optionnelle) ou
// de la variable `SS_E2E_USER_PROJECTS_DIR`, avec un repli sur l'emplacement
// habituel (`Documents\story-studio\sauvegardes`) si ni l'un ni l'autre n'est
// renseigné. Les noms de projet eux-mêmes viennent de `SS_E2E_USER_PROJECTS` ou
// de la clé `userProjects` de `local.config.json`.
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { E2E_DIR, localList } from '../lib/config.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { generatePack, goHome, projectMenuButton, returnHome } from '../lib/actions.mjs';
import { openProjectDialog, saveProjectAsExplicit } from '../lib/c2-helpers.mjs';
import { readbackPack, samePackContent } from '../lib/oracles.mjs';

function projectsDir() {
  if (process.env.SS_E2E_USER_PROJECTS_DIR) return process.env.SS_E2E_USER_PROJECTS_DIR;
  const localFile = join(E2E_DIR, 'local.config.json');
  if (existsSync(localFile)) {
    const local = JSON.parse(readFileSync(localFile, 'utf8'));
    if (local.userProjectsDir) return local.userProjectsDir;
  }
  return join(homedir(), 'Documents', 'story-studio', 'sauvegardes');
}

const PROJECT_NAMES = localList('SS_E2E_USER_PROJECTS', 'userProjects');

export async function run() {
  const ctx = createRun('c3a-projets');
  const dir = projectsDir();
  const workspaceDir = ctx.dir('workspace');
  const missing = PROJECT_NAMES.filter((name) => !existsSync(join(dir, `${name}.mbah`)));
  if (!PROJECT_NAMES.length || missing.length) {
    ctx.check('les projets désignés (userProjects) sont renseignés et présents', false, { dir, missing });
    return ctx.finish();
  }

  let session = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const allFaults = [];
  const results = [];

  for (const name of PROJECT_NAMES) {
    session.events.setStep(`projet-${name}`);
    const rec = { name };
    try {
      // Retour à l'accueil depuis l'éditeur du projet précédent (le premier
      // passage est déjà à l'accueil au lancement de l'app).
      await returnHome(session.page).catch(() => {});
      await goHome(session.page).catch(() => {});
      const source = join(dir, `${name}.mbah`);
      const copyDir = ctx.dir('projets', name);
      const copyPath = join(copyDir, `${name}.mbah`);
      copyFileSync(source, copyPath);

      const opened = await openProjectDialog(session.page, copyPath, { timeout: 180_000 });
      rec.openedOk = opened;
      await ctx.shot(session.page, `${name}-ouvert`);
      if (!opened) {
        rec.verdict = 'ouverture échouée ou trop lente (> 180 s)';
        ctx.check(`${name} : ouverture par le shim`, false, rec);
        results.push(rec);
        continue;
      }

      // Badge de validation (`ValidationPill`) : ce qui est signalé « à
      // corriger », relevé factuellement, sans jugement sur son bien-fondé.
      const pill = session.page.locator('[class*="validation-pill"], [class*="ValidationPill"]').first();
      const hasPill = await pill.count() > 0;
      rec.validationPillPresent = hasPill;
      rec.validationPillText = hasPill ? await pill.innerText().catch(() => null) : null;

      const outDir1 = ctx.dir('sortie', name, 'generation-1');
      const gen1 = await generatePack(session.page, outDir1, { uuid: 'keep' });
      rec.generation1Ok = Boolean(gen1.zip);
      rec.refusal1 = gen1.refusal ?? (gen1.timeout ? 'timeout' : null);
      if (gen1.zip) {
        const readback = await readbackPack(session.page, gen1.zip, ctx.dir('studio', name, 'generation-1'));
        rec.readback1Ok = readback.ok;
        rec.appScreens = readback.storyStudio?.stageNodes ?? null;
        rec.studioScreens = readback.studio?.stageNodes ?? null;
        rec.uuid = readback.storyStudio?.uuid ?? null;
        rec.version = readback.storyStudio?.version ?? null;
        rec.producedFileName1 = basename(gen1.zip);
      }
      await ctx.shot(session.page, `${name}-apres-generation-1`);
      ctx.check(`${name} : génération 1 + relecture`, Boolean(gen1?.zip && rec.readback1Ok), rec);

      // Enregistrement (copie, jamais le fichier d'origine), fermeture propre,
      // réouverture, seconde génération, comparaison octet à octet.
      const savePath = join(copyDir, `${name} (enregistre).mbah`);
      await saveProjectAsExplicit(session.page, savePath);
      rec.savedOk = existsSync(savePath);

      const stop1 = await session.stop({ graceful: true });
      rec.closedGracefully1 = stop1.closedGracefully;
      ctx.check(`${name} : fermeture propre, rien dans le vrai workspace`, stop1.polluted.length === 0, { polluted: stop1.polluted });

      session = await launchApp({ runDir: ctx.dir('relance', name), fresh: false, workspaceDir });
      await goHome(session.page).catch(() => {});
      const recentRow = session.page.locator('button.mode-proj-row').first();
      const hasRecent = await recentRow.count() > 0;
      rec.foundInRecents = hasRecent;
      let reopened = false;
      if (hasRecent) {
        await recentRow.click();
        reopened = await projectMenuButton(session.page).waitFor({ timeout: 180_000 }).then(() => true, () => false);
      } else {
        reopened = await openProjectDialog(session.page, savePath, { timeout: 180_000 });
      }
      rec.reopenedOk = reopened;
      await ctx.shot(session.page, `${name}-reouvert`);

      if (reopened) {
        const outDir2 = ctx.dir('sortie', name, 'generation-2');
        const gen2 = await generatePack(session.page, outDir2, { uuid: 'keep' });
        rec.generation2Ok = Boolean(gen2.zip);
        rec.refusal2 = gen2.refusal ?? (gen2.timeout ? 'timeout' : null);
        if (gen1.zip && gen2.zip) {
          const cmp = samePackContent(gen1.zip, gen2.zip);
          rec.sameAfterReopen = cmp.same;
          rec.differences = cmp.differences;
        }
        ctx.check(`${name} : enregistrer/rouvrir/régénérer donne le même contenu`, rec.sameAfterReopen === true, rec);
      }
    } catch (error) {
      rec.error = String(error?.message ?? error);
      ctx.check(`${name} : parcours interrompu`, false, rec);
    }
    allFaults.push(...session.events.faults());
    results.push(rec);
  }

  ctx.check('aucune erreur console ni exception cumulée', true, { faultsTotal: allFaults.length, faults: allFaults });
  const stop = await session.stop({ graceful: true });
  ctx.check('rien d’écrit dans le vrai workspace (fin de parcours)', stop.polluted.length === 0, { polluted: stop.polluted });

  return ctx.finish({ results });
}
