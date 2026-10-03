// Diagnostic ponctuel : qualifie un « timeout » de génération observé
// dans `c3a-corpus` (outillage qui attend à tort, ou vrai blocage applicatif ?).
// Rejoue UN seul pack (choisi par index dans le même échantillon reproductible
// que `c3a-corpus`, jamais par nom réel) dans l'éditeur donné, et prend une
// capture toutes les 15 s pendant l'attente de `generatePack`, jusqu'à un
// plafond court (par défaut 150 s, bien en-deçà des 600 s du vrai timeout) :
// assez pour voir si l'interface progresse (animation, texte qui change) ou
// reste figée à l'identique d'une capture à l'autre.
//
// Usage : node e2e/run.mjs c3a-diag-timeout <editable|lecture-seule> <index> <menus|graphe>
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { closeFunnel, importPack, MODALS } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { spreadArchives } from '../lib/corpus.mjs';

const EDITABLE_DIR = '01 - Editable';
const READONLY_DIR = '02 - Lecture seule';

export async function run(args = []) {
  const [category = 'editable', indexArg = '4', editor = 'graphe'] = args;
  const index = Number(indexArg);
  const ctx = createRun('c3a-diag-timeout');
  const workspaceDir = ctx.dir('workspace');
  const dir = category === 'lecture-seule' ? READONLY_DIR : EDITABLE_DIR;
  // Même construction que `spreadArchives` de `c3a-corpus`, pour retomber sur
  // le même pack qu'un index donné par `c3a-corpus` (20 pour Editable, 10 pour
  // Lecture seule, 3 `.7z` minimum côté Editable).
  const sample = spreadArchives(dir, category === 'lecture-seule' ? 10 : 20, category === 'lecture-seule' ? undefined : { minExt: { ext: '7z', count: 3 } });
  const sourcePath = sample[index];

  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  try {
    const copy = join(ctx.dir('entrée'), `pack${extnameOf(sourcePath)}`);
    mkdirSync(ctx.dir('entrée'), { recursive: true });
    copyFileSync(sourcePath, copy);
    await importPack(page, copy, { editor });
    await ctx.shot(page, 'editeur-affiche');
    // Le funnel parti, l'Éditeur graphe lit encore son document et qualifie
    // le pack : « Générer le pack » reste éteint, et Ctrl+G sans effet, tant
    // que cette première lecture n'est pas publiée. Mesurer ce délai plutôt
    // que presser Ctrl+G sur un bouton seulement visible.
    const readyStarted = Date.now();
    const genReady = page.getByRole('button', { name: /Générer le pack/ }).first();
    // Le bouton peut s'allumer un instant avant que la vérification du pack
    // ne le rééteigne (« Vérification… ») : on n'accepte qu'un état actif
    // sans interruption pendant 1 s, dans le même plafond de 60 s.
    let activeSince = null;
    while (Date.now() - readyStarted < 60_000) {
      if (await genReady.isEnabled().catch(() => false)) {
        activeSince ??= Date.now();
        if (Date.now() - activeSince >= 1_000) break;
      } else {
        activeSince = null;
      }
      await page.waitForTimeout(100);
    }
    const readyAfterMs = Date.now() - readyStarted;
    ctx.check('« Générer le pack » actif après le retrait du funnel (≤ 60 s)', await genReady.isEnabled().catch(() => false), { readyAfterMs });
    await ctx.shot(page, 'editeur-pret');

    const outDir = ctx.dir('sortie');
    await answerNext(page, 'open', outDir);
    await page.keyboard.press('Control+g');
    await ctx.shot(page, 'apres-ctrl-g');

    const applyBtn = page.locator('button:visible').filter({ hasText: /Appliquer\s*&\s*générer/ }).first();
    const applyVisible = await applyBtn.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    ctx.check('fiche du pack affichée après Ctrl+G', applyVisible);
    if (applyVisible) {
      await applyBtn.click();
      ctx.check('« Appliquer & générer » cliqué', true);
    } else {
      ctx.check('« Appliquer & générer » cliqué', false, { detail: 'bouton jamais apparu : Ctrl+G n’a pas ouvert la fiche' });
    }
    const revision = page.locator(MODALS).filter({ hasText: 'Nouvelle révision' });
    if (await revision.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
      await revision.getByRole('button', { name: /Garder l.UUID d.origine/ }).click().catch(() => {});
    }

    const shots = [];
    const cap = Number(process.env.SS_E2E_C3A_DIAG_CAP_MS || 150_000);
    const started = Date.now();
    let i = 0;
    while (Date.now() - started < cap) {
      i += 1;
      const label = `attente-${String(i).padStart(2, '0')}`;
      const file = await ctx.shot(page, label);
      const genButton = page.getByRole('button', { name: /Générer le pack/ }).first();
      const disabled = await genButton.isDisabled().catch(() => null);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const progressHint = (bodyText.match(/Génération|Décompression|Export|en cours|%/gi) || []).slice(0, 5);
      shots.push({ t: Date.now() - started, file, disabled, progressHint });
      await page.waitForTimeout(15_000);
    }
    ctx.check('captures prises pendant l’attente', shots.length > 0, { shots });
    ctx.check(
      'qualification : progression visible (texte/pourcentage change) ou état figé à l’identique',
      null,
      { shots, faultsDuringWait: events.faults() },
    );
  } catch (error) {
    ctx.check(`diagnostic interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    await closeFunnel(page).catch(() => {});
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish();
}

function extnameOf(p) {
  const at = p.lastIndexOf('.');
  return at >= 0 ? p.slice(at) : '';
}
