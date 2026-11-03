import { beginProjectMediaOutput } from '../../store/projectMediaOutput';
// Export PNG 320x240 d'une edition d'image vers le filesystem Tauri.
// Extrait de ImageEditorModal.jsx : isole le pipeline canvas -> blob -> fichier
// vers un emplacement géré du workspace effectif, ou vers le cache temporaire
// pour les anciens contextes qui n'ont pas besoin d'un média autonome durable.

import { writeFile, mkdir, remove, exists } from '@tauri-apps/plugin-fs';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { logger } from '../../utils/logger';
import { TEMP_IMAGES_DIR } from '../../utils/tempDirs';
import {
  buildEditedImageFileName,
} from '../../store/workspaceDirs';
import { joinPath } from '../../utils/fileUtils';
import { renderFrame, CANVAS_W, CANVAS_H } from './useImageEditor';
import { imageEditMetadataPath, writeImageEditMetadata } from '../../store/imageEditMetadata';

const MAX_FILENAME_ATTEMPTS = 10_000;

function isAlreadyExistsError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes('already exists')
    || message.includes('file exists')
    || message.includes('os error 80')
    || message.includes('os error 183');
}

async function writeUniqueImage({ directory, sourcePath, bytes }) {
  for (let collisionIndex = 1; collisionIndex <= MAX_FILENAME_ATTEMPTS; collisionIndex += 1) {
    const candidate = joinPath(directory, buildEditedImageFileName(sourcePath, collisionIndex));
    if (await exists(candidate)) continue;
    try {
      await writeFile(candidate, bytes, { createNew: true });
      return candidate;
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
  }
  // eslint-disable-next-line i18next/no-literal-string -- diagnostic technique journalisé ; l'interface affiche media:imageEditor.export.failed.
  throw new Error('Impossible de trouver un nom disponible pour l’image modifiée.');
}

async function cleanupIncompleteExport(imagePath) {
  const metadataPath = imageEditMetadataPath(imagePath);
  await Promise.all([
    remove(imagePath).catch(() => {}),
    metadataPath ? remove(metadataPath).catch(() => {}) : Promise.resolve(),
  ]);
}

// Rend l'image dans un canvas offscreen 320x240, écrit le PNG et son sidecar,
// puis retourne seulement un chemin entièrement finalisé.
export async function exportEditedImage({
  image,
  transform,
  filters,
  sourcePath,
  outputNameSourcePath = sourcePath,
  workspaceDir = '',
  mediaStorage = null,
  requireManagedOutput = false,
}) {
  const output = workspaceDir?.trim() ? beginProjectMediaOutput(mediaStorage ?? { root: workspaceDir, ephemeral: true }) : null;
  try {
    const offscreen = document.createElement('canvas');
    offscreen.width = CANVAS_W;
    offscreen.height = CANVAS_H;
    renderFrame(offscreen, image, transform, filters);

    const blob = await new Promise((resolve) => offscreen.toBlob(resolve, 'image/png'));
    // eslint-disable-next-line i18next/no-literal-string -- diagnostic technique journalisé ; l'éditeur affiche media:imageEditor.export.failed.
    if (!blob) throw new Error('Canvas export returned null blob');
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const managedWorkspace = workspaceDir?.trim();
    if (requireManagedOutput && !managedWorkspace) {
      // eslint-disable-next-line i18next/no-literal-string -- diagnostic technique journalisé ; le texte affiché est userMessageRef.
      const error = new Error('Aucun workspace géré n’est disponible pour enregistrer ce nouveau média.');
      // Descripteur résolu à l'affichage par l'éditeur d'image (langue active).
      error.userMessageRef = { key: 'media:imageEditor.export.noWorkspace' };
      throw error;
    }

    const write = async (directory) => {
    await mkdir(directory, { recursive: true });

    const finalPath = await writeUniqueImage({
      directory,
      sourcePath: outputNameSourcePath,
      bytes,
    });
    try {
      await writeImageEditMetadata(finalPath, { sourcePath, transform, filters }, { strict: true });
      return finalPath;
    } catch (error) {
      await cleanupIncompleteExport(finalPath);
      logger.warn('image-editor:incomplete-export-cleaned', finalPath);
      throw error;
    }
    };
    if (managedWorkspace) return await write(await output.directory('images-generees'));
    return await write(await join(await appCacheDir(), TEMP_IMAGES_DIR));
  } finally { output?.release(); }
}
