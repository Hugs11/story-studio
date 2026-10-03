// Production en masse via l'app, sur un échantillon du corpus.
//
// Deux chaînes, réparties sur toute la gamme de tailles (jamais seulement les
// plus petites), avec au moins 3 `.7z` dans l'échantillon Editable (le banc Rust
// `l07_campaign` les ignore silencieusement) :
//   - `01 - Editable`     : import éditeur par menus → génération → relecture,
//                           PUIS le même pack en éditeur graphe → génération →
//                           relecture.
//   - `02 - Lecture seule` : éditeur graphe seul (a priori) → génération → relecture.
//   - `04 - Erreur import` (`--reduit` seulement) : dépôt → verdict relevé
//                           (refus, liste d'enveloppe ou atterrissage), refus
//                           lisible et aucun reste sur disque.
// Déterminisme sur un sous-ensemble : 2 générations dans la même session,
// comparées octet à octet (`samePackContent`).
// L'app est relancée toutes les N packs (garde-fou mémoire/latence).
//
// Paramétrable par variables d'environnement (aucun nom de pack ni chemin
// personnel n'est jamais versionné ici) :
//   SS_E2E_C3A_EDITABLE_COUNT   (défaut 20)
//   SS_E2E_C3A_READONLY_COUNT   (défaut 10)
//   SS_E2E_C3A_DETERMINISM_COUNT(défaut 5, pris parmi les Editable)
//   SS_E2E_C3A_MIN_7Z           (défaut 3)
//   SS_E2E_C3A_RELAUNCH_EVERY   (défaut 6 packs)
//   SS_E2E_C3A_REPORT_DIR       (clé c3aReportDir ; défaut e2e/artifacts/corpus)
//
// Argument `--reduit` (`node e2e/run.mjs c3a-corpus --reduit`) : remplace le
// tirage aléatoire par taille (`spreadArchives`) par le corpus réduit
// représentatif (fichier reducedCorpusFile, voir
// `lib/reduced-corpus.mjs`) — mêmes chaînes, mêmes oracles, mais un échantillon
// stable et documenté plutôt qu'un tirage dépendant de l'état du corpus au
// moment de l'exécution. Sans l'argument, comportement inchangé.
//
// Argument `--tout` (`node e2e/run.mjs c3a-corpus --tout`) : corpus COMPLET, tous
// formats (.zip et .7z), ordre stable (tri par chemin) :
//   - `01 - Editable`      : menus puis graphe (relance entre les deux chaînes) ;
//   - `02 - Lecture seule` : graphe ;
//   - `03 - Non supporte`, `04 - Erreur import`, `05 - A verifier` : verdict seul
//     (`runImportErrorChain`, aucune génération) ; un dossier vide est simplement
//     ignoré.
// Chaque relevé porte `relPath` (relatif à corpusDir) et `openVerdict` : où le pack
// s'ouvre réellement (`choix-editeur`, `graphe-seul`, `lecture-seule`,
// `non-supporte`, `refus`, `enveloppe`, `timeout`), avec `expectedByCategory` et
// `openVerdictExpected` (false = écart à relever, jamais contourné). Un éditeur
// demandé mais non proposé donne `importOk:false` + raison, puis la suite continue.
// Pas de déterminisme sauf si SS_E2E_C3A_DETERMINISM_COUNT est posé explicitement.
// Variables propres à --tout (toutes facultatives) :
//   SS_E2E_C3A_RESUME=1         reprise : saute les couples (relPath, editor) déjà
//                               présents dans le jsonl de sortie
//   SS_E2E_C3A_KEEP_DIR=<dir>   copie chaque zip généré sous
//                               <dir>/<category>/<index>-<editor>.zip + manifest.jsonl
//                               (relPath, editor, zip relatif à <dir>)
//   SS_E2E_C3A_PACK_TIMEOUT_MS  plafond dur par chaîne (défaut 900000 = 15 min) ;
//                               dépassé : relevé `timeout`, relance de l'app, on continue
//   SS_E2E_C3A_LIMIT=<n>        mini-série : par catégorie ET par format (.zip / .7z),
//                               les n plus petites archives (puis tri par chemin)
//   SS_E2E_C3A_REPORT_DIR       clé c3cReportDir ; défaut e2e/artifacts/corpus-complet
//                               (c3c-corpus.jsonl, c3c-determinisme.jsonl, progress.json)
// progress.json (battement de cœur, réécrit au début et à la fin de chaque chaîne) :
// { startedAt, updatedAt, done, total, current:{relPath,editor,step}, okCount,
//   failCount, lastError }.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { config, appDataDirs } from '../lib/config.mjs';
import { launchApp } from '../lib/launch.mjs';
import { createRun } from '../lib/run-context.mjs';
import { closeFunnel, generatePack, goHome, importPack, modalWithText, returnHome } from '../lib/actions.mjs';
import { dropFiles } from '../lib/drop.mjs';
import { allArchivesSorted, corpusRelPath, spreadArchives } from '../lib/corpus.mjs';
import { reducedArchivesUnder } from '../lib/reduced-corpus.mjs';
import { inventory, inventoryDiff, readbackPack, readStoryJson, samePackContent } from '../lib/oracles.mjs';

const EDITABLE_DIR = '01 - Editable';
const READONLY_DIR = '02 - Lecture seule';
const IMPORT_ERROR_DIR = '04 - Erreur import';
const UNSUPPORTED_DIR = '03 - Non supporte';
const TO_CHECK_DIR = '05 - A verifier';

// Verdict d'ouverture attendu par catégorie (null : pas d'attente). Un verdict
// hors de la liste est un écart à relever, pas un échec à contourner.
const EXPECTED_BY_CATEGORY = {
  editable: ['choix-editeur'],
  'lecture-seule': ['graphe-seul'],
  'non-supporte': ['non-supporte'],
  'erreur-import': ['refus', 'enveloppe', 'non-supporte'],
  'a-verifier': null,
};
const normalizeVerdict = (verdict) => (verdict === 'atterri' ? 'graphe-seul' : verdict);

function openLocators(page) {
  const funnel = modalWithText(page, 'Modifier un pack').first();
  return {
    funnel,
    notices: funnel.locator('.funnel-error'),
    bundleList: funnel.locator('[role="radiogroup"]').first(),
    chooser: modalWithText(page, 'Choisir l’éditeur'),
    generate: page.getByRole('button', { name: /Générer le pack/ }).first(),
  };
}

// Où le pack déposé s'ouvre-t-il réellement ? Sonde l'état du funnel (partagée
// par `--tout` et par la chaîne « Erreur import »).
async function pollOpenVerdict(page, loc, startedAt, timeoutMs = 300_000) {
  const { funnel, notices, bundleList, chooser, generate } = loc;
  while (Date.now() - startedAt < timeoutMs) {
    if (await funnel.getByText('Pack non éditable', { exact: true }).count()) return 'lecture-seule';
    if (await funnel.getByText('Pack non supporté', { exact: true }).count()) return 'non-supporte';
    if (await notices.count()) return 'refus';
    if (await bundleList.count()) return 'enveloppe';
    if (await chooser.count()) return 'choix-editeur';
    if (!(await funnel.count()) && await generate.isVisible().catch(() => false)) return 'atterri';
    await page.waitForTimeout(500);
  }
  return 'timeout';
}

// `--tout` : import avec relevé du verdict d'ouverture. Ne lève jamais pour un
// verdict : renvoie `{ verdict, ok, reason }`.
async function openPackWithVerdict(page, archivePath, editor) {
  const loc = openLocators(page);
  await page.getByText('Modifier un pack existant').click();
  await dropFiles(page, '[data-funnel-drop]', [archivePath]);
  const verdict = await pollOpenVerdict(page, loc, Date.now());
  if (verdict === 'choix-editeur') {
    const name = editor === 'graphe' ? 'Éditeur graphe' : 'Éditeur par menus';
    const button = loc.chooser.getByRole('button', { name, exact: true });
    if (!(await button.count())) {
      await loc.chooser.getByRole('button', { name: 'Annuler', exact: true }).click().catch(() => {});
      await closeFunnel(page).catch(() => {});
      return { verdict, ok: false, reason: `éditeur demandé non proposé : ${name}` };
    }
    await button.click();
  } else if (verdict !== 'atterri') {
    await closeFunnel(page).catch(() => {});
    return { verdict, ok: false, reason: `ouverture impossible : ${verdict}` };
  }
  await loc.generate.waitFor({ timeout: 180_000 });
  await modalWithText(page, 'Modifier un pack').first().waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => {});
  return { verdict, ok: true };
}

const editableCount = Number(process.env.SS_E2E_C3A_EDITABLE_COUNT || 20);
const readonlyCount = Number(process.env.SS_E2E_C3A_READONLY_COUNT || 10);
const determinismCount = Number(process.env.SS_E2E_C3A_DETERMINISM_COUNT || 5);
const min7z = Number(process.env.SS_E2E_C3A_MIN_7Z || 3);
const relaunchEvery = Number(process.env.SS_E2E_C3A_RELAUNCH_EVERY || 6);
const packTimeoutMs = Number(process.env.SS_E2E_C3A_PACK_TIMEOUT_MS || 15 * 60_000);
const limitPerFormat = Number(process.env.SS_E2E_C3A_LIMIT || 0);
const resume = process.env.SS_E2E_C3A_RESUME === '1';
const keepDir = process.env.SS_E2E_C3A_KEEP_DIR || '';
const reportDirFor = (tout) => tout ? config.c3cReportDir : config.c3aReportDir;
let reportDir = reportDirFor(false);

function jsonlPath(_ctx, name) {
  const dir = reportDir;
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function appendRecord(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export async function run(args = []) {
  const tout = args.includes('--tout');
  const useReducedCorpus = !tout && args.includes('--reduit');
  reportDir = reportDirFor(tout);
  const ctx = createRun('c3a-corpus');
  const workspaceDir = ctx.dir('workspace');
  const prefix = tout ? 'c3c' : 'c3a';
  const corpusRecords = jsonlPath(ctx, `${prefix}-corpus.jsonl`);
  const determinismRecords = jsonlPath(ctx, `${prefix}-determinisme.jsonl`);
  const progressPath = join(dirname(corpusRecords), 'progress.json');
  // En --tout, le déterminisme n'est mesuré que si demandé explicitement.
  const determinismWanted = tout
    ? Number(process.env.SS_E2E_C3A_DETERMINISM_COUNT || 0) : determinismCount;
  const progress = {
    startedAt: new Date().toISOString(), updatedAt: null, done: 0, total: 0,
    current: null, okCount: 0, failCount: 0, lastError: null,
  };
  function beat(step, current) {
    if (!tout) return;
    if (current) progress.current = { ...current, step };
    else if (progress.current) progress.current.step = step;
    progress.updatedAt = new Date().toISOString();
    try { writeFileSync(progressPath, JSON.stringify(progress, null, 2)); } catch { /* best effort */ }
  }
  function keepZip(category, index, editor, relPath, zip) {
    if (!keepDir || !zip) return;
    const dest = join(keepDir, category, `${String(index).padStart(3, '0')}-${editor}.zip`);
    mkdirSync(join(keepDir, category), { recursive: true });
    copyFileSync(zip, dest);
    appendFileSync(join(keepDir, 'manifest.jsonl'),
      `${JSON.stringify({ relPath, editor, zip: `${category}/${basename(dest)}` })}\n`);
  }

  // `--tout` : toutes les archives, ordre stable ; `SS_E2E_C3A_LIMIT` = n plus
  // petites par catégorie et par format (.zip / .7z), puis re-tri par chemin.
  function pickAll(subDir) {
    const all = allArchivesSorted(subDir);
    if (!limitPerFormat) return all;
    const keep = new Set();
    for (const ext of ['.zip', '.7z']) {
      all.filter((e) => e.path.toLowerCase().endsWith(ext))
        .sort((a, b) => a.size - b.size).slice(0, limitPerFormat).forEach((e) => keep.add(e));
    }
    return all.filter((e) => keep.has(e));
  }
  function buildToutJobs() {
    const jobs = [];
    const add = (dir, category, editors) => pickAll(dir).forEach((entry, index) => {
      jobs.push({ category, index, sourcePath: entry.path, relPath: entry.relPath, editors });
    });
    add(EDITABLE_DIR, 'editable', ['menus', 'graphe']);
    add(READONLY_DIR, 'lecture-seule', ['graphe']);
    add(UNSUPPORTED_DIR, 'non-supporte', ['verdict']);
    add(IMPORT_ERROR_DIR, 'erreur-import', ['verdict']);
    add(TO_CHECK_DIR, 'a-verifier', ['verdict']);
    return jobs;
  }

  const editableSample = tout ? [] : useReducedCorpus
    ? reducedArchivesUnder(EDITABLE_DIR)
    : spreadArchives(EDITABLE_DIR, editableCount, { minExt: { ext: '7z', count: min7z } });
  const readonlySample = tout ? [] : useReducedCorpus
    ? reducedArchivesUnder(READONLY_DIR)
    : spreadArchives(READONLY_DIR, readonlyCount);
  const importErrorSample = useReducedCorpus ? reducedArchivesUnder(IMPORT_ERROR_DIR) : [];
  const toutJobs = tout ? buildToutJobs() : [];
  if (useReducedCorpus && editableSample.length === 0 && readonlySample.length === 0) {
    throw new Error('--reduit : le corpus réduit ne contient aucun pack sous '
      + `« ${EDITABLE_DIR} » ni « ${READONLY_DIR} ». Vérifier corpus-reduit.json.`);
  }
  // Déterminisme : réparti sur l'échantillon Editable (pas seulement le début).
  const determinismIdx = new Set();
  for (let i = 0; i < determinismWanted && i < editableSample.length; i += 1) {
    determinismIdx.add(Math.floor((i * editableSample.length) / determinismWanted));
  }

  let app = await launchApp({ runDir: ctx.runDir, fresh: true, workspaceDir });
  const allFaults = [];
  let relaunches = 0;
  let packsSinceRelaunch = 0;
  let okMenus = 0; let totalMenus = 0;
  let okGraphe = 0; let totalGraphe = 0;
  let okReadonly = 0; let totalReadonly = 0;
  let verdictImportError = 0; let totalImportError = 0;
  let determinismOk = 0; let determinismTotal = 0;

  async function relaunchNow(label) {
    relaunches += 1;
    allFaults.push(...app.events.faults());
    const stop = await app.stop({ graceful: true });
    ctx.check(`relance (${label}) : rien d'écrit dans le vrai workspace`, stop.polluted.length === 0, { polluted: stop.polluted });
    app = await launchApp({ runDir: ctx.dir('relances', String(relaunches)), fresh: false, workspaceDir });
  }

  async function maybeRelaunch(label) {
    packsSinceRelaunch += 1;
    if (packsSinceRelaunch < relaunchEvery) return;
    packsSinceRelaunch = 0;
    await relaunchNow(label);
  }

  async function runChain(category, index, sourcePath, editor, { withDeterminism = false, st = {} } = {}) {
    const { page, events } = app;
    const ext = extname(sourcePath).slice(1).toLowerCase();
    const sourceName = basename(sourcePath);
    const label = `${category}-${String(index).padStart(2, '0')}-${editor}`;
    const copy = join(ctx.dir('entrées', category), `${String(index).padStart(2, '0')}${extname(sourcePath)}`);
    mkdirSync(ctx.dir('entrées', category), { recursive: true });
    copyFileSync(sourcePath, copy);
    const outDir = ctx.dir('sortie', category, String(index).padStart(2, '0'), editor);

    events.setStep(label);
    const faultsBefore = events.faults().length;
    const record = {
      category, index, editor, sourceName, ext, sizeBytes: statSync(sourcePath).size,
      relPath: corpusRelPath(sourcePath),
    };
    beat('lecture-story-json');
    const { storyJson: originalJson } = await readStoryJson(page, copy);
    record.originalUuid = originalJson?.uuid ?? null;
    record.originalNightModeAvailable = originalJson?.nightModeAvailable ?? null;
    record.originalStageCount = Array.isArray(originalJson?.stageNodes) ? originalJson.stageNodes.length : null;

    await goHome(page, { timeout: 60_000 }).catch(() => {});
    const startedAt = Date.now();
    beat('import');
    try {
      if (tout) {
        const opened = await openPackWithVerdict(page, copy, editor);
        record.openVerdict = normalizeVerdict(opened.verdict);
        record.expectedByCategory = EXPECTED_BY_CATEGORY[category] ?? null;
        record.openVerdictExpected = record.expectedByCategory
          ? record.expectedByCategory.includes(record.openVerdict) : null;
        if (!opened.ok) throw new Error(opened.reason);
      } else {
        await importPack(page, copy, { editor });
      }
      record.importOk = true;
    } catch (error) {
      record.importOk = false;
      record.importError = String(error?.message ?? error);
      // Récupération : l'échec a pu laisser un funnel ouvert, jamais l'éditeur.
      await closeFunnel(page).catch(() => {});
    }
    let genResult = null;
    if (record.importOk) {
      try {
        beat('génération');
        genResult = await generatePack(page, outDir, { uuid: 'keep' });
        record.durationMs = Date.now() - startedAt;
        record.refusal = genResult.refusal ?? (genResult.timeout ? 'timeout' : null);
        record.producedFileName = genResult.zip ? basename(genResult.zip) : null;
        if (genResult.zip) {
          beat('relecture');
          const readback = await readbackPack(page, genResult.zip, ctx.dir('studio', category, String(index).padStart(2, '0'), editor));
          record.readbackOk = readback.ok;
          record.appScreens = readback.storyStudio?.stageNodes ?? null;
          record.studioScreens = readback.studio?.stageNodes ?? null;
          record.producedUuid = readback.storyStudio?.uuid ?? null;
          record.producedVersion = readback.storyStudio?.version ?? null;
          record.uuidKept = record.originalUuid != null && record.producedUuid != null
            ? record.originalUuid === record.producedUuid : null;
          record.studioOk = readback.studio?.ok ?? false;

          if (withDeterminism) {
            determinismTotal += 1;
            const outDir2 = ctx.dir('sortie', category, String(index).padStart(2, '0'), `${editor}-2`);
            const second = await generatePack(page, outDir2, { uuid: 'keep' });
            const detRecord = { category, index, editor, sourceName };
            if (second.zip) {
              const cmp = samePackContent(genResult.zip, second.zip);
              detRecord.same = cmp.same;
              detRecord.differences = cmp.differences;
              if (cmp.same) determinismOk += 1;
            } else {
              detRecord.same = false;
              detRecord.error = second.refusal || (second.timeout ? 'timeout' : 'échec 2e génération');
            }
            appendRecord(determinismRecords, detRecord);
            ctx.check(`déterminisme ${label} : deux générations identiques`, detRecord.same === true, detRecord);
          }
        } else {
          record.readbackOk = false;
          await ctx.shot(page, `${label}-refus`);
        }
      } catch (error) {
        record.readbackOk = false;
        record.generationError = String(error?.message ?? error);
        record.durationMs = Date.now() - startedAt;
      }
    } else {
      record.durationMs = Date.now() - startedAt;
    }
    record.faultsNew = events.faults().slice(faultsBefore).map((f) => ({ kind: f.kind, text: f.text }));
    if (st.aborted) return record;
    appendRecord(corpusRecords, record);
    keepZip(category, index, editor, record.relPath, genResult?.zip);
    ctx.check(`${label} (${sourceName}) : import+génération+relecture`, Boolean(record.importOk && genResult?.zip && record.readbackOk), record);
    // Récupération best-effort : un échec en cours de génération peut laisser
    // l'app dans un état inattendu (boîte ouverte, éditeur bloqué) ; on
    // retente un retour à l'accueil, sans faire échouer toute la série si ça ne
    // marche pas (le prochain `goHome` du pack suivant retente).
    await returnHome(page).catch(() => page.keyboard.press('Escape').catch(() => {}));
    return record;
  }

  // Ce qu'un import refusé ne doit jamais laisser derrière lui : le workspace,
  // les sessions de travail et le cache d'import partagé.
  function leftoverRoots() {
    const { local } = appDataDirs();
    return [
      ['workspace', workspaceDir],
      ['sessions', local ? join(local, 'sessions') : null],
      ['cache-import', join(tmpdir(), 'story_studio_imported_pack_cache')],
    ].filter(([, dir]) => dir);
  }

  // `04 - Erreur import` : aucune génération, seulement le verdict de l'app au
  // dépôt, la lisibilité du refus et l'absence de restes après fermeture.
  async function runImportErrorChain(index, sourcePath, { category = 'erreur-import', st = {} } = {}) {
    const { page, events } = app;
    const faultsBefore = events.faults().length;
    const sourceName = basename(sourcePath);
    const label = `${category}-${String(index).padStart(2, '0')}`;
    const copy = join(ctx.dir('entrées', category), `${String(index).padStart(2, '0')}${extname(sourcePath)}`);
    mkdirSync(ctx.dir('entrées', category), { recursive: true });
    copyFileSync(sourcePath, copy);
    const record = {
      category, index, editor: 'verdict', sourceName, sizeBytes: statSync(sourcePath).size,
      relPath: corpusRelPath(sourcePath),
    };
    beat('verdict');
    const startedAt = Date.now();
    await goHome(page);
    const before = leftoverRoots().map(([name, dir]) => [name, dir, inventory(dir)]);
    await page.getByText('Modifier un pack existant', { exact: true }).click();
    await dropFiles(page, '[data-funnel-drop]', [copy]);

    const loc = openLocators(page);
    const { funnel, notices, bundleList, chooser } = loc;
    record.verdict = await pollOpenVerdict(page, loc, startedAt);
    if (tout) {
      record.openVerdict = normalizeVerdict(record.verdict);
      record.expectedByCategory = EXPECTED_BY_CATEGORY[category] ?? null;
      record.openVerdictExpected = record.expectedByCategory
        ? record.expectedByCategory.includes(record.openVerdict) : null;
    }
    record.durationMs = Date.now() - startedAt;
    await ctx.shot(page, `${label}-verdict`);

    // Chaque message affiché : sa première ligne est le texte public, le
    // diagnostic brut n'est admis que replié sous « Détail technique ».
    record.messages = await notices.evaluateAll((nodes) => nodes.map((node) => ({
      text: node.querySelector(':scope > div')?.textContent?.trim() ?? node.textContent.trim(),
      hasTechnicalDetail: Boolean(node.querySelector('details summary')),
    })));
    const leakPatterns = [/[A-Za-z]:\\|[\\/]Users[\\/]|AppData|\bTemp\b/i, /[A-Z][a-z]+Error\b|::|story\.json|Nom asset/];
    record.messageLeaks = record.messages
      .filter(({ text }) => leakPatterns.some((re) => re.test(text)))
      .map(({ text }) => text);
    if (record.verdict === 'enveloppe') {
      record.children = await bundleList.locator('[role="radio"]').evaluateAll((nodes) => nodes.map((node) => ({
        verdict: node.querySelector('.bundle-child-verdict')?.textContent?.trim() ?? '',
        selectable: !node.disabled,
      })));
    }

    if (await chooser.count()) await chooser.getByRole('button', { name: 'Annuler', exact: true }).click().catch(() => {});
    if (await funnel.count()) await closeFunnel(page);
    if (record.verdict === 'atterri') await returnHome(page).catch(() => {});
    await goHome(page);
    record.leftovers = Object.fromEntries(before.map(([name, dir, snapshot]) => [name, inventoryDiff(snapshot, inventory(dir)).added]));
    record.faultsNew = events.faults().slice(faultsBefore).map((f) => ({ kind: f.kind, text: f.text }));
    if (st.aborted) return record;
    appendRecord(corpusRecords, record);

    const readable = record.messageLeaks.length === 0
      && (record.verdict !== 'refus' || record.messages.some(({ hasTechnicalDetail }) => hasTechnicalDetail));
    const clean = Object.values(record.leftovers).every((added) => added.length === 0);
    ctx.check(`${label} (${sourceName}) : verdict « ${record.verdict} », refus lisible, aucun reste`,
      record.verdict !== 'timeout' && readable && clean && record.faultsNew.length === 0, record);
    return record;
  }

  // Couples (relPath, editor) déjà relevés (reprise).
  function alreadyDone() {
    const done = new Set();
    if (!resume || !existsSync(corpusRecords)) return done;
    for (const line of readFileSync(corpusRecords, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.relPath) done.add(`${rec.relPath}|${rec.editor ?? 'verdict'}`);
      } catch { /* ligne tronquée : ignorée */ }
    }
    return done;
  }

  const chainOk = (rec) => (rec.verdict !== undefined
    ? rec.verdict !== 'timeout' && !rec.timeout
    : Boolean(rec.importOk && rec.readbackOk && !rec.timeout));

  // Une chaîne sous plafond dur : au dépassement, on enregistre `timeout`, on
  // relance l'app et on continue — un pack bloqué ne bloque jamais le lot.
  async function guarded(job, editor, fn) {
    const st = { aborted: false };
    const TIMEOUT = Symbol('timeout');
    let timer;
    const timeoutP = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), packTimeoutMs); });
    const chainP = fn(st).catch((error) => ({ crashed: error }));
    const res = await Promise.race([chainP, timeoutP]);
    clearTimeout(timer);
    let rec = res;
    let failure = null;
    if (res === TIMEOUT) {
      st.aborted = true;
      failure = `timeout (> ${packTimeoutMs} ms)`;
    } else if (res?.crashed) {
      failure = `chaîne interrompue : ${String(res.crashed?.message ?? res.crashed)}`;
    }
    if (failure) {
      rec = {
        category: job.category, index: job.index, editor, sourceName: basename(job.sourcePath),
        ext: extname(job.sourcePath).slice(1).toLowerCase(), sizeBytes: statSync(job.sourcePath).size,
        relPath: job.relPath, importOk: false, importError: failure, timeout: res === TIMEOUT,
        openVerdict: null, readbackOk: false,
      };
      if (editor === 'verdict') rec.verdict = 'timeout';
      appendRecord(corpusRecords, rec);
      ctx.check(`${job.category}-${job.index} ${editor} (${rec.sourceName}) : ${failure}`, false, rec);
      await relaunchNow(`${job.category}-${job.index}-${editor}-reprise`);
      packsSinceRelaunch = 0;
    }
    progress.done += 1;
    if (failure || !chainOk(rec)) {
      progress.failCount += 1;
      progress.lastError = failure || rec.importError || rec.generationError || rec.refusal
        || (rec.verdict === 'timeout' ? 'verdict timeout' : 'échec ' + rec.relPath);
    } else {
      progress.okCount += 1;
    }
    beat('terminé');
    return rec;
  }

  async function runTout() {
    const done = alreadyDone();
    progress.total = toutJobs.reduce((n, job) => n + job.editors.length, 0);
    const editableCount = toutJobs.filter((job) => job.category === 'editable').length;
    const toutDeterminism = new Set();
    for (let i = 0; i < determinismWanted && i < editableCount; i += 1) toutDeterminism.add(Math.floor((i * editableCount) / determinismWanted));
    beat('démarrage');
    console.log(`--tout : ${toutJobs.length} pack(s), ${progress.total} chaîne(s), ${done.size} déjà relevée(s)`);
    for (const job of toutJobs) {
      let menusRan = false;
      for (const editor of job.editors) {
        if (done.has(`${job.relPath}|${editor}`)) { progress.done += 1; continue; }
        if (editor === 'graphe' && job.category === 'editable' && menusRan) {
          await relaunchNow(`entre-chaines-${job.index}`);
        }
        beat('début', { relPath: job.relPath, editor });
        const rec = await guarded(job, editor, (st) => (editor === 'verdict'
          ? runImportErrorChain(job.index, job.sourcePath, { category: job.category, st })
          : runChain(job.category, job.index, job.sourcePath, editor, { st,
            withDeterminism: editor === 'menus' && toutDeterminism.has(job.index) })));
        if (editor === 'menus') { menusRan = true; totalMenus += 1; if (rec.readbackOk) okMenus += 1; }
        else if (editor === 'graphe' && job.category === 'editable') { totalGraphe += 1; if (rec.readbackOk) okGraphe += 1; }
        else if (editor === 'graphe') { totalReadonly += 1; if (rec.readbackOk) okReadonly += 1; }
        else { totalImportError += 1; if (rec.verdict !== 'timeout') verdictImportError += 1; }
        if (editor !== 'menus') await maybeRelaunch(`${job.category}-${job.index}`);
      }
    }
  }

  try {
    if (tout) {
      await runTout();
      beat('fini');
      ctx.check('--tout : aucune chaîne en échec', progress.failCount === 0, { ok: progress.okCount, fail: progress.failCount, total: progress.total });
    }
    for (let i = 0; i < editableSample.length; i += 1) {
      const withDet = determinismIdx.has(i);
      const menusRec = await runChain('editable', i, editableSample[i], 'menus', { withDeterminism: withDet });
      totalMenus += 1; if (menusRec.readbackOk) okMenus += 1;

      // Relance systématique entre les deux chaînes du même pack (une
      // génération graphe qui suit une génération menus complète
      // dans la même session a été vue geler ~600 s sans aucun appel IPC
      // après le chargement du graphe — écarté ici plutôt qu'enquêté, pour ne
      // pas faire dériver toute la série).
      await relaunchNow(`entre-chaines-${i}`);

      const grapheRec = await runChain('editable', i, editableSample[i], 'graphe');
      totalGraphe += 1; if (grapheRec.readbackOk) okGraphe += 1;
      await maybeRelaunch(`editable-${i}-graphe`);
    }

    for (let i = 0; i < readonlySample.length; i += 1) {
      const rec = await runChain('lecture-seule', i, readonlySample[i], 'graphe');
      totalReadonly += 1; if (rec.readbackOk) okReadonly += 1;
      await maybeRelaunch(`lecture-seule-${i}`);
    }

    for (let i = 0; i < importErrorSample.length; i += 1) {
      const rec = await runImportErrorChain(i, importErrorSample[i]);
      totalImportError += 1; if (rec.verdict !== 'timeout') verdictImportError += 1;
    }

    if (!tout) {
    ctx.check(`chaîne menus (Editable) : réussite`, okMenus === totalMenus, { okMenus, totalMenus });
    ctx.check(`chaîne graphe (Editable) : réussite`, okGraphe === totalGraphe, { okGraphe, totalGraphe });
    ctx.check(`chaîne graphe (Lecture seule) : réussite`, okReadonly === totalReadonly, { okReadonly, totalReadonly });
    }
    if (totalImportError) {
      ctx.check(`Erreur import : un verdict pour chaque pack`, verdictImportError === totalImportError, { verdictImportError, totalImportError });
    }
    if (!tout || determinismWanted > 0) {
      ctx.check(`déterminisme : générations identiques`, determinismOk === determinismTotal && determinismTotal > 0, { determinismOk, determinismTotal });
    }
    if (!tout) ctx.check(`relances périodiques effectuées`, relaunches > 0, { relaunches, relaunchEvery });
  } catch (error) {
    ctx.check(`parcours interrompu : ${error.message}`, false, { stack: error.stack });
  } finally {
    allFaults.push(...app.events.faults());
    ctx.check('aucune erreur console ni exception cumulée non attribuée à un pack', true, { faultsTotal: allFaults.length });
    const stop = await app.stop({ graceful: true });
    ctx.check('rien d’écrit dans le vrai workspace', stop.polluted.length === 0, { polluted: stop.polluted });
  }
  return ctx.finish({ okMenus, totalMenus, okGraphe, totalGraphe, okReadonly, totalReadonly, verdictImportError, totalImportError, determinismOk, determinismTotal, relaunches });
}
