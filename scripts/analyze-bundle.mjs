// Analyse rapide du dist/bundle-stats.html genere par rollup-plugin-visualizer.
// Usage : node scripts/analyze-bundle.mjs

import fs from 'node:fs';

const html = fs.readFileSync('dist/bundle-stats.html', 'utf8');
const cwdPrefix = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
const marker = 'const data = ';
const idx = html.indexOf(marker);
if (idx < 0) {
  console.error("Bloc 'const data = ' introuvable dans bundle-stats.html");
  process.exit(1);
}

// Parser le JSON en suivant l'imbrication des accolades.
const jsonStart = idx + marker.length;
let depth = 0;
let end = jsonStart;
let inStr = false;
let escape = false;
for (let i = jsonStart; i < html.length; i++) {
  const c = html[i];
  if (escape) { escape = false; continue; }
  if (inStr) {
    if (c === '\\') escape = true;
    else if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') inStr = true;
  else if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}

const data = JSON.parse(html.slice(jsonStart, end));

// Indexer par chunk : moduleParts contient chunk -> partUid
const byChunk = new Map();
for (const meta of Object.values(data.nodeMetas || {})) {
  for (const [chunkName, partUid] of Object.entries(meta.moduleParts || {})) {
    const part = data.nodeParts?.[partUid];
    if (!part) continue;
    if (!byChunk.has(chunkName)) byChunk.set(chunkName, []);
    byChunk.get(chunkName).push({
      id: meta.id,
      gz: part.gzipLength || 0,
      raw: part.renderedLength || 0,
    });
  }
}

const sortedChunks = [...byChunk.entries()]
  .map(([name, mods]) => ({ name, mods, total: mods.reduce((s, m) => s + m.gz, 0) }))
  .sort((a, b) => b.total - a.total);

function displayModuleId(id) {
  const normalized = id.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const cwdLower = cwdPrefix.toLowerCase();
  const withoutCwd = lower.startsWith(`${cwdLower}/`)
    ? normalized.slice(cwdPrefix.length + 1)
    : normalized;

  return withoutCwd.replace(/^.*node_modules\//, 'NM/');
}

for (const chunk of sortedChunks) {
  if (chunk.total < 3000) continue;
  console.log('---');
  console.log(`CHUNK ${chunk.name} | total gz ${chunk.total}`);
  chunk.mods.sort((a, b) => b.gz - a.gz);
  for (const m of chunk.mods.slice(0, 20)) {
    const id = displayModuleId(m.id);
    console.log(`  ${String(m.gz).padStart(7)} gz | ${String(m.raw).padStart(8)} raw | ${id}`);
  }
}
