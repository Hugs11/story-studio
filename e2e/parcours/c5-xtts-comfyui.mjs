// Intégrations, XTTS et ComfyUI (`GenerateVoiceModal`/backend XTTS,
// `SDGenerateModal`/ComfyUI), depuis un seul éditeur (graphe), projet non
// enregistré. Combine les deux dans un seul lancement d'app pour rester
// léger : chaque serveur n'est démarré/arrêté qu'une fois.
//
// Les chemins des installations locales (lecture seule, jamais modifiées) ne
// sont jamais codés en dur ici : `e2e/local.config.json` (ignoré par git),
// clés `xttsDir`/`comfyuiDir` (voir `local.config.example.json`), ou
// `SS_E2E_XTTS_DIR`/`SS_E2E_COMFYUI_DIR`.
//
// Les deux serveurs sont démarrés par l'app elle-même, « selon ce qu'elle
// propose » : XTTS au montage de la modale de génération de voix
// (`xtts_get_status` → `ensure_server_with_log`), ComfyUI à la soumission
// d'un job (`comfyui_submit_job` → `ensure_comfyui_sync`) — jamais par un
// script qui lancerait `start.bat`/`start_comfyui.bat` lui-même.
//
// `node e2e/run.mjs c5-xtts-comfyui`
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { config, requireConfig } from '../lib/config.mjs';
import { newProject } from '../lib/actions.mjs';
import { probeAudio, probeImage } from '../lib/fixtures.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';
import { openMediaExplorer } from '../lib/c2-helpers.mjs';
import {
  configureXttsBackendViaPreferences, runXttsGenerate,
  configureComfyuiViaPreferences, importComfyuiWorkflowViaPreferences,
  selectRootGraphStage, runComfyuiGenerate,
  waitForGraphReady, countGraphNodes, sessionsDir, findProducedFiles,
  listStrayAiProcesses, killStrayAiProcesses,
} from '../lib/c5-helpers.mjs';

const XTTS_TEXT = 'Ceci est une phrase courte pour tester la synthèse vocale XTTS.';
const XTTS_NEEDLE = 'histoire-tts';
const XTTS_TIMEOUT = 5 * 60_000;
const COMFYUI_TIMEOUT = 6 * 60_000;

export async function run() {
  const ctx = createRun('c5-xtts-comfyui');
  const workspaceDir = ctx.dir('workspace');
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);

  const xttsDir = requireConfig('xttsDir');
  const comfyuiDir = requireConfig('comfyuiDir');
  const launcherPath = join(comfyuiDir, 'start_comfyui.bat');
  const wfDir = join(comfyuiDir, 'workflows', 'Workflows-comfyui');
  const apiJsonPath = join(wfDir, '03-scene-depuis-prompt-api.json');
  const configJsonPath = join(wfDir, '03-scene-depuis-prompt.config.json');

  const app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const { page, events } = app;
  const allFaults = [];

  try {
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    await openMediaExplorer(page);

    // ============ XTTS ============
    events.setStep('xtts');
    const stagesBeforeXtts = (await countGraphNodes(page)).stages;
    const sessionsBeforeXtts = inventory(sessionsDir());

    await configureXttsBackendViaPreferences(page, xttsDir);
    await ctx.shot(page, 'xtts-01-preferences-configurees');

    const xttsRes = await runXttsGenerate(page, { text: XTTS_TEXT, timeout: XTTS_TIMEOUT });
    await ctx.shot(page, 'xtts-02-apres-generation');
    check('[XTTS] démarrage + génération (graphe, session temporaire)', xttsRes.ok, xttsRes);

    if (xttsRes.ok) {
      const stagesAfterXtts = (await countGraphNodes(page)).stages;
      check('[XTTS] aucun Écran créé (atterrissage médiathèque)', stagesAfterXtts === stagesBeforeXtts, { stagesBeforeXtts, stagesAfterXtts });
      const inLibrary = await page.locator('.media-explorer').getByText(XTTS_NEEDLE, { exact: false }).first()
        .waitFor({ timeout: 45_000 }).then(() => true, () => false);
      check('[XTTS] média visible dans la médiathèque', inLibrary);
      await ctx.shot(page, 'xtts-03-mediatheque');
      const diff = inventoryDiff(sessionsBeforeXtts, inventory(sessionsDir()));
      const produced = findProducedFiles(diff, XTTS_NEEDLE);
      check('[XTTS] fichier produit trouvé sous la session temporaire (inventoryDiff)', produced.length > 0, { diff });
      for (const rel of produced) {
        const probe = probeAudio(join(sessionsDir(), rel));
        check(`[XTTS] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[XTTS] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
    }
    allFaults.push(...events.faults());

    // ============ ComfyUI ============
    events.setStep('comfyui');
    const sessionsBeforeComfy = inventory(sessionsDir());

    const prefsDialog = await configureComfyuiViaPreferences(page, launcherPath);
    await ctx.shot(page, 'comfyui-01-preferences-configurees');
    const importRes = await importComfyuiWorkflowViaPreferences(page, prefsDialog, { apiJsonPath, configJsonPath });
    check('[ComfyUI] import du workflow « Scene depuis prompt » (sans image de référence)', importRes.ok, importRes);
    await ctx.shot(page, 'comfyui-02-workflow-importe');

    await selectRootGraphStage(page);
    const stagesBeforeComfy = (await countGraphNodes(page)).stages;

    const comfyRes = await runComfyuiGenerate(page, { timeout: COMFYUI_TIMEOUT });
    await ctx.shot(page, 'comfyui-03-apres-generation');
    check('[ComfyUI] démarrage + génération (graphe, Écran racine, session temporaire)', comfyRes.ok, comfyRes);
    check('[ComfyUI] workflow « Scene depuis prompt » trouvé dans la liste', comfyRes.workflowFound, comfyRes);

    if (comfyRes.ok) {
      const stagesAfterComfy = (await countGraphNodes(page)).stages;
      check('[ComfyUI] aucun Écran créé (résultat posé sur le champ image de l’Écran sélectionné)', stagesAfterComfy === stagesBeforeComfy, { stagesBeforeComfy, stagesAfterComfy });
      const diff = inventoryDiff(sessionsBeforeComfy, inventory(sessionsDir()));
      check('[ComfyUI] fichier produit trouvé sous la session temporaire (inventoryDiff)', diff.added.length > 0, { diff });
      for (const rel of diff.added) {
        const probe = probeImage(join(sessionsDir(), rel));
        check(`[ComfyUI] image lisible (en-tête ${probe.format ?? 'inconnu'}) (${rel})`, probe.readable, probe);
      }
      await ctx.shot(page, 'comfyui-04-image-sur-ecran');
    }
    allFaults.push(...events.faults());
  } catch (error) {
    check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    check('aucune erreur console ni exception sur tout le parcours (cumul)', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    check('rien écrit dans le vrai workspace', lastStop.polluted.length === 0, { polluted: lastStop.polluted });

    const strayBefore = listStrayAiProcesses([xttsDir, comfyuiDir]);
    if (strayBefore.length > 0) killStrayAiProcesses([xttsDir, comfyuiDir]);
    const strayAfter = listStrayAiProcesses([xttsDir, comfyuiDir]);
    check('aucun processus XTTS/ComfyUI ne reste après arrêt de l’app', strayAfter.length === 0, { strayBefore, strayAfter });
  }
  return ctx.finish();
}
