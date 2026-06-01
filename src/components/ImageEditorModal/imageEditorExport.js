// Export PNG 320x240 d'une edition d'image vers le filesystem Tauri.
// Extrait de ImageEditorModal.jsx : isole le pipeline canvas -> blob -> fichier
// temp -> copie eventuelle dans le workspace.

import { writeFile, mkdir, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join, tempDir } from '@tauri-apps/api/path';
import { logger } from '../../utils/logger';
import { TEMP_IMAGES_DIR } from '../../utils/tempDirs';
import { KEYS, read } from '../../store/persistentSettings';
import { renderFrame, CANVAS_W, CANVAS_H } from './useImageEditor';
import { writeImageEditMetadata } from './imageEditMetadata';

// Rend l'image dans un canvas offscreen 320x240, ecrit le PNG en cache temp,
// puis essaie de copier dans <workspace>/images-generees si workspace defini.
// Retourne le chemin final absolu.
export async function exportEditedImage({ image, transform, filters, sourcePath }) {
  const offscreen = document.createElement('canvas');
  offscreen.width = CANVAS_W;
  offscreen.height = CANVAS_H;
  renderFrame(offscreen, image, transform, filters);

  const blob = await new Promise((resolve) => offscreen.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Canvas export returned null blob');
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const filename = `edited_${Date.now()}.png`;
  await mkdir(TEMP_IMAGES_DIR, { baseDir: BaseDirectory.Temp, recursive: true });
  const tempRelPath = `${TEMP_IMAGES_DIR}/${filename}`;
  await writeFile(tempRelPath, bytes, { baseDir: BaseDirectory.Temp });
  const tmp = await tempDir();
  const tempAbsPath = await join(tmp, tempRelPath);

  let finalPath = tempAbsPath;
  const workspaceDir = read(KEYS.WORKSPACE_DIR);
  if (workspaceDir) {
    try {
      const destDir = `${workspaceDir}/images-generees`;
      await mkdir(destDir, { recursive: true });
      const destPath = `${destDir}/${filename}`;
      await copyFile(tempAbsPath, destPath);
      finalPath = destPath;
    } catch {
      // fallback : on garde tempAbsPath, l'erreur n'est pas bloquante.
      logger.warn?.('image-editor:workspace-copy-failed');
    }
  }

  await writeImageEditMetadata(finalPath, { sourcePath, transform, filters });
  return finalPath;
}
