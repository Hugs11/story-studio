// Agrégation des relevés du banc d'essai en tableaux Markdown.
//
// Elle ne décide rien et ne compare rien d'elle-même : elle range côte à côte
// ce que les deux moteurs ont réellement produit sur les **mêmes** fixtures.
// Le verdict, lui, s'écrit à la main, dans le compte rendu, avec ses motifs.
//
// ```text
// node scripts/bench-report.mjs bench/artifacts/graph/mesures/*.json
// ```

import fs from 'node:fs/promises';

const MEGABYTE = 1e6;

function cell(value, unit = '') {
  if (value === null || value === undefined) return '—';
  return `${value}${unit}`;
}

// Le pic de mémoire résidente du processus de rendu pendant une fenêtre de
// temps donnée. C'est le seul relevé mémoire disponible sous WebKitGTK, et le
// rapport doit dire que c'est celui-là qu'il cite.
function peakResident(samples, fromMs, toMs) {
  let peak = 0;
  let first = null;
  let last = null;
  for (const record of samples) {
    if (record.at < fromMs || record.at > toMs) continue;
    const web = record.rows.filter((row) => row.role === 'webkit-web');
    const total = web.reduce((sum, row) => sum + row.rssBytes, 0);
    if (total === 0) continue;
    if (first === null) first = total;
    last = total;
    peak = Math.max(peak, total);
  }
  return { peak, first, last };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readSamples(file) {
  try {
    const contents = await fs.readFile(file, 'utf8');
    return contents
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function phaseWindow(report, phase, engine, profile) {
  const marks = (report.serverPhases ?? report.phases ?? []).filter(
    (mark) => mark.engine === engine && mark.profile === profile,
  );
  const start = marks.find((mark) => mark.phase === `${phase}:start`);
  const end = marks.find((mark) => mark.phase === `${phase}:end`);
  return start && end ? { from: start.at, to: end.at } : null;
}

function loadTable(reports) {
  const lines = [
    '| Profil | Nœuds | Arêtes | Moteur | 1er affichage | Reprises médiane | Reprises p95 |',
    '|---|---:|---:|---|---:|---:|---:|',
  ];
  for (const report of reports) {
    for (const result of report.results) {
      lines.push(
        `| ${result.profile} | ${result.counts.declared.nodes} | ${result.counts.declared.edges} `
        + `| ${result.engine} | ${cell(result.firstLoad.firstUsablePaintMs, ' ms')} `
        + `| ${cell(result.reloads?.median, ' ms')} | ${cell(result.reloads?.p95, ' ms')} |`,
      );
    }
  }
  return lines.join('\n');
}

function interactionTable(reports) {
  const lines = [
    '| Profil | Moteur | Sélection p95 | Cadrage p95 | Recherche p95 | pan/zoom i/s | Intervalle p95 |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const report of reports) {
    for (const result of report.results) {
      lines.push(
        `| ${result.profile} | ${result.engine} `
        + `| ${cell(result.interactions.selection?.p95, ' ms')} `
        + `| ${cell(result.interactions.focus?.p95, ' ms')} `
        + `| ${cell(result.interactions.search?.p95, ' ms')} `
        + `| ${cell(result.panZoom.fps)} | ${cell(result.panZoom.frameIntervalMs?.p95, ' ms')} |`,
      );
    }
  }
  return lines.join('\n');
}

function memoryTable(reports, samples) {
  const lines = [
    '| Profil | Moteur | Phase | RSS début | RSS pic | RSS fin | Delta |',
    '|---|---|---|---:|---:|---:|---:|',
  ];
  for (const report of reports) {
    for (const result of report.results) {
      for (const phase of ['sustained', 'panzoom', 'recycle']) {
        const window = phaseWindow(report, phase, result.engine, result.profile);
        if (!window) continue;
        const { peak, first, last } = peakResident(samples, window.from, window.to);
        if (first === null) continue;
        lines.push(
          `| ${result.profile} | ${result.engine} | ${phase} `
          + `| ${(first / MEGABYTE).toFixed(0)} Mo | ${(peak / MEGABYTE).toFixed(0)} Mo `
          + `| ${(last / MEGABYTE).toFixed(0)} Mo | ${((last - first) / MEGABYTE).toFixed(0)} Mo |`,
        );
      }
    }
  }
  return lines.join('\n');
}

function failureList(reports) {
  const failures = reports.flatMap((report) => report.failures ?? []);
  if (failures.length === 0) return '_Aucun plantage, gel ou refus pendant les relevés retenus._';
  return failures
    .map((failure) => `- **${failure.engine ?? '—'} / ${failure.profile ?? '—'}** (${failure.stage}) : ${failure.message}`)
    .join('\n');
}

async function main() {
  const files = process.argv.slice(2).filter((file) => file.endsWith('.json'));
  if (files.length === 0) {
    process.stderr.write('usage : node bench-report.mjs <relevés .json...>\n');
    process.exit(1);
  }
  const reports = [];
  for (const file of files) reports.push(await readJson(file));
  const samples = [];
  for (const file of files) {
    const candidate = file.replace(/[^/]+$/, 'memoire-fedora-etape1-court.jsonl');
    samples.push(...await readSamples(candidate));
  }

  const first = reports[0];
  process.stdout.write(`## Contexte\n\n`);
  process.stdout.write(`- WebView : \`${first.userAgent}\`\n`);
  process.stdout.write(`- Viewport : ${first.viewport.width}x${first.viewport.height} @ dpr ${first.viewport.dpr}\n`);
  process.stdout.write(`- Renderer forcé : ${first.renderer}\n`);
  process.stdout.write(`- Relevés : ${files.map((file) => `\`${file.split('/').pop()}\``).join(', ')}\n\n`);
  process.stdout.write(`## Chargement\n\n${loadTable(reports)}\n\n`);
  process.stdout.write(`## Interaction et fluidité\n\n${interactionTable(reports)}\n\n`);
  process.stdout.write(`## Mémoire résidente du processus de rendu\n\n${memoryTable(reports, samples)}\n\n`);
  process.stdout.write(`## Plantages, gels et refus\n\n${failureList(reports)}\n`);
}

await main();
