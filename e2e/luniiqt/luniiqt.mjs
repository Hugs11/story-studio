// Verdict Lunii.QT (o-daneel/Lunii.QT) sur une archive au format STUdio produite
// par Story Studio. Appelle `luniiqt_oracle.py` dans le venv isolé : code réel de
// Lunii.QT, appareil factice. Voir la section « Oracle Lunii.QT » du README.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function luniiqtDir() {
  return config.luniiqtDir || join(config.workDir, 'luniiqt');
}

function paths() {
  const dir = luniiqtDir();
  const python = join(dir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const clone = join(dir, 'Lunii.QT');
  if (!existsSync(python) || !existsSync(clone)) {
    throw new Error(`Oracle Lunii.QT non installé dans ${dir} : lancer « node e2e/luniiqt/setup.mjs ».`);
  }
  return { python, clone };
}

/** Verdict `{ ok, format_detected, stage_count, action_count, errors, warnings, elapsed_ms, ... }`. */
export function luniiqtVerdict(zipPath) {
  const { python, clone } = paths();
  const result = spawnSync(python, [join(HERE, 'luniiqt_oracle.py'), zipPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SS_LUNIIQT_CLONE: clone, PYTHONUTF8: '1' },
  });
  const line = (result.stdout || '').trim().split(/\r?\n/).pop();
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, errors: [`sortie illisible de l'oracle (code ${result.status}) : ${(result.stderr || result.stdout || '').slice(-500)}`], warnings: [] };
  }
}
