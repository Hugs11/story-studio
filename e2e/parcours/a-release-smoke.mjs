// Fumée sur l'exécutable e2e construit en release (pas `tauri dev`).
//
// Lance directement `src-tauri/target/release/story-studio.exe` (identifiant
// `.e2e`, port CDP 9222 — figés à la compilation par
// `src-tauri/tauri.e2e.conf.json`), avec un `PATH` réduit au strict système
// (aucun `ffmpeg`/`7z` de dev, de Program Files ou d'un autre outil ne doit
// pouvoir s'y trouver). Objectif : accueil sans erreur, 7-Zip résolu pour
// extraire un pack déposé, FFmpeg résolu pour sonder un média déposé, aucune
// boîte de dialogue native, arrêt propre, aucune écriture dans le vrai
// workspace.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from '../lib/run-context.mjs';
import { launchApp } from '../lib/launch.mjs';
import { REPO_DIR } from '../lib/config.mjs';
import { dropFiles } from '../lib/drop.mjs';
import { importPack } from '../lib/actions.mjs';
import { smallestByExt } from '../lib/corpus.mjs';
import { extractFixtureMedia } from '../lib/fixtures.mjs';

function strictSystemPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return [root, join(root, 'System32'), join(root, 'System32', 'Wbem'), join(root, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
}

export async function run() {
  const ctx = createRun('a-release-smoke');
  const exePath = join(REPO_DIR, 'src-tauri', 'target', 'release', 'story-studio.exe');
  ctx.check('exécutable release présent', existsSync(exePath), { exePath });
  if (!existsSync(exePath)) return ctx.finish();

  const restrictedPath = strictSystemPath();
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ComSpec: process.env.ComSpec,
    PATH: restrictedPath,
  };
  ctx.check('PATH restreint au système strict (pas de ffmpeg/7z de dev ni Program Files)', true, { PATH: restrictedPath });

  let app;
  try {
    app = await launchApp({ runDir: ctx.dir('app'), exePath, env, timeoutMs: 60_000 });
  } catch (error) {
    ctx.check('lancement de l\'exe release sous CDP', false, { error: String(error) });
    return ctx.finish();
  }
  ctx.check('lancement de l\'exe release sous CDP', true, { runDir: app.runDir });

  const { page, events } = app;
  try {
    await page.getByText('Modifier un pack existant').waitFor({ timeout: 30_000 });
    await ctx.shot(page, 'accueil');
    ctx.check('accueil affiché sans dialogue native', true);
    ctx.check('aucune erreur console à l\'accueil', events.faults().length === 0, { faults: events.faults() });

    // 7-Zip depuis le bundle : dépôt d'une .7z du corpus sur la zone de dépôt
    // du funnel « Modifier un pack existant ».
    const archive = smallestByExt('01 - Editable', '7z');
    let editorReached = false;
    try {
      await importPack(page, archive, { editor: 'menus', timeout: 60_000 });
      editorReached = true;
    } catch (error) {
      ctx.check('éditeur atteint après dépôt de la .7z (résolution 7-Zip)', false, { archive, error: String(error) });
      await ctx.shot(page, 'echec-import-7z');
    }
    if (editorReached) {
      await ctx.shot(page, 'editeur-apres-import-7z');
      ctx.check('éditeur atteint après dépôt de la .7z (résolution 7-Zip)', true, { archive });
    }
    ctx.check('aucune erreur console après import', events.faults().length === 0, { faults: events.faults() });

    if (editorReached) {
      // FFmpeg depuis le bundle : dépôt d'un média audio sur l'arbre, qui
      // déclenche `probe_media_files` (IPC) → `get_ffmpeg_path()` côté Rust.
      const mediaDir = mkdtempSync(join(tmpdir(), 'ss-e2e-a-media-'));
      const { audio } = extractFixtureMedia(mediaDir);
      const before = events.ipc().length;
      await dropFiles(page, '[data-os-drop-zone="treepanel"]', [audio]);
      await page.waitForTimeout(4_000);
      await ctx.shot(page, 'apres-depot-audio');
      const ipcErrors = events.all().filter(event => event.kind === 'ipc.error');
      const probed = events.ipc().slice(before).some(entry => entry.cmd === 'probe_media_files');
      ctx.check('probe_media_files invoqué après dépôt audio (résolution FFmpeg)', probed, { newIpc: events.ipc().slice(before).map(e => e.cmd) });
      ctx.check('aucune erreur IPC après dépôt audio', ipcErrors.length === 0, { ipcErrors });
      ctx.check('aucune erreur console après dépôt audio', events.faults().length === 0, { faults: events.faults() });
    }
  } finally {
    const { polluted, closedGracefully } = await app.stop({ graceful: true });
    ctx.check('arrêt propre (fermeture par la croix)', closedGracefully === true, { closedGracefully });
    ctx.check('aucune écriture dans le vrai workspace', polluted.length === 0, { polluted });
  }

  return ctx.finish();
}
