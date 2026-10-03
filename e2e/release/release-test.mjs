// Test de release, étage 1 : le corpus réduit passe par les vraies chaînes de
// l'app sans interface, puis chaque archive produite est relue par STUdio et
// Lunii.QT, et chaque entrée est comparée à son verdict attendu.
//
// Usage :
//   node e2e/release/release-test.mjs [--only motif1,motif2] [--reference resultats.json]
//
// - manifeste : `reducedCorpusFile` (lib/config.mjs), fichiers dans `corpus/` à côté ;
// - sorties : `<workDir>/release/<horodatage>/` (constats.jsonl, resultats.json, rapport.md),
//   ou `SS_RELEASE_OUT` ;
// - `--reference` : un `resultats.json` d'une release précédente, pour signaler
//   tout écart de nombre d'écrans ou de verdict.
// Aucun nom de pack n'est écrit dans ce fichier : ils viennent du manifeste privé.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { config, REPO_DIR } from '../lib/config.mjs';
import { loadReducedCorpus, reducedEntries } from '../lib/reduced-corpus.mjs';
import { studioVerdict } from '../studio/studio.mjs';
import { luniiqtVerdict } from '../luniiqt/luniiqt.mjs';
import { normalizeBaseProject, projectToRustExport } from '../../src/store/projectModel/schema.js';
import { fromProjectRelativeMediaPath, mapProjectMediaPaths } from '../../src/store/projectMediaPaths.js';
import { PACK_AUDIO_EDGE_SILENCE_SECONDS } from '../../src/config/audioProcessing.js';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = option('--only');
const referenceFile = option('--reference');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = process.env.SS_RELEASE_OUT || join(config.workDir, 'release', stamp);
mkdirSync(out, { recursive: true });
const log = (line) => console.log(line);

// Identifiant stable et lisible d'une entrée (sert aussi de nom de dossier de sortie).
const idOf = (entry) => basename(entry.file).replace(/\.(zip|7z|mbah)$/i, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// 1. Le corpus est-il celui du manifeste ?
const manifest = loadReducedCorpus();
let entries = reducedEntries().map((entry) => ({ ...entry, id: idOf(entry) }));
if (only) {
  const motifs = only.split(',').map((motif) => motif.trim()).filter(Boolean);
  entries = entries.filter((entry) => motifs.some((motif) => entry.file.includes(motif) || entry.id.includes(motif)));
}
log(`Manifeste : ${manifest.file} (${entries.length} entrée(s))`);
const corpusProblems = [];
for (const entry of entries) {
  if (!existsSync(entry.absPath)) corpusProblems.push(`absent : ${entry.file}`);
  else if (entry.sha256 && sha(entry.absPath) !== entry.sha256) corpusProblems.push(`sha256 différent : ${entry.file}`);
}
if (corpusProblems.length) {
  corpusProblems.forEach((problem) => log(`CORPUS ${problem}`));
  throw new Error('Le corpus ne correspond pas au manifeste : copie incomplète ou modifiée.');
}

// 2. Le plan : chemins absolus ; un projet est exporté par le code JS de l'app,
// ses médias ramenés en chemins absolus comme au chargement.
const plan = entries.map((entry) => {
  if (entry.kind !== 'projet') {
    return { id: entry.id, kind: 'pack', path: entry.absPath, afterFix: entry.expect?.afterFix?.resolution ?? null, determinism: !!entry.checkDeterminism };
  }
  const projectDir = dirname(entry.absPath);
  const loaded = normalizeBaseProject(JSON.parse(readFileSync(entry.absPath, 'utf8')));
  const resolved = mapProjectMediaPaths(loaded, (path) => fromProjectRelativeMediaPath(path, projectDir));
  const exported = projectToRustExport(resolved, {
    leading: PACK_AUDIO_EDGE_SILENCE_SECONDS,
    trailing: PACK_AUDIO_EDGE_SILENCE_SECONDS,
  });
  const jsonPath = join(out, 'projets', `${entry.id}.json`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(exported));
  return { id: entry.id, kind: 'projet', path: jsonPath, determinism: !!entry.checkDeterminism };
});
writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2));

// 3. Les chaînes réelles. En debug : seul ce profil accepte de désigner le
// FFmpeg et le 7-Zip fournis à l'app par variable d'environnement (l'app publiée
// les ignore), et c'est vrai sur les trois systèmes. Le test élargit la pile de
// chaque entrée : les cadres debug sont bien plus gros qu'en release.
log('Chaînes de l\'app (cargo test)…');
const tool = (name) => join(REPO_DIR, 'src-tauri', 'tools', process.platform === 'win32' ? `${name}.exe` : name);
const overrides = {};
if (!process.env.STORY_STUDIO_FFMPEG_PATH && existsSync(tool('ffmpeg'))) overrides.STORY_STUDIO_FFMPEG_PATH = tool('ffmpeg');
if (!process.env.STORY_STUDIO_7Z_PATH && existsSync(tool('7z'))) overrides.STORY_STUDIO_7Z_PATH = tool('7z');
const cargo = spawnSync('cargo', ['test', '--lib', 'release_corpus', '--', '--ignored', '--nocapture'], {
  cwd: join(REPO_DIR, 'src-tauri'),
  env: {
    ...process.env,
    SS_RELEASE_PLAN: join(out, 'plan.json'),
    SS_RELEASE_OUT: out,
    ...overrides,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (cargo.status !== 0) throw new Error(`Échec du test Rust (code ${cargo.status}).`);
const observed = new Map(readFileSync(join(out, 'constats.jsonl'), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line)).map((row) => [row.id, row]));

// 4. Relecture des archives produites, puis comparaison au verdict attendu.
// STUdio : conversion puis relecture du format appareil, avec le même nombre
// d'écrans. Le nombre de listes peut baisser à la relecture sans défaut : une
// transition à choix aléatoire y est représentée autrement (constaté le 30/09 :
// 5 listes aléatoires sur 71, tous les écrans relus). C'est noté, pas refusé.
const studioOk = (studio) => {
  if (studio.ok) return { ok: true, note: null };
  const readStages = Number(/stageNodes=(\d+)/.exec(studio.detail ?? '')?.[1]);
  const readActions = Number(/actionNodes=(\d+)/.exec(studio.detail ?? '')?.[1]);
  if (studio.convert === 'OK' && studio.readback === 'READBACK_OK' && readStages === studio.stageNodes) {
    return { ok: true, note: `listes relues ${readActions}/${studio.actionNodes}` };
  }
  return { ok: false, note: null };
};

const readback = (zip, tag) => {
  const studio = studioVerdict(zip, join(out, 'studio', tag));
  const studioCheck = studioOk(studio);
  const luniiqt = luniiqtVerdict(zip);
  return {
    studio: studioCheck.ok ? 'ok' : `refus : ${studio.convert}${studio.readback ? ` / ${studio.readback}` : ''}`,
    ...(studioCheck.note ? { studioNote: studioCheck.note } : {}),
    luniiqt: luniiqt.ok ? 'ok' : `refus : ${(luniiqt.errors || []).join(' ; ').slice(0, 200)}`,
    stages: studio.stageNodes ?? luniiqt.stage_count ?? null,
    actions: studio.actionNodes ?? luniiqt.action_count ?? null,
  };
};

const results = [];
for (const entry of entries) {
  const seen = observed.get(entry.id) ?? { openError: 'aucun constat' };
  const expect = entry.expect ?? {};
  const gaps = [];
  const outputs = {};
  const check = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) gaps.push(`${label} : attendu ${JSON.stringify(wanted)}, constaté ${JSON.stringify(actual)}`);
  };

  if (String(expect.open).startsWith('refus')) {
    if (!seen.openError && seen.open !== 'refus') gaps.push(`ouverture : refus attendu, constaté ${seen.open}`);
    else if (expect.message && !String(seen.openError).includes(expect.message)) gaps.push(`message de refus sans « ${expect.message} » : ${String(seen.openError).slice(0, 160)}`);
  } else if (seen.openError) {
    gaps.push(`ouverture : refus inattendu : ${String(seen.openError).slice(0, 160)}`);
  } else {
    if (entry.kind === 'pack') {
      check('ouverture', seen.open, expect.open);
      check('à corriger', [...(seen.blocking ?? [])].sort(), [...(expect.blocking ?? [])].sort());
    }
    if (expect.afterFix) {
      if (!seen.afterFix || seen.afterFix.error) gaps.push(`correction ${expect.afterFix.resolution} : ${seen.afterFix?.error ?? 'non appliquée'}`);
      else check('à corriger après correction', seen.afterFix.blocking, []);
    }
    // Le graphe génère si rien ne bloque, ou après la correction prévue. Les
    // menus ne dépendent pas des « à corriger » du graphe : ils génèrent dès
    // qu'ils ouvrent le pack.
    const wantGraph = entry.kind === 'pack' && (expect.generate === 'ok' || !!expect.afterFix);
    const wantMenus = entry.kind === 'projet' || expect.open === 'menus+graphe';
    for (const [chain, wanted] of [['graph', wantGraph], ['menus', wantMenus]]) {
      const result = seen[chain];
      if (!result) {
        if (wanted) gaps.push(`génération ${chain} : absente`);
        continue;
      }
      if (result.error) {
        if (wanted) gaps.push(`génération ${chain} refusée : ${String(result.error).slice(0, 200)}`);
        continue;
      }
      if (chain === 'graph' && !wanted) gaps.push('génération graphe : bloquée attendue, a généré');
      outputs[chain] = { zip: result.zip, ...readback(result.zip, `${entry.id}-${chain}`) };
      if (result.determinism) {
        outputs[chain].determinism = result.determinism.identical ? 'identique' : 'différent';
        if (!result.determinism.identical) {
          gaps.push(`déterminisme ${chain} : ${result.determinism.error ?? `entrées différentes : ${(result.determinism.differing ?? []).slice(0, 5).join(', ')}`}`);
        }
      } else if (entry.checkDeterminism) {
        gaps.push(`déterminisme ${chain} : non mesuré`);
      }
      if (outputs[chain].studio !== 'ok') gaps.push(`STUdio (${chain}) : ${outputs[chain].studio}`);
      if (outputs[chain].luniiqt !== 'ok') gaps.push(`Lunii.QT (${chain}) : ${outputs[chain].luniiqt}`);
    }
    if (expect.passerelle) {
      if (!seen.passerelle?.error) gaps.push('passerelle : refus attendu, a copié');
    } else if (seen.passerelle?.error) {
      gaps.push(`passerelle refusée : ${String(seen.passerelle.error).slice(0, 160)}`);
    }
  }
  if (expect.sourceReadback) {
    outputs.source = readback(entry.absPath, `${entry.id}-source`);
    if (outputs.source.studio !== 'ok' || outputs.source.luniiqt !== 'ok') gaps.push(`source non relue : STUdio ${outputs.source.studio}, Lunii.QT ${outputs.source.luniiqt}`);
  }
  results.push({ id: entry.id, file: entry.file, verdict: gaps.length ? 'ÉCART' : 'OK', gaps, observed: seen, outputs });
  log(`${gaps.length ? 'ÉCART' : 'OK   '} ${entry.id}${gaps.length ? `\n        ${gaps.join('\n        ')}` : ''}`);
}

// 5. Comparaison à la release précédente : nombre d'écrans et verdict.
const drift = [];
if (referenceFile) {
  const reference = new Map(JSON.parse(readFileSync(referenceFile, 'utf8')).results.map((row) => [row.id, row]));
  for (const row of results) {
    const before = reference.get(row.id);
    if (!before) continue;
    if (before.verdict !== row.verdict) drift.push(`${row.id} : verdict ${before.verdict} → ${row.verdict}`);
    for (const chain of ['graph', 'menus']) {
      const [a, b] = [before.outputs?.[chain]?.stages, row.outputs?.[chain]?.stages];
      if (a != null && b != null && a !== b) drift.push(`${row.id} : écrans ${chain} ${a} → ${b}`);
    }
  }
}

const failed = results.filter((row) => row.verdict !== 'OK');
writeFileSync(join(out, 'resultats.json'), JSON.stringify({ date: new Date().toISOString(), manifest: manifest.file, results, drift }, null, 2));
writeFileSync(join(out, 'rapport.md'), [
  `# Test de release, étage 1 — ${new Date().toLocaleString('fr-FR')}`,
  '',
  `${results.length} entrée(s) : ${results.length - failed.length} OK, ${failed.length} écart(s).${referenceFile ? ` Dérives vs référence : ${drift.length}.` : ''}`,
  '',
  '| Entrée | Verdict | Graphe | Menus | Écarts |',
  '|---|---|---|---|---|',
  ...results.map((row) => `| ${row.id} | ${row.verdict} | ${row.outputs.graph ? `${row.outputs.graph.stages} écrans` : '—'} | ${row.outputs.menus ? `${row.outputs.menus.stages} écrans` : '—'} | ${row.gaps.join(' ; ').replace(/\|/g, '/')} |`),
  ...(drift.length ? ['', '## Dérives par rapport à la référence', '', ...drift.map((line) => `- ${line}`)] : []),
  '',
].join('\n'));
log(`\n${results.length - failed.length}/${results.length} OK. Rapport : ${join(out, 'rapport.md')}`);
process.exitCode = failed.length || drift.length ? 1 : 0;
