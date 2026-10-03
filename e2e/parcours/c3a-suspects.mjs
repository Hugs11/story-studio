// Packs suspects relevés lors d'un banc Rust sans interface, rejoués dans
// l'app réelle :
//   - generationError : les 2 packs Editable dont le banc `l07_campaign` (sans
//     interface) a refusé l'export pour « identité de pack absente ».
//     Question : la fiche du pack (Ctrl+G) fournit-elle une identité, la
//     génération aboutit-elle, STUdio accepte-t-il ?
//   - b07 : pack Lecture seule dont le juge de fidélité (Rust, sans interface)
//     refusait la reconstruction (homeTransition == okTransition sur le même
//     nœud). Aboutit-il via l'app (éditeur graphe) ?
//   - b08 : 2 packs où `nightModeAvailable` se perdait au round-trip. Comparaison
//     directe des `story.json` (original vs produit par l'app).
//   - b09 : 3 packs avec des écarts extrêmes de nombre d'écrans au round-trip.
//     Comparaison du nombre d'écrans original vs produit, via l'app.
//
// Les chemins réels ne sont jamais versionnés : ils viennent de
// `e2e/local.c3a-suspects.json` (gitignoré, voir l'exemple `.example.json`),
// une liste `{ label, relPath }` par groupe, relPath relatif à `corpusDir`.
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DIR, config, requireConfig } from '../lib/config.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { closeFunnel, clickButton, generatePack, goHome, importPack, MODALS, returnHome } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { readbackPack, readStoryJson } from '../lib/oracles.mjs';

const SUSPECTS_FILE = join(E2E_DIR, 'local.c3a-suspects.json');

function loadSuspects() {
  if (!existsSync(SUSPECTS_FILE)) return null;
  return JSON.parse(readFileSync(SUSPECTS_FILE, 'utf8'));
}

// Ctrl+G → fiche du pack → observe l'UUID proposé avant de cliquer « Appliquer
// & générer » → poursuit comme `generatePack` (révision d'UUID, dossier de
// sortie). Duplique une partie de `generatePack` pour intercaler cette lecture.
async function generateWithFicheInspection(page, outDir, { uuid = 'keep', timeout = 300_000 } = {}) {
  mkdirSync(outDir, { recursive: true });
  await answerNext(page, 'open', outDir);
  await page.keyboard.press('Control+g');
  const uuidInput = page.locator('.pack-meta-uuid-input').first();
  const panelAppeared = await uuidInput.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const uuidFieldValue = panelAppeared ? await uuidInput.inputValue().catch(() => null) : null;
  const result = { panelAppeared, uuidFieldValue };
  if (!panelAppeared) return { ...result, zip: null, refusal: 'fiche du pack non affichée après Ctrl+G' };
  await clickButton(page, /Appliquer\s*&\s*générer/, { timeout: 15_000 });
  const revision = page.locator(MODALS).filter({ hasText: 'Nouvelle révision' });
  await revision.waitFor({ timeout: 5_000 }).catch(() => {});
  if (await revision.count()) {
    await clickButton(revision, uuid === 'new' ? /Générer un nouvel UUID/ : /Garder l.UUID d.origine/);
  }
  const { readdirSync } = await import('node:fs');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const zip = readdirSync(outDir).find((name) => name.endsWith('.zip'));
    if (zip) { await page.waitForTimeout(1000); return { ...result, zip: join(outDir, zip) }; }
    const refusal = page.locator(MODALS).filter({ hasText: /Impossible|refus|interrompu/i });
    if (await refusal.count()) return { ...result, zip: null, refusal: (await refusal.first().innerText()).trim() };
    await page.waitForTimeout(1000);
  }
  return { ...result, zip: null, timeout: true };
}

export async function run() {
  const ctx = createRun('c3a-suspects');
  const suspects = loadSuspects();
  if (!suspects) {
    ctx.check('liste des packs suspects disponible (e2e/local.c3a-suspects.json)', null, {
      detail: `Fichier absent : ${SUSPECTS_FILE}. Voir local.c3a-suspects.example.json.`,
    });
    return ctx.finish();
  }
  const corpusDir = requireConfig('corpusDir');
  const workspaceDir = ctx.dir('workspace');
  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];
  const results = { generationError: [], b07: [], b08: [], b09: [] };

  function resolveCopy(entry, group) {
    const source = join(corpusDir, entry.relPath);
    if (!existsSync(source)) throw new Error(`Pack suspect introuvable : ${source}`);
    const ext = entry.relPath.slice(entry.relPath.lastIndexOf('.'));
    const dir = ctx.dir('entrées', group);
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, `${entry.label}${ext}`);
    copyFileSync(source, copy);
    return copy;
  }

  try {
    // --- generationError : les 2 packs Editable « identité absente ». ---
    for (const entry of suspects.generationError ?? []) {
      events.setStep(`generation-error-${entry.label}`);
      await goHome(page).catch(() => {});
      const copy = resolveCopy(entry, 'generation-error');
      const { storyJson: original } = await readStoryJson(page, copy);
      const rec = { label: entry.label, sourceName: entry.relPath, originalUuid: original?.uuid ?? null };
      try {
        await importPack(page, copy, { editor: 'menus' });
        rec.importOk = true;
      } catch (error) {
        rec.importOk = false;
        rec.importError = String(error?.message ?? error);
      }
      if (rec.importOk) {
        const outDir = ctx.dir('sortie', 'generation-error', entry.label);
        const gen = await generateWithFicheInspection(page, outDir, { uuid: 'keep' });
        rec.ficheProposeUneIdentite = Boolean(gen.uuidFieldValue && gen.uuidFieldValue.trim().length > 0);
        rec.uuidFieldValue = gen.uuidFieldValue;
        rec.generationOk = Boolean(gen.zip);
        rec.refusal = gen.refusal ?? (gen.timeout ? 'timeout' : null);
        await ctx.shot(page, `generation-error-${entry.label}-fiche`);
        if (gen.zip) {
          const readback = await readbackPack(page, gen.zip, ctx.dir('studio', 'generation-error', entry.label));
          rec.readbackOk = readback.ok;
          rec.studioOk = readback.studio?.ok ?? false;
          rec.producedUuid = readback.storyStudio?.uuid ?? null;
        }
      }
      rec.verdict = rec.generationOk
        ? `requalifié : la fiche fournit une identité (${rec.uuidFieldValue ?? 'n/a'}) et la génération aboutit dans l'app`
        : `confirmé à l'identique dans l'app : ${rec.refusal ?? rec.importError ?? 'échec sans détail'}`;
      results.generationError.push(rec);
      ctx.check(`generation-error ${entry.label} : génération aboutit dans l'app`, rec.generationOk === true, rec);
      await returnHome(page).catch(() => closeFunnel(page).catch(() => {}));
    }

    // --- b07 : home/okTransition sur le même nœud (Lecture seule, graphe). ---
    for (const entry of suspects.b07 ?? []) {
      events.setStep(`b07-${entry.label}`);
      await goHome(page).catch(() => {});
      const copy = resolveCopy(entry, 'b07');
      const { storyJson: original } = await readStoryJson(page, copy);
      const rec = { label: entry.label, sourceName: entry.relPath, originalStageCount: original?.stageNodes?.length ?? null };
      try {
        await importPack(page, copy, { editor: 'graphe' });
        rec.importOk = true;
      } catch (error) {
        rec.importOk = false;
        rec.importError = String(error?.message ?? error);
      }
      if (rec.importOk) {
        const outDir = ctx.dir('sortie', 'b07', entry.label);
        const gen = await generatePack(page, outDir, { uuid: 'keep' });
        rec.generationOk = Boolean(gen.zip);
        rec.refusal = gen.refusal ?? (gen.timeout ? 'timeout' : null);
        if (gen.zip) {
          const readback = await readbackPack(page, gen.zip, ctx.dir('studio', 'b07', entry.label));
          rec.readbackOk = readback.ok;
          rec.studioOk = readback.studio?.ok ?? false;
          rec.producedStageCount = readback.storyStudio?.stageNodes ?? null;
        }
      }
      rec.verdict = rec.generationOk
        ? 'infirmé dans l’app : la génération aboutit via l’éditeur graphe (le refus Rust headless ne se manifeste pas par ce chemin)'
        : `confirmé dans l’app : ${rec.refusal ?? rec.importError ?? 'échec sans détail'}`;
      await ctx.shot(page, `b07-${entry.label}`);
      results.b07.push(rec);
      ctx.check(`b07 ${entry.label} : génération aboutit dans l'app (éditeur graphe)`, rec.generationOk === true, rec);
      await returnHome(page).catch(() => closeFunnel(page).catch(() => {}));
    }

    // --- b08 : nightModeAvailable perdu au round-trip. ---
    for (const entry of suspects.b08 ?? []) {
      events.setStep(`b08-${entry.label}`);
      await goHome(page).catch(() => {});
      const copy = resolveCopy(entry, 'b08');
      const { storyJson: original } = await readStoryJson(page, copy);
      const rec = { label: entry.label, sourceName: entry.relPath, originalNightModeAvailable: original?.nightModeAvailable ?? null };
      try {
        await importPack(page, copy, { editor: 'graphe' });
        rec.importOk = true;
      } catch (error) {
        rec.importOk = false;
        rec.importError = String(error?.message ?? error);
      }
      if (rec.importOk) {
        const outDir = ctx.dir('sortie', 'b08', entry.label);
        const gen = await generatePack(page, outDir, { uuid: 'keep' });
        rec.generationOk = Boolean(gen.zip);
        rec.refusal = gen.refusal ?? (gen.timeout ? 'timeout' : null);
        if (gen.zip) {
          const { storyJson: produced } = await readStoryJson(page, gen.zip);
          rec.producedNightModeAvailable = produced?.nightModeAvailable ?? null;
          const readback = await readbackPack(page, gen.zip, ctx.dir('studio', 'b08', entry.label));
          rec.readbackOk = readback.ok;
          rec.studioOk = readback.studio?.ok ?? false;
          rec.studioNightMode = readback.studio?.nightMode ?? null;
        }
      }
      const matches = rec.generationOk && rec.originalNightModeAvailable === rec.producedNightModeAvailable;
      rec.verdict = !rec.generationOk
        ? `non concluant dans l’app : ${rec.refusal ?? rec.importError ?? 'échec sans détail'}`
        : matches
          ? 'infirmé dans l’app : nightModeAvailable est conservé par ce chemin'
          : `confirmé dans l’app : nightModeAvailable original=${rec.originalNightModeAvailable} produit=${rec.producedNightModeAvailable}`;
      await ctx.shot(page, `b08-${entry.label}`);
      results.b08.push(rec);
      ctx.check(`b08 ${entry.label} : nightModeAvailable conservé`, rec.generationOk ? matches : null, rec);
      await returnHome(page).catch(() => closeFunnel(page).catch(() => {}));
    }

    // --- b09 : explosions/effondrements du nombre d'écrans. ---
    for (const entry of suspects.b09 ?? []) {
      events.setStep(`b09-${entry.label}`);
      await goHome(page).catch(() => {});
      const copy = resolveCopy(entry, 'b09');
      const { storyJson: original } = await readStoryJson(page, copy);
      const rec = { label: entry.label, sourceName: entry.relPath, originalStageCount: original?.stageNodes?.length ?? null };
      try {
        await importPack(page, copy, { editor: 'graphe' });
        rec.importOk = true;
      } catch (error) {
        rec.importOk = false;
        rec.importError = String(error?.message ?? error);
      }
      if (rec.importOk) {
        const outDir = ctx.dir('sortie', 'b09', entry.label);
        const gen = await generatePack(page, outDir, { uuid: 'keep' });
        rec.generationOk = Boolean(gen.zip);
        rec.refusal = gen.refusal ?? (gen.timeout ? 'timeout' : null);
        if (gen.zip) {
          const { storyJson: produced } = await readStoryJson(page, gen.zip);
          rec.producedStageCount = Array.isArray(produced?.stageNodes) ? produced.stageNodes.length : null;
          const readback = await readbackPack(page, gen.zip, ctx.dir('studio', 'b09', entry.label));
          rec.readbackOk = readback.ok;
          rec.studioOk = readback.studio?.ok ?? false;
          rec.studioStageCount = readback.studio?.stageNodes ?? null;
        }
      }
      const delta = rec.generationOk && rec.originalStageCount != null && rec.producedStageCount != null
        ? rec.producedStageCount - rec.originalStageCount : null;
      rec.delta = delta;
      rec.verdict = !rec.generationOk
        ? `non concluant dans l’app : ${rec.refusal ?? rec.importError ?? 'échec sans détail'}`
        : `à arbitrer : original=${rec.originalStageCount} produit=${rec.producedStageCount} (delta ${delta})`;
      await ctx.shot(page, `b09-${entry.label}`);
      results.b09.push(rec);
      ctx.check(`b09 ${entry.label} : écart de comptage d'écrans relevé`, rec.generationOk === true, rec);
      await returnHome(page).catch(() => closeFunnel(page).catch(() => {}));
    }
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    ctx.check('aucune erreur console ni exception cumulée', allFaults.length === 0, { faults: allFaults });
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }

  // Données brutes dans le dossier de rapport configuré localement.
  const reportDir = config.c3aSuspectsReportDir;
  mkdirSync(reportDir, { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(reportDir, 'c3a-suspects.json'), JSON.stringify(results, null, 2));
  return ctx.finish({ results });
}
