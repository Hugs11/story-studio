import { writeFile, mkdir, copyFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join, tempDir } from '@tauri-apps/api/path';
import { TEXT_IMG_W, TEXT_IMG_H, drawTextImage } from './drawTextImage';
import { TEMP_IMAGES_DIR } from '../../utils/tempDirs';

const WORKSPACE_DIR_KEY = 'storyStudioWorkspaceDir';

export async function generateTextImage(text) {
  const canvas = document.createElement('canvas');
  canvas.width = TEXT_IMG_W;
  canvas.height = TEXT_IMG_H;
  drawTextImage(canvas.getContext('2d'), text);

  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const buf = await blob.arrayBuffer();
  const filename = `edited_${Date.now()}.png`;

  await mkdir(TEMP_IMAGES_DIR, { baseDir: BaseDirectory.Temp, recursive: true });
  const tempRelPath = `${TEMP_IMAGES_DIR}/${filename}`;
  await writeFile(tempRelPath, new Uint8Array(buf), { baseDir: BaseDirectory.Temp });
  const tmp = await tempDir();
  const tempAbsPath = await join(tmp, tempRelPath);

  const workspaceDir = localStorage.getItem(WORKSPACE_DIR_KEY);
  if (workspaceDir) {
    try {
      const destDir = `${workspaceDir}/images-generees`;
      await mkdir(destDir, { recursive: true });
      const destPath = `${destDir}/${filename}`;
      await copyFile(tempAbsPath, destPath);
      return destPath;
    } catch {
      // workspace copy failed — fall through to temp path
    }
  }

  return tempAbsPath;
}
