import { rename } from '@tauri-apps/plugin-fs';
import { sanitizeProjectPrefix } from './projectPrefix';

export { sanitizeProjectPrefix };

export async function addProjectPrefix(path, projectName) {
  const prefix = sanitizeProjectPrefix(projectName);
  if (!prefix || !path) return path;
  const dir = path.replace(/[\\/][^\\/]+$/, '');
  const name = path.replace(/.*[\\/]/, '');
  if (name.startsWith(`${prefix}__`)) return path;
  const newPath = `${dir}/${prefix}__${name}`;
  await rename(path, newPath);
  return newPath;
}
