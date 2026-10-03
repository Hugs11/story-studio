// Intégrations, YouTube (`YoutubeImportFunnel`), depuis les deux
// éditeurs.
//
// Vidéo fixe, publique, très courte (~19 s) : la toute première vidéo jamais
// mise en ligne sur YouTube, id `jNQXAC9IVRw` — pas un nom de pack ni un
// chemin personnel, une URL publique documentée dans le code du parcours.
//
// Croisé avec deux états de la matrice des chemins (`c2-*`) : (1) session temporaire jamais
// enregistrée, en Éditeur graphe ; (3) enregistré hors workspace, en Éditeur
// par menus. Un troisième temps relance l'app sur le MÊME profil (`fresh:
// false`) pour vérifier que le second usage est servi par le cache (yt-dlp et
// Deno déjà provisionnés), sans réimporter les outils.
//
// `node e2e/run.mjs c5-youtube`
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { newProject, returnHome, clickButton } from '../lib/actions.mjs';
import { answerNext } from '../lib/dialogs.mjs';
import { probeAudio } from '../lib/fixtures.mjs';
import { inventory, inventoryDiff } from '../lib/oracles.mjs';
import { openMediaExplorer, hasMissingMediaModal, openProjectDialog } from '../lib/c2-helpers.mjs';
import {
  runYoutubeImport, countGraphNodes, waitForGraphReady, sessionsDir, findProducedFiles,
  clickMediaTool, youtubeFunnelModal,
} from '../lib/c5-helpers.mjs';

// « Me at the zoo » — 19 s, jamais restreinte, jamais retirée : choix stable
// pour un parcours rejouable dans le temps.
const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const TITLE_NEEDLE = 'zoo';

function appDataDirsE2e() {
  return {
    roaming: join(process.env.APPDATA, 'com.hugs11.story-studio.e2e'),
    local: join(process.env.LOCALAPPDATA, 'com.hugs11.story-studio.e2e'),
  };
}

// yt-dlp et Deno sont provisionnés sous `app_data_dir()/yt-dlp` (Tauri, donc
// `%APPDATA%\<identifiant>` sous Windows) — jamais supposé sans vérifier :
// c'est un des faits à relever (« où atterrissent-ils ? »).
function toolCandidates() {
  const { roaming, local } = appDataDirsE2e();
  return [
    { name: 'app-data (roaming)/yt-dlp', dir: join(roaming, 'yt-dlp') },
    { name: 'app-data (local)/yt-dlp', dir: join(local, 'yt-dlp') },
  ];
}

function findFile(dir, predicate) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (predicate(entry.name)) return full;
    }
  }
  return null;
}

async function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// Vérification d'intégrité indépendante du code lu (`provision.rs`/
// `js_runtime.rs`) : recalcule le SHA-256 du binaire réellement présent sur
// disque après le run et le compare à la somme de contrôle publiée par la
// release GitHub — une preuve, pas seulement une lecture de code affirmant
// que la vérification existe.
async function verifyYtdlpIntegrity(ytdlpExe) {
  if (!ytdlpExe) return { checked: false, reason: 'yt-dlp introuvable sur disque' };
  try {
    const tagResp = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
    if (!tagResp.ok) return { checked: false, reason: `API GitHub HTTP ${tagResp.status}` };
    const { tag_name: tag } = await tagResp.json();
    const sumsResp = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`);
    if (!sumsResp.ok) return { checked: false, reason: `SUMS HTTP ${sumsResp.status}` };
    const sumsText = await sumsResp.text();
    const line = sumsText.split('\n').find((l) => l.trim().endsWith('yt-dlp.exe'));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    const actual = (await sha256(ytdlpExe)).toLowerCase();
    return { checked: true, tag, expected, actual, match: !!expected && expected === actual };
  } catch (error) {
    return { checked: false, reason: String(error?.message ?? error) };
  }
}

export async function run() {
  const ctx = createRun('c5-youtube');
  const workspaceDir = ctx.dir('workspace');
  const allFaults = [];
  const cases = [];
  const check = (msg, ok, detail) => ctx.check(msg, ok, detail);

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  let { page, events } = app;

  try {
    // ============ Cas 1 — Graphe, session temporaire (1er usage réel) ============
    events.setStep('cas1-graphe-temp-1er-usage');
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    const stagesBefore1 = (await countGraphNodes(page)).stages;
    const sessionsBefore1 = inventory(sessionsDir());
    await openMediaExplorer(page);

    const res1 = await runYoutubeImport(page, { videoUrl: VIDEO_URL });
    await ctx.shot(page, 'c1-01-apres-import');
    check('[cas1 graphe/temp] import YouTube (1er usage : CGU + provisionnement yt-dlp/Deno)', res1.ok, res1);
    cases.push({ id: 'graphe-temp-1er-usage', mode: 'graphe', etat: 'session temporaire', ...res1 });

    if (res1.ok) {
      const stagesAfter1 = (await countGraphNodes(page)).stages;
      check('[cas1] aucun Écran créé (atterrissage médiathèque)', stagesAfter1 === stagesBefore1, { stagesBefore1, stagesAfter1 });
      const diff1 = inventoryDiff(sessionsBefore1, inventory(sessionsDir()));
      const produced1 = findProducedFiles(diff1, TITLE_NEEDLE);
      check('[cas1] fichier(s) produit(s) trouvé(s) sous la session temporaire (inventoryDiff)', produced1.length > 0, { diff: diff1 });
      const audio1 = produced1.filter((p) => /\.(mp3|wav|m4a)$/i.test(p));
      for (const rel of audio1) {
        const probe = probeAudio(join(sessionsDir(), rel));
        check(`[cas1] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[cas1] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
      const inLibrary1 = await page.locator('.media-explorer').getByText(TITLE_NEEDLE, { exact: false }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas1] média visible dans la médiathèque (éditeur graphe)', inLibrary1);
      await ctx.shot(page, 'c1-02-mediatheque');
    }
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 2 — Menus, enregistré hors workspace ============
    events.setStep('cas2-menus-enregistre');
    await newProject(page, 'pack');
    const projectDir2 = ctx.dir('cas2-menus-enregistre', 'projet');
    const projectPath2 = join(projectDir2, 'Projet C5 YouTube.mbah');
    await answerNext(page, 'save', projectPath2);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(2000);
    check('[cas2] premier enregistrement écrit le .mbah', existsSync(projectPath2));

    const treeBefore2 = await page.locator('.tree-item').count();
    const before2 = { workspace: inventory(workspaceDir), projet: inventory(projectDir2) };

    const res2 = await runYoutubeImport(page, { videoUrl: VIDEO_URL });
    await ctx.shot(page, 'c2-01-apres-import');
    check('[cas2 menus/enregistré] import YouTube (2e usage, mêmes outils déjà provisionnés)', res2.ok, res2);
    cases.push({ id: 'menus-enregistre', mode: 'menus', etat: 'enregistré hors workspace', ...res2 });
    check('[cas2] plus rapide que le 1er usage (yt-dlp/Deno déjà en cache)', !res1.ok || !res2.ok || res2.elapsedMs < res1.elapsedMs, { elapsed1: res1.elapsedMs, elapsed2: res2.elapsedMs });

    if (res2.ok) {
      const treeAfter2 = await page.locator('.tree-item').count();
      check('[cas2] une entrée est apparue dans l’arbre (histoire)', treeAfter2 > treeBefore2, { treeBefore2, treeAfter2 });
      const storyVisible2 = await page.locator('.tree-item').filter({ hasText: /zoo/i }).first()
        .waitFor({ timeout: 8_000 }).then(() => true, () => false);
      check('[cas2] l’histoire importée apparaît dans l’arbre', storyVisible2);
      const diffWorkspace = inventoryDiff(before2.workspace, inventory(workspaceDir));
      const diffProjet = inventoryDiff(before2.projet, inventory(projectDir2));
      const producedWorkspace = findProducedFiles(diffWorkspace, TITLE_NEEDLE);
      const producedProjet = findProducedFiles(diffProjet, TITLE_NEEDLE);
      check('[cas2] chemin exact du fichier produit relevé (workspace configuré ou dossier projet, jamais supposé)', producedWorkspace.length > 0 || producedProjet.length > 0, { producedWorkspace, producedProjet });
      check('[cas2] projet enregistré : fichier produit dans l’emplacement de travail, rien à côté du .mbah', producedWorkspace.length > 0 && producedProjet.length === 0, { producedWorkspace, producedProjet });
      const landedRoot = producedWorkspace.length ? workspaceDir : projectDir2;
      const landedRel = producedWorkspace.length ? producedWorkspace : producedProjet;
      for (const rel of landedRel.filter((p) => /\.(mp3|wav|m4a)$/i.test(p))) {
        const probe = probeAudio(join(landedRoot, rel));
        check(`[cas2] lisible par FFmpeg (${rel})`, probe.readable, probe);
        check(`[cas2] durée > 0 (${rel})`, (probe.durationSec ?? 0) > 0, probe);
      }
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(1500);
    }
    allFaults.push(...events.faults());

    // ---- fermer proprement / relancer sur le MÊME profil / rouvrir ----
    const stopAfterCas2 = await app.stop({ graceful: true });
    check('[cas2] fermeture propre', stopAfterCas2.closedGracefully !== false, stopAfterCas2);
    check('[cas2] rien écrit dans le vrai workspace avant relance', stopAfterCas2.polluted.length === 0, stopAfterCas2);

    app = await launchApp({ runDir: ctx.dir('cas2-menus-enregistre', 'relance'), fresh: false, workspaceDir });
    ({ page, events } = app);
    const reopened2 = await openProjectDialog(page, projectPath2);
    check('[cas2] réouverture aboutit', reopened2);
    if (reopened2) {
      const missing2 = await hasMissingMediaModal(page, 5000);
      check('[cas2] média YouTube importé toujours résolu après relance+réouverture', !missing2);
      check('[cas2] aucune erreur console après réouverture', events.faults().length === 0, { faults: events.faults() });
      await ctx.shot(page, 'c2-02-apres-relance-reouverture');
    }
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 3 — 2e usage réel : mêmes outils, servis par le cache ============
    // Relance sur le MÊME profil e2e (`fresh: false`) : yt-dlp et Deno restent
    // en place depuis le cas 1. Un import supplémentaire ne doit déclencher
    // aucun nouveau téléchargement d'outil — seule la vidéo est retéléchargée
    // (yt-dlp ne mémorise pas l'audio d'une vidéo déjà vue par contenu).
    events.setStep('cas3-graphe-2e-usage-cache');
    const toolsBefore3 = toolCandidates().map((c) => ({ ...c, before: inventory(c.dir) }));
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    await openMediaExplorer(page);
    const res3 = await runYoutubeImport(page, { videoUrl: VIDEO_URL });
    check('[cas3] import YouTube (2e usage, profil relancé)', res3.ok, res3);
    cases.push({ id: 'graphe-2e-usage-cache', mode: 'graphe', etat: 'session temporaire (profil réutilisé)', ...res3 });
    const toolsAfter3 = toolCandidates().map((c) => inventoryDiff(toolsBefore3.find((t) => t.dir === c.dir).before, inventory(c.dir)));
    const newToolFiles = toolsAfter3.flatMap((d) => d.added).filter((p) => /yt-dlp|deno/i.test(p));
    check('[cas3] aucun nouveau fichier yt-dlp/Deno téléchargé (outils déjà en cache)', newToolFiles.length === 0, { newToolFiles, toolsAfter3 });
    allFaults.push(...events.faults());
    await returnHome(page);

    // ============ Cas 4 — tentative d'annulation en cours d'import ============
    // `YoutubeImportFunnel.jsx` désactive la fermeture pendant `busy`
    // (`onClose={busy ? () => {} : onClose}`, y compris Escape via
    // `useEscapeKey` dans `FunnelShell`) : constat de code, vérifié ici en
    // conditions réelles plutôt qu'affirmé sans exécution.
    events.setStep('cas4-tentative-annulation');
    await newProject(page, 'advanced');
    await waitForGraphReady(page);
    await openMediaExplorer(page);
    await clickMediaTool(page, 'import-youtube');
    const modal4 = youtubeFunnelModal(page);
    await modal4.waitFor({ timeout: 15_000 });
    await modal4.locator('#youtube-funnel-url').fill(VIDEO_URL);
    await clickButton(modal4, 'Charger les vidéos');
    await modal4.locator('.youtube-funnel-row').first().waitFor({ timeout: 60_000 });
    await modal4.locator('.youtube-funnel-row').first().click();
    await clickButton(modal4, 'Importer');
    // Import en cours (phase 'importing') : tentative de fermeture immédiate.
    await page.waitForTimeout(300);
    const closeBtnDuringImport = modal4.getByRole('button', { name: 'Fermer' }).first();
    const disabledDuringImport = await closeBtnDuringImport.isDisabled().catch(() => null);
    if (disabledDuringImport === false) await closeBtnDuringImport.click().catch(() => {});
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const stillImporting = await modal4.isVisible().catch(() => false);
    check('[cas4] aucune affordance d’annulation en cours d’import (croix désactivée et/ou sans effet, Escape sans effet)', disabledDuringImport === true || stillImporting, { disabledDuringImport, stillImporting });
    await modal4.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    check('[cas4] l’import non annulé aboutit normalement ensuite', await modal4.isVisible().catch(() => false) === false);
    allFaults.push(...events.faults());
    await returnHome(page);
  } catch (error) {
    check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...events.faults());
    check('aucune erreur console ni exception sur tout le parcours (cumul)', allFaults.length === 0, { faults: allFaults });
    const lastStop = await app.stop();
    check('rien écrit dans le vrai workspace (dernier contrôle)', lastStop.polluted.length === 0, { polluted: lastStop.polluted });
  }

  // Vérification d'intégrité a posteriori, indépendante de la lecture de code
  // (voir en tête de fichier) : recalcule le SHA-256 du yt-dlp réellement
  // installé sous le profil e2e et le compare à la somme officielle GitHub.
  const ytdlpExe = toolCandidates()
    .map((c) => findFile(c.dir, (name) => name.toLowerCase() === 'yt-dlp.exe'))
    .find(Boolean);
  const integrity = await verifyYtdlpIntegrity(ytdlpExe);
  check('intégrité de yt-dlp installé vérifiée par recalcul SHA-256 face à la release GitHub officielle', integrity.checked ? integrity.match : null, integrity);

  const denoExe = toolCandidates()
    .map((c) => findFile(c.dir, (name) => name.toLowerCase() === 'deno.exe'))
    .find(Boolean);
  check('Deno (moteur JS de yt-dlp) provisionné et présent sur disque', !!denoExe, { denoExe, candidates: toolCandidates() });

  return ctx.finish({ cases, ytdlpExe, denoExe, integrity });
}
