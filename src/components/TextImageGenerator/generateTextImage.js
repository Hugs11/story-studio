import { writeFile, mkdir } from '@tauri-apps/plugin-fs';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { TEXT_IMG_W, TEXT_IMG_H, drawTextImage } from './drawTextImage';
import { TEMP_IMAGES_DIR } from '../../utils/tempDirs';

export async function generateTextImage(text, workspaceDir = '') {
  const canvas = document.createElement('canvas');
  canvas.width = TEXT_IMG_W;
  canvas.height = TEXT_IMG_H;
  drawTextImage(canvas.getContext('2d'), text);

  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const buf = await blob.arrayBuffer();
  const filename = `edited_${Date.now()}.png`;

  const managedWorkspace = workspaceDir?.trim();
  if (managedWorkspace) {
    try {
      const destDir = await join(managedWorkspace, 'images-generees');
      await mkdir(destDir, { recursive: true });
      const destPath = await join(destDir, filename);
      await writeFile(destPath, new Uint8Array(buf));
      return destPath;
    } catch {
      // workspace write failed — fall through to the app-owned cache
    }
  }

  const cacheDir = await join(await appCacheDir(), TEMP_IMAGES_DIR);
  await mkdir(cacheDir, { recursive: true });
  const cachePath = await join(cacheDir, filename);
  await writeFile(cachePath, new Uint8Array(buf));
  return cachePath;
}
