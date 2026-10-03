// Échantillonnage mémoire **hors du processus**, pour le banc d'essai.
//
// WebKitGTK n'expose pas `performance.memory` : un relevé de tas JavaScript est
// impossible depuis la page sous Fedora. La mémoire est donc mesurée là où elle
// est réellement observable — la mémoire résidente des processus WebKit — et le
// rapport doit dire lequel des deux relevés il cite. Sous WebView2 et
// WKWebView, le relevé interne peut exister ; il ne remplace pas celui-ci, il
// s'y ajoute.
//
// Le critère du criblage est une **fuite** : une mémoire résidente qui croît
// continûment pendant un panoramique soutenu de dix minutes et ne redescend pas
// après destruction du composant. Une consommation élevée mais stable n'est pas
// une fuite, et n'élimine personne.
//
// ```text
// node scripts/bench-sample-memory.mjs --seconds 1500 --out mesures/memoire-fedora.jsonl
// ```

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Les processus qui portent la mémoire d'une WebView WebKitGTK : le processus
// de rendu (`WebKitWebProcess`) et le processus réseau. Le binaire Tauri
// lui-même est relevé à part : il porte le Rust, pas le canvas.
const PATTERNS = [
  { role: 'webkit-web', match: /WebKitWebProcess/ },
  { role: 'webkit-network', match: /WebKitNetworkProcess/ },
  // Le binaire Tauri lui-même, et lui seul : un motif plus large attraperait
  // les processus Node lancés depuis le dépôt, dont le chemin porte le même nom.
  { role: 'tauri', match: /target\/(?:debug|release)\/story-studio\b/ },
];

function parseArguments(argv) {
  const options = { seconds: 1_200, intervalMs: 1_000, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--seconds') options.seconds = Number(argv[index + 1]);
    if (argv[index] === '--interval-ms') options.intervalMs = Number(argv[index + 1]);
    if (argv[index] === '--out') options.out = argv[index + 1];
  }
  return options;
}

async function sample() {
  // `rss` en kibioctets, `comm`/`args` pour reconnaître le rôle. `ps` est
  // présent sur les trois plateformes cibles ; les motifs, eux, sont propres à
  // la WebView de chacune, et c'est pourquoi ils sont nommés ci-dessus.
  const { stdout } = await run('ps', ['-eo', 'pid=,rss=,args=']);
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, rss, args] = match;
    const pattern = PATTERNS.find((candidate) => candidate.match.test(args));
    if (!pattern) continue;
    rows.push({ pid: Number(pid), role: pattern.role, rssBytes: Number(rss) * 1024 });
  }
  return rows;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const stream = options.out ? fs.createWriteStream(options.out, { flags: 'a' }) : null;
  const deadline = Date.now() + options.seconds * 1_000;
  const peak = new Map();

  process.stdout.write(
    `échantillonnage ${options.seconds} s, toutes les ${options.intervalMs} ms`
    + `${options.out ? ` → ${options.out}` : ''}\n`,
  );

  while (Date.now() < deadline) {
    const rows = await sample();
    const record = { at: Date.now(), rows };
    if (stream) stream.write(`${JSON.stringify(record)}\n`);
    for (const row of rows) {
      const key = `${row.role}:${row.pid}`;
      peak.set(key, Math.max(peak.get(key) ?? 0, row.rssBytes));
    }
    await new Promise((resolve) => { setTimeout(resolve, options.intervalMs); });
  }

  stream?.end();
  process.stdout.write('\npics de mémoire résidente observés :\n');
  for (const [key, bytes] of [...peak.entries()].sort()) {
    process.stdout.write(`  ${key.padEnd(28)} ${(bytes / 1e6).toFixed(1)} Mo\n`);
  }
}

await main();
