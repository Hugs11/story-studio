// Installation reproductible de l'oracle Lunii.QT : clone à un commit épinglé,
// venv Python 3.11 isolé, dépendances minimales (sans PySide6 : voir `stubs/`).
// Usage : node e2e/luniiqt/setup.mjs   (dossier : luniiqtDir, cf. luniiqt.mjs)
// Python : variable SS_E2E_PYTHON (défaut : `python` du PATH, 3.11 attendu).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { luniiqtDir } from './luniiqt.mjs';

export const LUNIIQT_COMMIT = 'c8afe43dde21c2be33c0667ced962dc023eb948a';
// Dépendances de lecture de pack (requirements.txt de Lunii.QT moins PySide6).
const DEPS = ['psutil~=7.1.3', 'py7zr~=0.22.0', 'xxtea~=3.6.0', 'requests~=2.32.5', 'pycryptodome==3.23.0',
  'pillow~=12.0.0', 'mutagen~=1.47.0', 'ffmpeg-python', 'unidecode~=1.4.0'];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Échec : ${cmd} ${args.join(' ')}`);
}

const dir = luniiqtDir();
mkdirSync(dir, { recursive: true });
const clone = join(dir, 'Lunii.QT');
if (!existsSync(clone)) run('git', ['clone', 'https://github.com/o-daneel/Lunii.QT.git', clone]);
run('git', ['fetch', '--quiet', 'origin'], clone);
run('git', ['checkout', '--quiet', LUNIIQT_COMMIT], clone);
const venv = join(dir, 'venv');
if (!existsSync(venv)) run(process.env.SS_E2E_PYTHON || 'python', ['-m', 'venv', venv]);
const python = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
run(python, ['-m', 'pip', 'install', '-q', ...DEPS]);
console.log(`Oracle Lunii.QT prêt dans ${dir} (commit ${LUNIIQT_COMMIT.slice(0, 8)}).`);
