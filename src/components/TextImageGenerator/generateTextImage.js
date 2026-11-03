import { translateAi as t } from '../../i18n/aiPresentation.js';
import { beginProjectMediaOutput } from '../../store/projectMediaOutput';
import { logger } from '../../utils/logger';
import { writeFile, mkdir } from '@tauri-apps/plugin-fs';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { TEXT_IMG_W, TEXT_IMG_H, drawTextImage } from './drawTextImage';
import { TEMP_IMAGES_DIR } from '../../utils/tempDirs';

// Un nom de fichier imposé (`exemple-<uuid>.png` pour les exemples du graphe)
// doit rester un simple nom PNG : jamais un chemin. Sans lui, le nom historique
// horodaté est conservé pour les autres appelants.
const SAFE_IMAGE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/;

export async function generateTextImage(text, workspaceDir = '', { filename: requestedFilename = null, mediaStorage = null } = {}) {
  if (requestedFilename !== null && !SAFE_IMAGE_FILENAME.test(requestedFilename)) {
    throw new TypeError(t("ai:textImage.filename.invalid"));
  }
  const output = workspaceDir?.trim() ? beginProjectMediaOutput(mediaStorage ?? { root: workspaceDir, ephemeral: true }) : null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TEXT_IMG_W;
    canvas.height = TEXT_IMG_H;
    drawTextImage(canvas.getContext('2d'), text);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const buf = await blob.arrayBuffer();
    const filename = requestedFilename ?? `edited_${Date.now()}.png`;

    const managedWorkspace = workspaceDir?.trim();
    if (managedWorkspace) {
      try {
        return await (async () => {
          const destDir = await output.directory('images-generees');
          await mkdir(destDir, { recursive: true });
          for (let index = 1; index <= 1000; index += 1) {
            const destPath = await join(destDir, index === 1 ? filename : filename.replace(/\.png$/, `_${index}.png`));
            try { await writeFile(destPath, new Uint8Array(buf), { createNew: true }); return destPath; }
            catch (error) { if (!/already exists|file exists|os error (80|183)/i.test(String(error))) throw error; }
          }
          throw new Error(t("ai:textImage.filename.tooMany"));
        })();
      } catch (error) {
        logger.warn('text-image:workspace-output-failed-cache-fallback', error);
        mediaStorage?.onFallback?.();
      }
    }

    const cacheDir = await join(await appCacheDir(), TEMP_IMAGES_DIR);
    await mkdir(cacheDir, { recursive: true });
    const cachePath = await join(cacheDir, filename);
    await writeFile(cachePath, new Uint8Array(buf));
    return cachePath;
  } finally { output?.release(); }
}
