// Diagnostic ponctuel : pour un pack qui génère en Éditeur par menus
// mais dont le bouton « Générer le pack » reste désactivé en Éditeur graphe,
// ouvre la liste « à corriger » (pastille `toggleValidation`) et relève son
// contenu tel quel (fait, sans jugement sur le bien-fondé de la règle).
//
// Usage : node e2e/run.mjs c3a-diag-corriger <indices séparés par virgule>
// (indices dans l'échantillon Editable de 20, même construction que
// `c3a-corpus` : jamais de nom de pack réel dans ce fichier.)
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { importPack, returnHome } from '../lib/actions.mjs';
import { spreadArchives } from '../lib/corpus.mjs';

const EDITABLE_DIR = '01 - Editable';

export async function run(args = []) {
  const indices = (args[0] || '6,10,11').split(',').map(Number);
  const ctx = createRun('c3a-diag-corriger');
  const workspaceDir = ctx.dir('workspace');
  const sample = spreadArchives(EDITABLE_DIR, 20, { minExt: { ext: '7z', count: 3 } });

  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page } = app;
  const results = [];
  try {
    for (const index of indices) {
      const sourcePath = sample[index];
      const ext = sourcePath.slice(sourcePath.lastIndexOf('.'));
      const copyDir = ctx.dir('entrées', String(index));
      const copy = join(copyDir, `pack${ext}`);
      copyFileSync(sourcePath, copy);
      await importPack(page, copy, { editor: 'graphe' });
      await page.waitForTimeout(2000); // laisse le temps à la validation de se stabiliser
      const pill = page.locator('[data-toolbar-id="toggleValidation"]');
      const pillText = await pill.innerText().catch(() => null);
      await pill.click();
      const dropdown = page.locator('[aria-label="Liste des éléments à corriger"]');
      const opened = await dropdown.waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const listText = opened ? await dropdown.innerText().catch(() => null) : null;
      await ctx.shot(page, `idx${index}-a-corriger`);
      results.push({ index, sourceName: sourcePath.split(/[\\/]/).pop(), pillText, opened, listText });
      ctx.check(`idx${index} : liste « à corriger » relevée`, opened, { pillText, listText });
      await returnHome(page).catch(() => {});
    }
  } catch (error) {
    ctx.check(`diagnostic interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish({ results });
}
