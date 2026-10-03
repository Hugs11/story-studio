// Gestes et oracles propres aux Intégrations (micro, YouTube,
// podcast, voix de synthèse), au-dessus de `actions.mjs`.
//
// Le bouton toolbar (`StructureActionsBar`, `data-media-tool="record"` —
// même famille que `data-media-tool="simulator"` déjà documenté dans
// `simulator.mjs` : commun à l'arbre, au diagramme et au canvas graphe)
// ouvre `RecordModal` (pas une boîte `role="dialog"` : un simple
// `.modal-overlay`/`.record-modal`) : décompte de 3 s puis `getUserMedia`,
// qui déclenche l'autorisation WebView2/Windows — un geste humain, hors DOM,
// que Playwright ne peut ni voir ni cliquer. `waitForPermissionOutcome`
// attend seulement ce que la page peut observer : le passage en phase
// `recording` (accordée) ou `error` (refusée/indisponible).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { clickButton, modalWithText } from './actions.mjs';
import { answerNext } from './dialogs.mjs';

export function recordModal(page) {
  return page.locator('.record-modal').first();
}

// `:visible` (pseudo-classe de sélecteur Playwright, même convention que
// `clickButton`/`button:visible` dans `actions.mjs`) : l'attribut
// `data-media-tool` existe deux fois pour un même outil (bouton direct ET
// entrée d'overflow, `StructureActionsOverflow.jsx`), et rien n'exclut deux
// panneaux montés (arbre/diagramme) dont un seul est affiché — un `.first()`
// nu risquerait de viser un nœud caché et de bloquer jusqu'au timeout.
export async function clickMediaTool(page, toolId, { timeout = 15_000 } = {}) {
  let btn = page.locator(`[data-media-tool="${toolId}"]:visible`).first();
  if (await btn.count() === 0) {
    const overflow = page.locator('.structure-actions-overflow-trigger:visible').first();
    if (await overflow.count()) {
      await overflow.click();
      btn = page.locator(`[data-media-tool="${toolId}"]:visible`).first();
    }
  }
  await btn.waitFor({ timeout });
  await btn.click();
}

/**
 * Répétition du geste jusqu'à la modale de décompte, SANS jamais laisser le
 * décompte atteindre zéro : referme par la croix avant tout appel à
 * `getUserMedia`. Sert à mettre au point le parcours sans déclencher aucune
 * demande d'autorisation (préparation, avant que l'auteur soit sollicité).
 */
export async function rehearseUpToPermissionRequest(page, { toolId = 'record' } = {}) {
  await clickMediaTool(page, toolId);
  const modal = recordModal(page);
  await modal.waitFor({ timeout: 10_000 });
  const reachedCountdown = await page.locator('.record-countdown').first().isVisible().catch(() => false);
  await modal.locator('.modal-close').first().click();
  await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  return { reachedCountdown };
}

/**
 * Attend l'issue de la demande d'autorisation micro : accordée (phase
 * `recording`, minuteur visible) ou refusée/indisponible (phase `error`,
 * message « Impossible d'accéder au micro »). Ni l'un ni l'autre sous
 * `timeout` (20 s par défaut : l'autorisation est automatique dans l'app e2e)
 * est un fait à rapporter (blocage silencieux), jamais une exception qui interromprait le parcours.
 */
export async function waitForPermissionOutcome(page, { timeout = 20_000 } = {}) {
  const startedAt = Date.now();
  const recording = page.locator('.record-timer').first();
  const errored = page.locator('.record-hint', { hasText: "Impossible d'accéder au micro" }).first();
  await Promise.race([
    recording.waitFor({ timeout }).catch(() => {}),
    errored.waitFor({ timeout }).catch(() => {}),
  ]);
  const elapsedMs = Date.now() - startedAt;
  if (await recording.count()) return { outcome: 'granted', elapsedMs };
  if (await errored.count()) {
    const message = await errored.innerText().catch(() => null);
    return { outcome: 'denied', elapsedMs, message };
  }
  return { outcome: 'timeout', elapsedMs };
}

/**
 * Cycle complet depuis l'outil de la barre : clic → décompte → autorisation
 * → quelques secondes d'enregistrement → arrêt → nom du fichier →
 * « Utiliser ». Renvoie `{ outcome, elapsedMs, message?, saved, fileName? }` ;
 * `outcome !== 'granted'` laisse l'appelant relever un refus ou un blocage
 * plutôt que de planter le parcours.
 */
export async function performRecording(page, {
  toolId = 'record', recordSeconds = 3, fileName = null, permissionTimeout = 20_000,
} = {}) {
  await clickMediaTool(page, toolId);
  const modal = recordModal(page);
  await modal.locator('.record-countdown').first().waitFor({ timeout: 10_000 });
  const permission = await waitForPermissionOutcome(page, { timeout: permissionTimeout });
  if (permission.outcome !== 'granted') return { ...permission, saved: false };

  await page.waitForTimeout(recordSeconds * 1000);
  await clickButton(modal, '⏹ Arrêter');
  await modal.locator('.record-preview-icon').first().waitFor({ timeout: 15_000 });

  if (fileName) await modal.locator('.record-name-input').fill(fileName);
  const finalName = fileName ?? await modal.locator('.record-name-input').inputValue();

  await clickButton(modal, '✓ Utiliser');
  await modal.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  return { ...permission, saved: true, fileName: finalName };
}

// Referme la modale par « Fermer » après un refus (phase `error`). Scopé à
// `.record-modal` : le bouton natif de fermeture de fenêtre porte, lui aussi,
// le nom accessible « Fermer » (même piège que `closeFunnel`, `actions.mjs`).
export async function closeRecordModalAfterError(page) {
  const modal = recordModal(page);
  await clickButton(modal, 'Fermer');
  await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

// Décompte des Écrans/Actions actuellement listés (`GraphSearchPanel.jsx`,
// liste complète par défaut, root épinglé en tête — pas un simple
// autocomplete) : oracle « aucun Écran créé » côté graphe, sans exiger un
// enregistrement sur disque (donc utilisable sur une session temporaire).
// `newProject(page, 'advanced')` rend la main dès que « Générer le pack »
// est actif, ce qui précède l'affichage du canvas/de la liste de recherche
// (« Ouverture de l'Éditeur graphe… » encore visible, quelques secondes,
// quelques secondes). Compter les Écrans avant ce délai lirait 0 à
// tort : on attend l'Écran racine (toujours présent) avant tout décompte.
export async function waitForGraphReady(page, { timeout = 30_000 } = {}) {
  await page.locator('li[role="option"][data-kind="stage"]:visible').first().waitFor({ timeout });
}

export async function countGraphNodes(page) {
  return {
    stages: await page.locator('li[role="option"][data-kind="stage"]:visible').count(),
    actions: await page.locator('li[role="option"][data-kind="action"]:visible').count(),
  };
}

// ── YouTube (`YoutubeImportFunnel.jsx`) ──────────────────────────────────────
//
// Le funnel reste ouvert pendant tout le téléchargement (son propre écran
// « Import depuis YouTube… », `FunnelGenerationState`) et ne se referme que
// l'import terminé — contrairement au podcast (voir plus bas), où la modale
// se referme dès le clic et le téléchargement continue derrière une bannière
// globale distincte. Fait relevé en écrivant ce parcours, pas une supposition.
export function youtubeFunnelModal(page) {
  return page.locator('[role="dialog"][aria-label="Créer un pack depuis YouTube"]').first();
}

/**
 * Cycle complet depuis l'outil de la barre : clic → CGU (si première fois du
 * profil) → URL → chargement de la liste → sélection de la première vidéo →
 * import → fermeture. `videoUrl` doit pointer une vidéo unique (pas une
 * playlist) pour que la liste ne contienne qu'une entrée. Renvoie
 * `{ ok, phase, error?, videoTitle?, elapsedMs }` ; `phase` dit où un échec
 * s'est produit ('liste' | 'import' | null si `ok`).
 */
export async function runYoutubeImport(page, { videoUrl, timeout = 15 * 60_000 } = {}) {
  await clickMediaTool(page, 'import-youtube');
  const modal = youtubeFunnelModal(page);
  await modal.waitFor({ timeout: 15_000 });
  const cguButton = modal.getByRole('button', { name: "J'ai compris, continuer" });
  if (await cguButton.count()) await cguButton.click();

  const startedAt = Date.now();
  await modal.locator('#youtube-funnel-url').fill(videoUrl);
  await clickButton(modal, 'Charger les vidéos');
  const row = modal.locator('.youtube-funnel-row').first();
  const listError = modal.locator('.funnel-error').first();
  await Promise.race([
    row.waitFor({ timeout }).catch(() => {}),
    listError.waitFor({ timeout }).catch(() => {}),
  ]);
  if (!(await row.count())) {
    const error = await listError.count() ? (await listError.innerText()).trim() : 'timeout';
    return { ok: false, phase: 'liste', error, elapsedMs: Date.now() - startedAt };
  }
  const videoTitle = (await row.locator('.youtube-funnel-row-name').innerText()).trim();
  await row.click();
  await clickButton(modal, 'Importer');

  const outcome = await Promise.race([
    modal.waitFor({ state: 'hidden', timeout }).then(() => 'closed').catch(() => 'pending'),
    modal.getByText("L'import a échoué").waitFor({ timeout }).then(() => 'failed').catch(() => 'pending'),
  ]);
  const elapsedMs = Date.now() - startedAt;
  if (outcome === 'closed') return { ok: true, videoTitle, elapsedMs };
  const errorText = await modal.locator('.funnel-error, .tts-error').first().innerText().catch(() => 'échec sans message lisible');
  return { ok: false, phase: 'import', error: errorText.trim(), videoTitle, elapsedMs };
}

// ── Podcast (`PodcastImportModal.jsx`) ───────────────────────────────────────
//
// À la différence de YouTube : `handleImport` referme la modale dès le clic
// (`onImport(...)` n'est pas attendu), le téléchargement se poursuit derrière
// la bannière globale `GenerateProgressModal` (`.gen-progress-modal`, « Import
// en cours... ») — c'est donc CETTE bannière, pas la modale podcast, qu'il
// faut attendre pour savoir si l'import est terminé.
export function podcastModal(page) {
  return page.locator('[role="dialog"][aria-label="Importer un podcast"]').first();
}

/**
 * Cycle complet : clic → URL du flux → chargement → filtre (pour isoler un
 * épisode précis dans un flux qui peut en contenir des centaines, sans
 * dépendre de son rang) → sélection → import → fin de la bannière globale.
 * Renvoie `{ ok, phase, error?, episodeTitle?, elapsedMs }`.
 */
export async function runPodcastImport(page, {
  feedUrl, episodeQuery, timeout = 5 * 60_000,
} = {}) {
  await clickMediaTool(page, 'import-podcast');
  const modal = podcastModal(page);
  await modal.waitFor({ timeout: 15_000 });

  const startedAt = Date.now();
  await modal.locator('#podcast-url-input').fill(feedUrl);
  await clickButton(modal, 'Charger les épisodes');
  const filterInput = modal.locator('.podcast-toolbar input[type="text"]').first();
  const feedError = modal.locator('.podcast-error').first();
  await Promise.race([
    filterInput.waitFor({ timeout }).catch(() => {}),
    feedError.waitFor({ timeout }).catch(() => {}),
  ]);
  if (!(await filterInput.count())) {
    const error = await feedError.count() ? (await feedError.innerText()).trim() : 'timeout';
    return { ok: false, phase: 'flux', error, elapsedMs: Date.now() - startedAt };
  }
  if (episodeQuery) await filterInput.fill(episodeQuery);
  const row = modal.locator('.podcast-row').first();
  const rowOk = await row.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (!rowOk) return { ok: false, phase: 'filtre', error: 'aucun épisode ne correspond au filtre', elapsedMs: Date.now() - startedAt };
  const episodeTitle = (await row.locator('.podcast-row-name').innerText()).trim();
  await row.click();
  await clickButton(modal, 'Importer');

  await modal.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  const progress = page.locator('.gen-progress-modal').first();
  const appeared = await progress.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (appeared) await progress.waitFor({ state: 'hidden', timeout }).catch(() => {});
  return { ok: true, episodeTitle, elapsedMs: Date.now() - startedAt, progressShown: appeared };
}

// ── Voix de synthèse (`GenerateVoiceModal.jsx`) ─────────────────────────────
//
// Pas de `role="dialog"` (même famille que `RecordModal` : `.modal-overlay` /
// `.modal-box`) — scopé à `.tts-modal`, sa classe propre.
export function ttsModal(page) {
  return page.locator('.tts-modal').first();
}

/**
 * Cycle complet Piper (backend par défaut, zéro-config) : clic → texte →
 * « Générer » (Playwright attend nativement que le bouton cesse d'être
 * désactivé, donc que le catalogue des voix soit chargé) → fermeture.
 * Un premier usage télécharge la voix par défaut (`needsProvision`) : le
 * délai le reflète.
 */
export async function runPiperGenerate(page, {
  text = 'Ceci est un essai de synthèse vocale avec Piper.', timeout = 5 * 60_000,
} = {}) {
  await clickMediaTool(page, 'generate-tts');
  const modal = ttsModal(page);
  await modal.waitFor({ timeout: 15_000 });
  await modal.locator('textarea.tts-textarea').fill(text);
  const startedAt = Date.now();
  await clickButton(modal, 'Générer', { timeout: 15_000 });
  const outcome = await Promise.race([
    modal.waitFor({ state: 'hidden', timeout }).then(() => 'closed').catch(() => 'pending'),
    modal.locator('.tts-error').first().waitFor({ timeout }).then(() => 'failed').catch(() => 'pending'),
  ]);
  const elapsedMs = Date.now() - startedAt;
  if (outcome === 'closed') return { ok: true, elapsedMs };
  const error = await modal.locator('.tts-error').first().innerText().catch(() => 'échec sans message lisible');
  return { ok: false, error: error.trim(), elapsedMs };
}

// Dossier des sessions éphémères du profil e2e (projet jamais enregistré) —
// même définition que `c5-micro.mjs`, partagée ici pour les autres parcours
// d'intégrations qui croisent le même état de chemin.
export function sessionsDir() {
  return join(process.env.LOCALAPPDATA, 'com.hugs11.story-studio.e2e', 'sessions');
}

// Cherche un fichier produit dans un `inventoryDiff` par un fragment de nom
// (alphanumérique, robuste à l'assainissement du nom de fichier), jamais en
// supposant le sous-dossier exact (`fichiers-importes/`, observé en pratique
// pour podcast/YouTube, n'est jamais codé en dur ici).
export function findProducedFiles(diff, needle) {
  const lower = needle.toLowerCase();
  return diff.added.filter((p) => p.toLowerCase().includes(lower));
}

// Ouvre les Préférences (Ctrl+Maj+O, câblé seulement dans un éditeur, voir
// `e2e/README.md`). `Escape` d'abord (sans effet si rien n'est ouvert) pour
// rendre le geste robuste à un focus resté dans un champ texte (ex. après
// `openMediaExplorer`, dont le panneau peut porter un champ de filtre) — un
// clavier au clic natif du navigateur, contrairement à `page.keyboard.press`,
// ne suffit pas toujours à faire remonter le raccourci jusqu'au gestionnaire
// global si un champ texte capte l'événement avant lui. Reste sans effet
// (retente une seule fois) si la modale n'apparaît pas du premier coup.
export async function openPreferences(page, { timeout = 15_000 } = {}) {
  const dialog = modalWithText(page, 'Préférences').first();
  for (const attempt of [0, 1]) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+Shift+O');
    const opened = await dialog.waitFor({ timeout: attempt === 0 ? timeout / 2 : timeout / 2 })
      .then(() => true, () => false);
    if (opened) return dialog;
  }
  throw new Error('Les Préférences (Ctrl+Maj+O) ne se sont pas ouvertes après deux tentatives.');
}

// ── XTTS (`XttsVoiceModal`, backend avancé opt-in) ───────────────────────────
//
// Configuration par l'interface des Préférences (Ctrl+Maj+O, groupe
// « Intelligence artificielle » → section « Voix locale », `id="xtts"`),
// jamais par écriture directe du `localStorage` : c'est le chemin qu'un
// auteur réel suit pour passer de Piper à XTTS. Basculer le moteur active
// `xttsSettings.enabled` (`VoiceSection.jsx:handleTtsBackendChange`) — rien
// d'autre à cocher.
export async function configureXttsBackendViaPreferences(page, xttsDir) {
  const dialog = await openPreferences(page);
  const section = dialog.locator('#xtts');
  await section.waitFor({ timeout: 10_000 });
  await section.locator('select.opts-select').selectOption('xtts');
  await section.getByPlaceholder('Dossier contenant server.py, venv, models et voices').fill(xttsDir);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

/**
 * Cycle complet XTTS (backend avancé) : clic → texte → attente active de
 * `xtts_get_status` (déclenché au montage de la modale, `loadStatus` dans
 * `GenerateVoiceModal.jsx`), qui démarre le serveur si besoin
 * (`ensure_server_with_log`, jusqu'à 45 tentatives d'1 s) → « Générer » →
 * fermeture. Contrairement à `runPiperGenerate`, le bouton reste désactivé
 * tant que `loading` est vrai : on l'attend explicitement (jamais le clic nu,
 * dont l'attente native de Playwright — 30 s — serait trop courte pour un
 * démarrage à froid du serveur).
 */
export async function runXttsGenerate(page, {
  text = 'Ceci est un essai de synthèse vocale avec XTTS.', timeout = 5 * 60_000,
} = {}) {
  await clickMediaTool(page, 'generate-tts');
  const modal = ttsModal(page);
  await modal.waitFor({ timeout: 15_000 });
  await modal.locator('textarea.tts-textarea').fill(text);
  const startedAt = Date.now();
  const generateBtn = modal.getByRole('button', { name: 'Générer' }).first();
  const errorBox = modal.locator('.tts-error').first();
  const connectDeadline = startedAt + timeout;
  let ready = false;
  while (Date.now() < connectDeadline) {
    if (await errorBox.count()) break;
    if (await generateBtn.count() && !(await generateBtn.isDisabled())) { ready = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!ready) {
    const error = await errorBox.innerText().catch(() => 'XTTS indisponible (délai dépassé avant chargement des voix)');
    return { ok: false, phase: 'connexion', error: error.trim(), elapsedMs: Date.now() - startedAt };
  }
  await generateBtn.click();
  const outcome = await Promise.race([
    modal.waitFor({ state: 'hidden', timeout }).then(() => 'closed').catch(() => 'pending'),
    errorBox.waitFor({ timeout }).then(() => 'failed').catch(() => 'pending'),
  ]);
  const elapsedMs = Date.now() - startedAt;
  if (outcome === 'closed') return { ok: true, elapsedMs };
  const error = await errorBox.innerText().catch(() => 'échec sans message lisible');
  return { ok: false, phase: 'génération', error: error.trim(), elapsedMs };
}

// ── ComfyUI (`AiImagesSection` des Préférences, `ImageField` en Inspecteur) ──
//
// Configuration par l'interface des Préférences (section « Images IA »,
// `id="comfyui"`) : active la génération, renseigne le script de démarrage.
export async function configureComfyuiViaPreferences(page, launcherPath) {
  const dialog = await openPreferences(page);
  const section = dialog.locator('#comfyui');
  await section.waitFor({ timeout: 10_000 });
  const toggle = section.locator('button.tog').first();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await section.getByPlaceholder('Chemin vers start_comfyui.bat, start_comfyui.sh ou un launcher').fill(launcherPath);
  return dialog;
}

// Importe un workflow personnalisé (paire `*-api.json` / `*.config.json`,
// même mécanisme que « Importer un workflow custom » de `AiImagesSection.jsx`)
// pendant que les Préférences sont encore ouvertes (`dialog` renvoyé par
// `configureComfyuiViaPreferences`). Referme les Préférences à la fin.
export async function importComfyuiWorkflowViaPreferences(page, dialog, { apiJsonPath, configJsonPath }) {
  const section = dialog.locator('#comfyui');
  await answerNext(page, 'open', apiJsonPath);
  await clickButton(section, 'Choisir *-api.json…');
  await answerNext(page, 'open', configJsonPath);
  await clickButton(section, 'Choisir *.config.json…');
  await clickButton(section, 'Importer', { timeout: 10_000 });
  await page.waitForTimeout(800);
  const error = await section.locator('.info-box.warn').first().innerText().catch(() => null);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  return { ok: !error, error };
}

// Sélectionne le premier Écran de la liste (l'Écran racine, toujours présent
// et épinglé en tête) pour ouvrir son Inspecteur — c'est là que vit l'image
// de couverture (`StageEditor.jsx`, `ImageField fieldId="advanced:cover"`).
export async function selectRootGraphStage(page) {
  const item = page.locator('li[role="option"][data-kind="stage"]:visible').first();
  await item.click();
  await page.waitForTimeout(200);
}

/**
 * Cycle complet ComfyUI depuis l'Inspecteur d'un Écran (graphe) : clic sur
 * « Générer avec l'IA (ComfyUI) » (`.image-tool--ai`, ciblé par classe : son
 * `aria-label` porte une apostrophe typographique fragile à recopier) →
 * choix du workflow (déjà sélectionné par défaut s'il est seul dans la
 * liste) → « Générer » → job dans la file IA (`SDQueuePanel`, ouverte
 * automatiquement par `handleOpenAiQueue`) → `.sd-job-done`/`.sd-job-error`.
 * `submit_job_sync` (Rust) démarre ComfyUI lui-même si besoin
 * (`ensure_comfyui_sync`, jusqu'à 180 s) : c'est ce geste, pas un bouton
 * « Tester », qui déclenche le démarrage « selon ce que propose l'app ».
 */
export async function runComfyuiGenerate(page, { workflowName = 'Scene depuis prompt', timeout = 6 * 60_000 } = {}) {
  const aiBtn = page.locator('.image-tool--ai:visible').first();
  await aiBtn.waitFor({ timeout: 15_000 });
  await aiBtn.click();
  const modal = page.locator('.sd-generate-box').first();
  await modal.waitFor({ timeout: 15_000 });
  const wfCard = modal.locator('.sd-workflow-card', { hasText: workflowName }).first();
  const workflowFound = await wfCard.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (workflowFound) await wfCard.click();
  const startedAt = Date.now();
  await clickButton(modal, 'Générer', { timeout: 15_000 });
  await modal.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  const doneRow = page.locator('.sd-queue-row.sd-job-done').first();
  const errorRow = page.locator('.sd-queue-row.sd-job-error').first();
  const outcome = await Promise.race([
    doneRow.waitFor({ timeout }).then(() => 'done').catch(() => 'pending'),
    errorRow.waitFor({ timeout }).then(() => 'error').catch(() => 'pending'),
  ]);
  const elapsedMs = Date.now() - startedAt;
  if (outcome === 'done') return { ok: true, elapsedMs, workflowFound };
  const error = await errorRow.locator('.sd-result-error').first().innerText().catch(() => 'échec sans message lisible');
  return { ok: false, error: error.trim(), elapsedMs, workflowFound, outcome };
}

// ── Filet de sécurité process (XTTS/ComfyUI, en dehors de la WebView2) ──────
//
// `killTree` (`launch.mjs`, `taskkill /T /F` sur le process racine de
// `tauri dev`) tue en principe tout le sous-arbre, y compris un serveur
// XTTS/ComfyUI démarré comme processus enfant — mais le vérifie plutôt que de
// le supposer. Interroge tous les `python.exe` du poste (jamais un autre nom
// de process : jamais un faux positif sur `cmd.exe`/`powershell.exe`, y
// compris CETTE requête elle-même) puis filtre **côté JS** sur le chemin de
// l'exécutable — jamais dans la clause PowerShell, pour ne jamais faire
// correspondre la commande de diagnostic à elle-même si le dossier XTTS ou
// ComfyUI apparaissait dans sa propre ligne de commande.
export function listStrayAiProcesses(dirs) {
  if (process.platform !== 'win32') return [];
  const targets = dirs.filter(Boolean).map((d) => d.toLowerCase());
  if (targets.length === 0) return [];
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" | '
    + 'Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress';
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const out = (result.stdout || '').trim();
  if (!out) return [];
  let parsed;
  try { parsed = JSON.parse(out); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((proc) => {
    const exe = String(proc.ExecutablePath || '').toLowerCase();
    return targets.some((dir) => exe.startsWith(dir));
  });
}

export function killStrayAiProcesses(dirs) {
  const stray = listStrayAiProcesses(dirs);
  for (const proc of stray) {
    spawnSync('taskkill', ['/PID', String(proc.ProcessId), '/T', '/F'], { stdio: 'ignore' });
  }
  return stray;
}
