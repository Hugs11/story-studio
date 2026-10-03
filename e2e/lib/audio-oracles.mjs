import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaTool } from './media-tools.mjs';

// MP3 q5 : bruit de quantification et reconstruction des crêtes. Les marges
// restent inférieures à la différence entre un son chaud et le plafond.
export const LEVEL_TOLERANCE_LU = 0.7;
export const PEAK_TOLERANCE_DB = 1.0;
// Deux fenêtres RMS de 1024/44100, garde de trim 20 ms et une trame MP3
// de 26 ms : 100 ms couvre ces résolutions sans masquer les cibles choisies.
export const EDGE_TOLERANCE_SEC = 0.1;
export const CONTENT_TOLERANCE_SEC = 0.15;
export const LIMITER_DBFS = -2;
export const MP3_TRUE_PEAK_MARGIN_DB = 1.5;
// Le contenu le plus faible est à -30 LUFS ; -50 dB sépare ses salves
// continues des zéros et du bruit de bord MP3. 40 ms ignore les passages
// individuels par zéro, tout en détectant le plus petit bord (100 ms).
export const SILENCE_THRESHOLD_DB = -50;
export const SILENCE_MIN_SEC = 0.04;

export function ffmpeg(args, logPath = null) {
  const result = spawnSync(mediaTool('ffmpeg'), ['-hide_banner', '-nostats', '-y', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (logPath) writeFileSync(logPath, result.stderr || '');
  if (result.status !== 0) throw new Error(`ffmpeg ${JSON.stringify(args)}\n${result.error || result.stderr}`);
  return result.stderr;
}

export function measureAudio(path, logPrefix) {
  const log = ffmpeg(['-i', path, '-af', `ebur128=peak=true,astats=metadata=0:reset=0,silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MIN_SEC}`, '-f', 'null', '-'], `${logPrefix}.log`);
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const number = expression => {
    const match = expression.exec(log);
    if (!match || !Number.isFinite(Number(match[1]))) throw new Error(`Mesure absente : ${expression} (${path})`);
    return Number(match[1]);
  };
  const durationMatch = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log);
  if (!durationMatch) throw new Error(`Durée absente : ${path}`);
  const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  const intervals = [];
  let start = null;
  for (const match of log.matchAll(/silence_(start|end):\s*([\d.e+-]+)/g)) {
    if (match[1] === 'start') start = Number(match[2]);
    else if (start !== null) { intervals.push([start, Number(match[2])]); start = null; }
  }
  if (start !== null) intervals.push([start, duration]);
  const leading = intervals.find(([a]) => a < 0.01)?.[1] || 0;
  const last = intervals.at(-1);
  const trailing = last && Math.abs(last[1] - duration) < 0.04 ? Math.max(0, duration - last[0]) : 0;
  const integrated = /Integrated loudness:\s*I:\s*([-\d.]+)/.exec(summary);
  const peak = /True peak:\s*Peak:\s*([-\d.]+)/.exec(summary);
  if (!integrated || !peak) throw new Error(`Résumé EBU absent : ${path}`);
  const result = { path, duration, leading, trailing, content: duration - leading - trailing,
    lufs: Number(integrated[1]), truePeak: Number(peak[1]), samplePeak: number(/Peak level dB:\s*([-\d.]+)/) };
  // Le niveau du contenu est indépendant de la dilution des blocs EBU de
  // 400 ms aux bords. Le niveau intégré du fichier entier reste enregistré.
  const contentLog = ffmpeg(['-i', path, '-af', `atrim=start=${leading}:end=${duration - trailing},asetpts=PTS-STARTPTS,ebur128=peak=true`, '-f', 'null', '-'], `${logPrefix}-content.log`);
  const contentSummary = contentLog.slice(contentLog.lastIndexOf('Summary:'));
  result.contentLufs = Number(/Integrated loudness:\s*I:\s*([-\d.]+)/.exec(contentSummary)?.[1]);
  if (!Number.isFinite(result.contentLufs)) throw new Error(`Niveau du contenu absent : ${path}`);
  return result;
}

export function createAudioSources(dir) {
  mkdirSync(dir, { recursive: true });
  const specs = [
    { name: 'fort', seconds: 4, target: -14, leading: 0.2, trailing: 0.2 },
    { name: 'faible', seconds: 5.5, target: -30, leading: 3, trailing: 0.1 },
    { name: 'bande-morte', seconds: 7, target: -13.5, leading: 0.2, trailing: 0.2 },
    { name: 'chaud', seconds: 8.5, target: -9, leading: 0.2, trailing: 0.2 },
  ];
  return specs.map((spec, index) => {
    const raw = join(dir, `${spec.name}-contenu.wav`);
    // Bruit rose reproductible, spectre vocal, salves sans silence interne.
    // Compression de crête contrôlée pour garder la bande morte sans limiteur.
    ffmpeg(['-f', 'lavfi', '-i', `anoisesrc=color=pink:seed=${81 + index}:sample_rate=44100:duration=${spec.seconds}`,
      '-af', "highpass=f=150,lowpass=f=2500,aeval=tanh(val(0)*4)*(0.65+0.35*sin(2*PI*3*t)),lowpass=f=2500", '-c:a', 'pcm_f32le', raw]);
    const initial = measureAudio(raw, join(dir, `${spec.name}-initial`));
    const gain = spec.target - initial.contentLufs + (spec.name === 'chaud' ? 1.3 : 0);
    const path = join(dir, `${spec.name}.wav`);
    // Une salve tonale courte à pleine échelle, aux bornes sur un zéro,
    // éprouve les crêtes sans injecter un signal carré large bande.
    const hotPeak = spec.name === 'chaud' ? ",aeval=if(between(t\\,2\\,2.1)\\,sin(2*PI*735*t)\\,0.9*tanh(val(0)/0.9))" : '';
    // Fort reste dans la bande morte, mais sa salve de 20 ms dépasse -2 dBFS :
    // l'app doit réellement déclencher le limiteur, sans gain global.
    const limiterPeak = spec.name === 'fort' ? ",aeval=if(between(t\\,2\\,2.02)\\,0.95*sin(2*PI*750*t)\\,val(0))" : '';
    ffmpeg(['-i', raw, '-af', `volume=${gain}dB${hotPeak}${limiterPeak},adelay=${spec.leading * 1000},apad=pad_dur=${spec.trailing}`, '-c:a', 'pcm_f32le', path]);
    return { ...spec, ...measureAudio(path, join(dir, `${spec.name}-source`)), name: spec.name };
  });
}

export function extractArchive(zip, dir) {
  mkdirSync(dir, { recursive: true });
  const result = spawnSync(mediaTool('7z'), ['x', zip, `-o${dir}`, '-y'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'extract.log'), `${result.stdout}\n${result.stderr}`);
  if (result.status !== 0) throw new Error(`Extraction ${zip}\n${result.error || result.stdout || result.stderr}`);
  return JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8'));
}

export function matchAudio(measures, sources) {
  const matched = {};
  for (const measure of measures) {
    const candidates = sources.filter(source => Math.abs(source.content - measure.content) <= CONTENT_TOLERANCE_SEC);
    if (candidates.length !== 1) throw new Error(`Rattachement audio ambigu : ${JSON.stringify(measure)}`);
    const name = candidates[0].name;
    if (matched[name]) throw new Error(`Durée de contenu dupliquée : ${name}`);
    matched[name] = measure;
  }
  if (Object.keys(matched).length !== sources.length) throw new Error('Les quatre sources doivent être présentes');
  return matched;
}

export function audioChecks(measure, source, testCase, measuredLimiterPeak = LIMITER_DBFS) {
  const near = (a, b, tolerance) => Number.isFinite(a) && Math.abs(a - b) <= tolerance;
  const edges = testCase.silence === 'Ajuster' ? [0.7, 2.3]
    : testCase.silence === 'Ajouter' ? [source.leading + 0.7, source.trailing + 2.3] : [source.leading, source.trailing];
  const checks = {
    debut: near(measure.leading, edges[0], EDGE_TOLERANCE_SEC),
    fin: near(measure.trailing, edges[1], EDGE_TOLERANCE_SEC),
    contenu: near(measure.content, source.content, CONTENT_TOLERANCE_SEC),
  };
  if (testCase.harmonize) {
    checks.bande = measure.lufs >= -15.5 && measure.lufs <= -12.5;
    checks.plafond = measure.truePeak <= measuredLimiterPeak + MP3_TRUE_PEAK_MARGIN_DB;
    if (source.name === 'faible') checks.remonte = measure.contentLufs - source.contentLufs > 12;
    if (source.name === 'bande-morte') checks.niveauInchange = near(measure.contentLufs, source.contentLufs, LEVEL_TOLERANCE_LU);
    if (source.name === 'chaud') checks.limiteur = measure.truePeak <= measuredLimiterPeak + MP3_TRUE_PEAK_MARGIN_DB;
    if (source.name === 'fort') checks.limiteurDeclenche = measure.samplePeak < source.samplePeak - 1;
  } else {
    checks.niveauInchange = near(measure.contentLufs, source.contentLufs, LEVEL_TOLERANCE_LU);
    checks.integreInchange = near(measure.lufs, source.lufs, LEVEL_TOLERANCE_LU);
    checks.creteVraieInchangee = near(measure.truePeak, source.truePeak, PEAK_TOLERANCE_DB);
    checks.creteEchantillonInchangee = near(measure.samplePeak, source.samplePeak, PEAK_TOLERANCE_DB);
    if (source.name === 'faible') checks.resteFaible = measure.contentLufs < -25;
    if (source.name === 'chaud') checks.sansLimiteur = measure.samplePeak > -1;
  }
  return checks;
}
