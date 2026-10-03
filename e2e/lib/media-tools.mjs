import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR } from './config.mjs';

// Même résolution que le banc de release, sans imposer un suffixe Windows
// aux clones POSIX. Les outils fournis au dépôt ont priorité.
export function mediaTool(name) {
  const bundled = join(REPO_DIR, 'src-tauri', 'tools', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  return existsSync(bundled) ? bundled
    : process.env[name === 'ffmpeg' ? 'STORY_STUDIO_FFMPEG_PATH' : 'STORY_STUDIO_7Z_PATH'] || name;
}
