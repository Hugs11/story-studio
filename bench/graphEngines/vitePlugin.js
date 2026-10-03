// Plumberie **de développement seulement** du banc d'essai des moteurs de graphe.
//
// Elle sert les fixtures du banc et recueille ses relevés. Elle n'est active
// que lorsque `VITE_BENCH=graph` est posé : `apply: 'serve'` la retire de tout
// build, et la garde d'environnement la retire même du serveur de
// développement ordinaire. Aucune de ces routes n'existe dans l'application
// livrée.
//
// Les relevés sont écrits dans un dossier local configurable, hors git.

import fs from 'node:fs/promises';
import { loadEnv } from 'vite';
import nodePath from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FIXTURE_DIR = 'src-tauri/tests/fixtures/graph-view';
const EXPORT_FIXTURE_DIR = 'src-tauri/tests/fixtures/advanced-export';

// Les trois modes de banc partagent cette plomberie : le criblage des moteurs
// (`graph`), la surface de lecture (`surface`) et l'atelier d'édition
// (`atelier`). Chacun dépose ses relevés dans **son** dossier de sortie ; sans
// cela, les relevés d'un mode iraient s'écrire dans ceux d'un autre.
const BENCH_MODES = new Set(['graph', 'surface', 'atelier', 'export', 'recette']);

// Rendre un dossier non inscriptible, puis le rendre à nouveau : c'est la seule
// façon d'obtenir un vrai `output-write` du moteur plutôt que de le simuler.
//
// Les bits de mode POSIX n'ont pas d'effet sous Windows, où le droit d'écriture
// est porté par l'ACL : le banc y pose un refus explicite pour le compte
// courant, et le retire de la même manière. Ailleurs, `chmod` suffit.
//
// Le verdict n'est jamais déduit de la plateforme : il est **constaté** par une
// écriture d'essai. Un `chmod` sans effet — compte privilégié, montage
// particulier, système de fichiers sans permissions — ferait sinon passer un
// dossier ordinaire pour un dossier verrouillé, et le cas serait déclaré tenu
// sans avoir rien éprouvé.
function currentAccount() {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  return domain ? [domain, user].join(String.fromCharCode(92)) : user;
}

async function denyWrites(directory) {
  if (process.platform !== 'win32') return fs.chmod(directory, 0o500);
  return run('icacls', [directory, '/deny', `${currentAccount()}:(WD,AD)`]);
}

async function allowWrites(directory) {
  if (process.platform !== 'win32') return fs.chmod(directory, 0o700);
  return run('icacls', [directory, '/remove:d', currentAccount()]);
}

async function canWrite(directory) {
  const probe = nodePath.join(directory, `.ecriture-${process.pid}`);
  try {
    await fs.writeFile(probe, 'x');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Le bac à sable du banc d'export : workspace, sorties et copies de packs y
// vivent, **hors du dépôt**. Rien de ce que ce banc écrit n'est destiné à être
// versionné — ce sont des archives et des projets d'essai.
const DEFAULT_EXPORT_SANDBOX = nodePath.join(os.tmpdir(), 'story-studio-bench-export');

// Le bac à sable des vignettes de recette. Les fixtures de graphe portent des
// références média mais **aucun fichier** : sans lui, la surface se mesure avec
// zéro vignette chargée, et le critère « 600 surimpressions et toutes les
// vignettes chargées » ne serait jamais exercé. Ces images sont fabriquées,
// jetables, hors du dépôt.
const MEDIA_SANDBOX = nodePath.join(os.tmpdir(), 'story-studio-recette-vignettes');


// --- Vignettes fabriquées pour la recette ------------------------------------
//
// Un PNG écrit à la main, sans dépendance nouvelle. Le motif est **bruité et
// propre à chaque référence** : une image d'aplat se compresse et se décode
// presque gratuitement, et mesurer la charge du graphe sur des aplats
// flatterait le résultat. Ce n'est pas pour autant une photographie de pack —
// le relevé le dit, et ne conclut pas au-delà.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function noisyPng(size, seed) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 bits par canal
  header[9] = 2; // couleur vraie, sans alpha
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  // Générateur déterministe : deux exécutions rendent les mêmes octets, donc
  // deux campagnes restent comparables.
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state & 0xff;
  };
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filtre « none »
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = next();
      raw[at + 1] = next();
      raw[at + 2] = next();
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Une seule extension servie, et aucun chemin composé : le banc demande un nom
// de profil, pas un chemin. Un `..` ne peut donc pas sortir du dossier.
const SAFE_NAME = /^[a-z0-9-]+\.(?:view|payload)\.json$|^manifest\.json$/;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function benchGraphEnginesPlugin({ root = process.cwd() } = {}) {
  const phaseLog = [];
  return {
    name: 'story-studio:bench-graph-engines',
    apply: 'serve',
    configureServer(server) {
      const mode = process.env.VITE_BENCH;
      if (!BENCH_MODES.has(mode)) return;
      const env = loadEnv(server.config.mode, root, 'SS_BENCH_');
      const outputRoot = nodePath.resolve(root,
        process.env[`SS_BENCH_${mode.toUpperCase()}_OUTPUT_DIR`]
          || env[`SS_BENCH_${mode.toUpperCase()}_OUTPUT_DIR`]
          || nodePath.join('bench', 'artifacts', mode));
      const EXPORT_SANDBOX = nodePath.resolve(root,
        process.env.SS_BENCH_EXPORT_SANDBOX || env.SS_BENCH_EXPORT_SANDBOX || DEFAULT_EXPORT_SANDBOX);
      const RESULT_DIR = `${outputRoot}/mesures`;
      const CAPTURE_DIR = `${outputRoot}/captures`;
      server.config.logger.info(`[banc] routes /__bench actives en mode ${mode} (développement seulement)`);

      server.middlewares.use('/__bench/fixture', async (request, response, next) => {
        const name = decodeURIComponent((request.url ?? '').replace(/^\//, '').split('?')[0]);
        if (!SAFE_NAME.test(name)) {
          response.statusCode = 400;
          response.end('nom de fixture refusé');
          return;
        }
        try {
          const file = nodePath.join(root, FIXTURE_DIR, name);
          const contents = await fs.readFile(file);
          response.setHeader('content-type', 'application/json');
          // Les DTO des gros profils pèsent plusieurs dizaines de Mo : les
          // laisser mettre en cache fausserait la mesure du transport.
          response.setHeader('cache-control', 'no-store');
          response.end(contents);
        } catch {
          next();
        }
      });


      // Les vignettes de la recette : une image par **référence d'asset** que
      // le banc nomme, écrite dans un bac à sable hors du dépôt. Le banc
      // envoie les références qu'il a lues dans le DTO ; il ne compose aucun
      // chemin, et le nom de fichier est dérivé ici du rang, pas de la
      // référence — une référence d'auteur n'a pas à devenir un nom de fichier.
      server.middlewares.use('/__bench/media-sandbox', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        const { assetRefs, size = 96 } = await readBody(request);
        if (!Array.isArray(assetRefs) || assetRefs.length === 0 || assetRefs.length > 4096) {
          response.statusCode = 400;
          response.end('références refusées');
          return;
        }
        const edge = Math.min(256, Math.max(8, Number(size) || 96));
        const directory = nodePath.join(MEDIA_SANDBOX, `run-${Date.now()}`);
        await fs.mkdir(directory, { recursive: true });
        const bindings = [];
        let written = 0;
        for (const [rank, assetRef] of assetRefs.entries()) {
          if (typeof assetRef !== 'string' || assetRef.length === 0) continue;
          const file = nodePath.join(directory, `vignette-${String(rank).padStart(4, '0')}.png`);
          await fs.writeFile(file, noisyPng(edge, rank + 1));
          written += 1;
          bindings.push({ assetRef, path: file, status: 'resolved' });
        }
        server.config.logger.info(`[banc] ${written} vignette(s) ${edge}×${edge} écrites dans ${directory}`);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ directory, bindings, size: edge }));
      });

      // Le contexte disque du banc d'export. Le navigateur ne connaît pas le
      // système de fichiers ; ces chemins absolus lui sont donnés par le
      // serveur de développement, qui les crée d'abord. Aucun d'eux n'est dans
      // le dépôt.
      server.middlewares.use('/__bench/export-context', async (request, response) => {
        const sandbox = nodePath.join(EXPORT_SANDBOX, `run-${Date.now()}`);
        const context = {
          fixtureDir: nodePath.join(root, EXPORT_FIXTURE_DIR),
          sandbox,
          workspaceDir: nodePath.join(sandbox, 'workspace'),
          projectsDir: nodePath.join(sandbox, 'projets'),
          movedProjectsDir: nodePath.join(sandbox, 'projets-deplaces'),
          outputDir: nodePath.join(sandbox, 'sorties'),
          readOnlyDir: nodePath.join(sandbox, 'sorties-verrouillees'),
          separator: nodePath.sep,
        };
        await fs.mkdir(context.workspaceDir, { recursive: true });
        await fs.mkdir(context.projectsDir, { recursive: true });
        await fs.mkdir(context.movedProjectsDir, { recursive: true });
        await fs.mkdir(context.outputDir, { recursive: true });
        await fs.mkdir(context.readOnlyDir, { recursive: true });
        // Un dossier réellement non inscriptible, par le moyen qu'accepte la
        // plateforme, puis constaté par une écriture d'essai.
        try {
          await denyWrites(context.readOnlyDir);
        } catch {
          // Le constat ci-dessous tranche : inutile de distinguer ici l'échec
          // de la commande de son absence d'effet.
        }
        context.readOnlyEnforced = !(await canWrite(context.readOnlyDir));
        // Les fixtures sont produites, jamais versionnées : si elles manquent,
        // le banc le dit au lieu d'échouer sur un fichier absent.
        try {
          await fs.access(nodePath.join(context.fixtureDir, 'manifest.json'));
          context.fixturesReady = true;
        } catch {
          context.fixturesReady = false;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(context));
      });

      // Opérations disque que le banc ne peut pas faire lui-même : déplacer un
      // dossier de projet, retirer un média, rendre un dossier inscriptible à
      // nouveau. Elles restent **confinées au bac à sable** : un chemin qui
      // n'en vient pas est refusé.
      server.middlewares.use('/__bench/export-fs', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        const { action, path: target, to } = await readBody(request);
        const inside = (candidate) => typeof candidate === 'string'
          && nodePath.resolve(candidate).startsWith(EXPORT_SANDBOX + nodePath.sep);
        if (!inside(target) || (to !== undefined && !inside(to))) {
          response.statusCode = 400;
          response.end('chemin hors du bac à sable du banc');
          return;
        }
        try {
          if (action === 'move') await fs.rename(target, to);
          else if (action === 'mkdir') await fs.mkdir(target, { recursive: true });
          else if (action === 'remove') await fs.rm(target, { force: true, recursive: true });
          else if (action === 'make-writable') await allowWrites(target);
          else if (action === 'list') {
            const entries = await fs.readdir(target);
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ ok: true, entries }));
            return;
          } else {
            response.statusCode = 400;
            response.end('action inconnue');
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end('{"ok":true}');
        } catch (error) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        }
      });

      server.middlewares.use('/__bench/phase', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        const mark = await readBody(request);
        phaseLog.push(mark);
        // Les marques sortent aussi sur la console du serveur : c'est ce qui
        // permet à l'échantillonnage mémoire externe de savoir ce que la
        // WebView faisait à cet instant.
        server.config.logger.info(`[banc] ${mark.at} ${mark.phase} ${mark.engine ?? ''} ${mark.profile ?? ''}`);
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
      });

      // Les captures viennent du **moteur** qui a peint le rendu, jamais d'une
      // capture d'écran : rien de ce qui se trouve à l'écran au même moment ne
      // peut s'y retrouver.
      server.middlewares.use('/__bench/capture', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        const { name, dataUrl } = await readBody(request);
        if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^data:image\/png;base64,/.test(dataUrl ?? '')) {
          response.statusCode = 400;
          response.end('capture refusée');
          return;
        }
        const directory = CAPTURE_DIR;
        await fs.mkdir(directory, { recursive: true });
        const file = nodePath.join(directory, `${name}.png`);
        await fs.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
        server.config.logger.info(`[banc] capture écrite : ${file}`);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ file: nodePath.relative(root, file) }));
      });

      server.middlewares.use('/__bench/result', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        const report = await readBody(request);
        report.serverPhases = phaseLog.slice();
        const directory = RESULT_DIR;
        await fs.mkdir(directory, { recursive: true });
        // Un fichier par **campagne**, réécrit à chaque envoi : les relevés
        // intermédiaires remplacent le précédent au lieu de s'accumuler, et le
        // dernier écrit est toujours le plus complet.
        const name = report.runId
          ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${report.label ?? 'banc'}`;
        const file = nodePath.join(directory, `${name}.json`);
        await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        server.config.logger.info(`[banc] relevé écrit : ${file}`);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ file: nodePath.relative(root, file) }));
      });
    },
  };
}
