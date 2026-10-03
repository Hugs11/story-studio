// Mesures « Écran d'entrée » sur le story.json SOURCE de chaque archive du corpus (sans l'app).
// Usage : node e2e/mesures/entree-source.mjs [dossierSortie]
// Sortie : entree-source.jsonl (une ligne par story.json ou erreur) + entree-source-resume.md.
// Lit corpusDir via la config e2e ; ne modifie jamais le corpus (extraction sous %TEMP%\ss-e2e\mesures).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_DIR, config, requireConfig } from '../lib/config.mjs';

const SEVEN_ZIP = join(REPO_DIR, 'src-tauri', 'tools', '7z.exe');
const MAX_NEST = 3;

// Mesures pures sur un story.json STUdio déjà parsé.
export function measureStory(story) {
  const stages = Array.isArray(story?.stageNodes) ? story.stageNodes : [];
  const actions = Array.isArray(story?.actionNodes) ? story.actionNodes : [];
  const entries = stages.filter((s) => s.squareOne === true);
  const entryUuid = entries.length === 1 ? entries[0].uuid : null;
  const entryUuids = new Set(entries.map((s) => s.uuid));
  const actionById = new Map(actions.map((a) => [a.id, a]));

  const optionActionIds = [];
  let optionsToEntry = 0;
  for (const a of actions) {
    let n = 0;
    for (const o of a.options ?? []) if (entryUuids.has(o)) n += 1;
    if (n) { optionsToEntry += n; optionActionIds.push(a.id); }
  }

  const noDest = (s) => s.homeTransition == null;
  const entryHomeActiveNoDest = entries.some((s) => s.controlSettings?.home === true && noDest(s));

  let entrySelfLoop = false;
  let otherSelfLoops = 0;
  for (const s of stages) {
    const ht = s.homeTransition;
    if (!ht) continue;
    const target = actionById.get(ht.actionNode)?.options?.[ht.optionIndex];
    if (target !== undefined && target === s.uuid) {
      if (s.squareOne === true) entrySelfLoop = true; else otherSelfLoops += 1;
    }
  }

  // Règle de src/store/advancedGraphView/defaultHomeReturns.js : entrée unique requise ;
  // un Écran autre que l'entrée avec Accueil actif (=== true) et sans homeTransition
  // renvoie à l'entrée (retour Lunii dérivé). Rien sur l'entrée elle-même, ni si l'entrée n'est pas unique.
  let derivedHomeReturns = 0;
  if (entryUuid) {
    for (const s of stages) {
      if (s.uuid === entryUuid) continue;
      if (s.controlSettings?.home === true && noDest(s)) derivedHomeReturns += 1;
    }
  }

  // okTransition dont l'action propose l'entrée parmi ses options.
  let okTransitionToEntry = 0;
  for (const s of stages) {
    const ok = s.okTransition;
    if (!ok) continue;
    const opts = actionById.get(ok.actionNode)?.options ?? [];
    if (opts.some((o) => entryUuids.has(o))) okTransitionToEntry += 1;
  }

  return {
    stageCount: stages.length, actionCount: actions.length, hasEntry: entries.length,
    optionsToEntry, optionsToEntryActions: optionActionIds,
    entryHomeActiveNoDest, entrySelfLoop, otherSelfLoops, derivedHomeReturns, okTransitionToEntry,
  };
}

function sevenZip(args, opts = {}) {
  return spawnSync(SEVEN_ZIP, ['-sccUTF-8', ...args], { maxBuffer: 1 << 30, ...opts });
}

function listArchive(archive) {
  const r = sevenZip(['l', '-slt', '-ba', archive], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`7z l : ${(r.stderr || r.stdout || '').trim().split('\n')[0] || `code ${r.status}`}`);
  const items = [];
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const path = /^Path = (.*)$/m.exec(block)?.[1];
    if (!path) continue;
    const attr = /^Attributes = (.*)$/m.exec(block)?.[1] ?? '';
    const folder = /^Folder = (.*)$/m.exec(block)?.[1] === '+' || attr.startsWith('D');
    if (!folder) items.push(path);
  }
  return items;
}

// Mesure tous les story.json d'une archive (récursif sur les archives imbriquées).
function measureArchive(archive, inner, depth, tmpRoot, out) {
  let items;
  try { items = listArchive(archive); } catch (e) { out.push({ inner, error: e.message }); return; }
  const stories = items.filter((p) => basename(p.replace(/\\/g, '/')).toLowerCase() === 'story.json');
  const nested = items.filter((p) => /\.(zip|7z)$/i.test(p));
  for (const p of stories) {
    const label = inner ? `${inner}!${p}` : p;
    const r = sevenZip(['e', '-so', archive, p]);
    if (r.status !== 0) { out.push({ inner: label, error: `7z e : code ${r.status}` }); continue; }
    try { out.push({ inner: label, ...measureStory(JSON.parse(r.stdout.toString('utf8').replace(/^﻿/, ''))) }); }
    catch (e) { out.push({ inner: label, error: `story.json illisible : ${e.message}` }); }
  }
  if (depth < MAX_NEST) {
    for (const p of nested) {
      const dir = mkdtempSync(join(tmpRoot, 'n-'));
      const r = sevenZip(['x', archive, `-o${dir}`, p, '-y'], { encoding: 'utf8' });
      const label = inner ? `${inner}!${p}` : p;
      if (r.status !== 0) { out.push({ inner: label, error: '7z x imbriqué échoué' }); rmSync(dir, { recursive: true, force: true }); continue; }
      measureArchive(join(dir, p), label, depth + 1, tmpRoot, out);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function walk(dir) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'Triage avance') found.push(...walk(p)); }
    else if (/\.(zip|7z)$/i.test(e.name)) found.push(p);
  }
  return found;
}

function main() {
  const corpus = requireConfig('corpusDir');
  const outDir = resolve(process.argv[2] ?? config.entrySourceReportDir);
  mkdirSync(outDir, { recursive: true });
  const tmpRoot = join(tmpdir(), 'ss-e2e', 'mesures');
  mkdirSync(tmpRoot, { recursive: true });
  const rows = [];
  const archives = walk(corpus).sort();
  for (const a of archives) {
    const rel = relative(corpus, a);
    const base = { category: rel.split(/[\\/]/)[0], relPath: rel.replace(/\\/g, '/'), ext: extname(a).slice(1).toLowerCase(), sizeBytes: statSync(a).size };
    const out = [];
    measureArchive(a, null, 0, tmpRoot, out);
    if (!out.length) out.push({ inner: null, noStoryJson: true });
    for (const o of out) rows.push({ ...base, ...o });
  }
  writeFileSync(join(outDir, 'entree-source.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(outDir, 'entree-source-resume.md'), summarize(archives.length, rows));
  console.log(`${archives.length} archives, ${rows.length} lignes -> ${outDir}`);
}

function summarize(nArch, rows) {
  const L = ['# Mesures Écran d\'entrée sur le story.json source\n', `${nArch} archives, ${rows.length} lignes.\n`];
  const grp = new Map();
  for (const r of rows) {
    const k = `${r.category} | ${r.ext}`;
    const g = grp.get(k) ?? { archives: new Set(), stories: 0, errors: 0, none: 0 };
    g.archives.add(r.relPath);
    if (r.error) g.errors += 1; else if (r.noStoryJson) g.none += 1; else g.stories += 1;
    grp.set(k, g);
  }
  L.push('## Totaux par catégorie et format\n', '| Catégorie | Format | Archives | story.json mesurés | Erreurs | Sans story.json |', '|---|---|---|---|---|---|');
  for (const [k, g] of [...grp].sort()) { const [c, e] = k.split(' | '); L.push(`| ${c} | ${e} | ${g.archives.size} | ${g.stories} | ${g.errors} | ${g.none} |`); }
  const ok = rows.filter((r) => !r.error && !r.noStoryJson);
  const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
  L.push('', '## Totaux des mesures\n',
    `- optionsToEntry : ${sum((r) => r.optionsToEntry)} options (${ok.filter((r) => r.optionsToEntry).length} story.json)`,
    `- entryHomeActiveNoDest : ${ok.filter((r) => r.entryHomeActiveNoDest).length} story.json`,
    `- entrySelfLoop : ${ok.filter((r) => r.entrySelfLoop).length} story.json`,
    `- otherSelfLoops : ${sum((r) => r.otherSelfLoops)} Écrans (${ok.filter((r) => r.otherSelfLoops).length} story.json)`,
    `- derivedHomeReturns : ${sum((r) => r.derivedHomeReturns)} liens (${ok.filter((r) => r.derivedHomeReturns).length} story.json)`,
    `- okTransitionToEntry : ${sum((r) => r.okTransitionToEntry)} (${ok.filter((r) => r.okTransitionToEntry).length} story.json)`,
    `- hasEntry différent de 1 : ${ok.filter((r) => r.hasEntry !== 1).length} story.json`);
  const list = (title, pred, fmt) => {
    const sel = ok.filter(pred);
    L.push('', `## ${title} (${sel.length})\n`, ...sel.map((r) => `- ${r.category} / ${r.relPath}${r.inner ? ` [${r.inner}]` : ''}${fmt ? ` : ${fmt(r)}` : ''}`));
  };
  list('optionsToEntry > 0', (r) => r.optionsToEntry > 0, (r) => `${r.optionsToEntry} option(s), actions ${r.optionsToEntryActions.join(', ')}`);
  list('entryHomeActiveNoDest', (r) => r.entryHomeActiveNoDest);
  list('entrySelfLoop', (r) => r.entrySelfLoop);
  list('otherSelfLoops > 0', (r) => r.otherSelfLoops > 0, (r) => `${r.otherSelfLoops}`);
  list('derivedHomeReturns > 0', (r) => r.derivedHomeReturns > 0, (r) => `${r.derivedHomeReturns}`);
  const bad = rows.filter((r) => r.error || r.noStoryJson);
  L.push('', `## Erreurs et archives sans story.json (${bad.length})\n`, ...bad.map((r) => `- ${r.category} / ${r.relPath}${r.inner ? ` [${r.inner}]` : ''} : ${r.error ?? 'aucun story.json'}`));
  return L.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
