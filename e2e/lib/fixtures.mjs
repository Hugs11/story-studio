// Médias de test réutilisables.
//
// - `extractFixtureMedia` : extraction d'un audio et d'une image du fixture
//   repo `advanced-export/export-mvp.zip` (aucune donnée personnelle, déjà
//   versionné) avec le `7z` fourni à l'app — utile aux funnels qui demandent
//   un fichier « normal » (image/audio) hors pack, comme l'audio et l'image
//   racine d'« Agréger des packs ».
// - `synthTone` / `synthImage` : médias synthétiques générés par le `ffmpeg`
//   fourni à l'app (aucune extraction, aucune dépendance au corpus) — une
//   tonalité à fréquence distincte et une image de couleur distincte par
//   appel, pour qu'on puisse reconnaître chaque média produit dans une trace
//   ou un audit de chemins.
// - `difficultPathsRoot` : un jeu de dossiers « chemins difficiles » sous un
//   répertoire donné (toujours sous `%TEMP%\ss-e2e\`, jamais dans le vrai
//   workspace) — espaces, accents, chemin long (> 200 caractères au total),
//   et deux dossiers portant chacun un fichier de même nom.
// - `probeAudio` : oracle de lisibilité/durée (micro) avec le même
//   `ffmpeg` — aucun `ffprobe.exe` n'est fourni à l'app, seul `ffmpeg.exe`
//   l'est. `-i` seul renseigne `Duration:` dans stderr avant de refuser
//   l'absence de sortie (code non nul, sans rapport avec la lisibilité) ;
//   un second passage, décodage complet vers `-f null -`, est l'oracle de
//   lisibilité réelle (code 0 et stderr vide en `-v error`).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR } from './config.mjs';
import { mediaTool } from './media-tools.mjs';

const SEVEN_ZIP = mediaTool('7z');
const FFMPEG = mediaTool('ffmpeg');
const FIXTURE_ZIP = join(REPO_DIR, 'src-tauri', 'tests', 'fixtures', 'advanced-export', 'export-mvp.zip');

export function extractFixtureMedia(destDir) {
  const result = spawnSync(SEVEN_ZIP, ['x', FIXTURE_ZIP, `-o${destDir}`, 'assets/cover.png', 'assets/intro.wav', '-y'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Extraction des médias fixture impossible :\n${result.stdout || result.stderr}`);
  }
  return {
    image: join(destDir, 'assets', 'cover.png'),
    audio: join(destDir, 'assets', 'intro.wav'),
  };
}

function runFfmpeg(args, label) {
  const result = spawnSync(FFMPEG, ['-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg (${label}) a échoué :\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
}

/**
 * Tonalité `.wav` d'une seconde à `frequencyHz`, reconnaissable dans une
 * trace de simulation. `destDir` est créé au besoin.
 */
export function synthTone(destDir, fileName, frequencyHz = 440, durationSec = 1) {
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, fileName);
  runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=${frequencyHz}:duration=${durationSec}`,
    path,
  ], `tone ${frequencyHz}Hz`);
  return path;
}

// Palette de couleurs bien distinctes, reconnaissables à l'œil sur une capture.
const IMAGE_COLORS = ['red', 'blue', 'green', 'yellow', 'magenta', 'cyan', 'orange', 'purple'];

/**
 * Image `.png` de couleur unie, distincte par `colorIndex`. `destDir` est
 * créé au besoin.
 */
export function synthImage(destDir, fileName, colorIndex = 0) {
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, fileName);
  const color = IMAGE_COLORS[colorIndex % IMAGE_COLORS.length];
  runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=1`,
    '-frames:v', '1',
    path,
  ], `image ${color}`);
  return path;
}

/**
 * Jeu de dossiers « chemins difficiles » sous `baseDir` (toujours à
 * l'appelant de le placer sous `%TEMP%\ss-e2e\`). Renvoie les 4 dossiers :
 * `spaces` (espaces), `accents` (accents), `long` (chemin total > 200
 * caractères) et `homonymsA`/`homonymsB` (même nom de fichier dans deux
 * dossiers distincts).
 */
/**
 * Lisibilité et durée d'un fichier audio quelconque (webm/wav…), sans juger
 * la qualité du son : présence, durée (s) et décodage complet sans erreur.
 * `readable` n'exige rien de la première commande (dont le code non nul est
 * attendu, faute de sortie) : seule la seconde compte pour la lisibilité.
 */
export function probeAudio(filePath) {
  const info = spawnSync(FFMPEG, ['-i', filePath], { encoding: 'utf8' });
  const stderrInfo = info.stderr || '';
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrInfo);
  const durationSec = match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : null;
  const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', filePath, '-f', 'null', '-'], { encoding: 'utf8' });
  const decodeErr = (decode.stderr || '').trim();
  return {
    readable: decode.status === 0 && decodeErr === '',
    durationSec,
    decodeError: decodeErr || null,
  };
}

/**
 * Lisibilité d'une image quelconque (ComfyUI) sans dépendance externe
 * (aucun décodeur d'image n'est fourni à l'app) : signature de fichier (PNG,
 * JPEG) et, pour PNG, dimensions lues directement dans le chunk `IHDR`
 * (largeur/hauteur, octets 16-23, big-endian) — un fait, jamais une
 * supposition sur la taille écrite dans l'en-tête. Une taille de fichier non
 * nulle est vérifiée dans tous les cas.
 */
export function probeImage(filePath) {
  const size = statSync(filePath).size;
  if (size === 0) return { readable: false, size, format: null, width: null, height: null };
  const buf = readFileSync(filePath);
  const isPng = buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { readable: width > 0 && height > 0, size, format: 'png', width, height };
  }
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (isJpeg) return { readable: true, size, format: 'jpeg', width: null, height: null };
  return { readable: false, size, format: null, width: null, height: null };
}

export function difficultPathsRoot(baseDir) {
  const spaces = join(baseDir, 'dossier avec espaces');
  const accents = join(baseDir, 'dossier accentué éàçßÉ');
  // Segment répété pour dépasser 200 caractères au total sans dépendre de la
  // profondeur de `baseDir` (variable selon %TEMP%).
  const longSegment = 'sous-dossier-avec-un-nom-particulierement-long-pour-tester-les-chemins-Windows-au-dela-de-la-limite-usuelle';
  const long = join(baseDir, longSegment, longSegment.slice(0, 60));
  const homonymsA = join(baseDir, 'homonymes-dossier-A');
  const homonymsB = join(baseDir, 'homonymes-dossier-B');
  for (const dir of [spaces, accents, long, homonymsA, homonymsB]) mkdirSync(dir, { recursive: true });
  return { spaces, accents, long, homonymsA, homonymsB, totalLongPathLength: long.length };
}
