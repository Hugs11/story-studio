// Lot 4.9 — vérificateur et rapports : catalogue, comparaison FR contre la base
// (`git show BASE`), langues à chaud, pseudo-locale sur les surfaces rendues.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { ESLint } from 'eslint';
import { BASE, sources } from './i18nCheckerSourceFixture.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { checkCatalogues, checkSource, sourceHash, CHECKER_NEUTRAL_KEYS } from './check-i18n.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import fr from '../src/locales/fr/checker.json' with { type: 'json' };
import en from '../src/locales/en/checker.json' with { type: 'json' };
import it from '../src/locales/it/checker.json' with { type: 'json' };
import meta from '../src/locales/_meta/checker.json' with { type: 'json' };
import frNative from '../src/locales/fr/native.json' with { type: 'json' };
import enNative from '../src/locales/en/native.json' with { type: 'json' };
import itNative from '../src/locales/it/native.json' with { type: 'json' };
import metaNative from '../src/locales/_meta/native.json' with { type: 'json' };

const LANGUAGES = ['fr', 'en', 'it'];
const resources = { fr: { checker: fr, native: frNative }, en: { checker: en, native: enNative }, it: { checker: it, native: itNative } };
// Corrections FR nominatives du brief (« ... » → « … » dans la progression).
const PROGRESS_FIXES = [['Correction...', 'Correction…'],
  // Un dossier de pack vaut une archive : titre de dépôt élargi et second bouton (ajout volontaire).
  ['Déposer un pack .zip ou .7z', 'Déposer un pack .zip, .7z ou un dossier'],
  ['Choisir un pack</button>', 'Choisir un pack</button><button type="button" class="funnel-btn">Choisir un dossier</button>']];
const fixed = (html) => applyLot413(PROGRESS_FIXES.reduce((text, [before, after]) => text.replaceAll(before, after), html));
// Lot 4.13 : mêmes corrections sur une valeur structurée (objets de présentation).
const fixedDeep = (value) => (value === undefined ? value : JSON.parse(fixed(JSON.stringify(value))));

// Surface pseudo-locale : tout texte et attribut accessible doit venir du catalogue.
function surface(html) {
  const clean = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  assert.doesNotMatch(clean, /\[object Object\]|(?:checker|native|home):[a-z]+\.[a-zA-Z]/);
  const values = [...clean.matchAll(/>([^<>]+)</g), ...clean.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)].map((m) => m[1].trim());
  for (const value of values) {
    if (!/\p{L}{2}/u.test(value) || /_AUTHOR_|_RAW_/.test(value)) continue;
    // Codes, unités et catégorie technique brute (audio/image/title/structure), affichés tels quels depuis la base.
    if (/^-?[\d,.]+ (?:s|LUFS|dBTP|kHz|Hz)$/.test(value) || /^[A-Z][A-Z0-9_]+$/.test(value) || /^(?:title|structure)$/.test(value) || /^\.\w+$/.test(value)) continue;
    assert.ok(/[[\]~ëïüàôÀËÏÔÜ]/.test(value), `hors catalogue : ${value}`);
  }
}

async function server(original = false) {
  return createServer({ configFile: false, logLevel: 'silent', plugins: [{ name: 'checker-fixture', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && sources[file]) code = sources[file];
    if (id.endsWith('/Dialog.jsx')) code = code.replace("import { createPortal } from 'react-dom';", 'const createPortal = (children) => children;').replace('document.body,', 'null,');
    if (id.endsWith('/AppModalPortal.jsx')) return 'export function AppModalPortal({children}) { return children; }';
    // État initial injecté (étapes du parcours, rapport déjà reçu), identique dans les deux versions.
    if (id.endsWith('/CommunityPackCheckerFunnel.jsx')) code = code
      .replace('const [step, setStep] = useState(0);', 'const [step, setStep] = useState(globalThis.__checkerFixture?.step ?? 0);')
      .replace("const [phase, setPhase] = useState('collect');", "const [phase, setPhase] = useState(globalThis.__checkerFixture?.phase ?? 'collect');")
      .replace('const [result, setResult] = useState(null);', 'const [result, setResult] = useState(globalThis.__checkerFixture?.result ?? null);');
    if (id.endsWith('/useCommunityPackChecker.js')) code = code
      .replace('const [report, setReport] = useState(null);', 'const [report, setReport] = useState(globalThis.__checkerFixture?.report ?? null);')
      .replace("const [zipPath, setZipPath] = useState('');", "const [zipPath, setZipPath] = useState(globalThis.__checkerFixture?.zipPath ?? '');");
    // Sous-composants internes exposés au banc, dans les deux versions.
    if (id.endsWith('/CommunityPackChecker/CommunityPackChecker.jsx')) code += '\nexport { TechnicalDetail, MiniFile, buildProblemGroups, ProblemGroupCard };';
    if (id.endsWith('/CommunityPackChecker/CommunityPackConforming.jsx')) code += '\nexport { buildConformingGroups, ConformingGroupCard, ConformingFile };';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

const audio = (filePath, extra) => ({ filePath, label: `_AUTHOR_${filePath}_.mp3 item`, status: 'warning', codec: '_AUTHOR_CODEC_', channels: '_AUTHOR_CH_', sampleRate: 22050, leadingSilenceSecs: 0.1, trailingSilenceSecs: 1.5, integratedLufs: -25.3, truePeakDb: -1.2, ...extra });
const issue = (code, extra) => ({ severity: 'warning', category: 'audio', code, autoFixAvailable: true, fixDisposition: 'automatic', label: `_AUTHOR_${code}_`, message: `_AUTHOR_MSG_${code}_`, ...extra });
const ISSUES = {
  silence: issue('audioLeadingSilenceTooShort', { filePath: 'a1', autoFixDescription: '_AUTHOR_FIX_', technicalDetails: '_RAW_DETAIL_' }),
  optional: issue('audioTrailingSilenceLong', { filePath: 'a1', severity: 'info', fixDisposition: 'optional' }),
  optional2: issue('audioLeadingSilenceLong', { filePath: 'a4', severity: 'info', fixDisposition: 'optional' }),
  volume: issue('CHECKER_AUDIO_VOLUME', { filePath: 'a2' }),
  volumeHigh: issue('CHECKER_AUDIO_VOLUME', { filePath: 'a5' }),
  rate: issue('CHECKER_AUDIO_SAMPLE_RATE', { filePath: 'a6' }),
  channels: issue('CHECKER_AUDIO_CHANNELS', { filePath: 'a7' }),
  format: issue('CHECKER_AUDIO_FORMAT', { filePath: 'a8' }),
  clipped: issue('CHECKER_AUDIO_CLIPPED', { filePath: 'a3', autoFixAvailable: false, fixDisposition: 'none' }),
  clippedError: issue('CHECKER_AUDIO_CLIPPED', { filePath: 'a9', severity: 'error', autoFixAvailable: false, fixDisposition: 'none' }),
  listen: issue('CHECKER_AUDIO_LEADING_UNMEASURABLE', { filePath: 'a10', autoFixAvailable: false, fixDisposition: 'none' }),
  listen2: issue('CHECKER_AUDIO_VOLUME_UNMEASURABLE', { filePath: 'a11', autoFixAvailable: false, fixDisposition: 'none' }),
  image: issue('CHECKER_IMAGE_FORMAT_DIMENSIONS', { category: 'image', filePath: 'i1' }),
  imageFormat: issue('CHECKER_IMAGE_FORMAT', { category: 'image', filePath: 'i3' }),
  imageDims: issue('CHECKER_IMAGE_DIMENSIONS', { category: 'image', filePath: 'i4' }),
  title: issue('CHECKER_TITLE_CONVENTION', { category: 'title', autoFixAvailable: false, fixDisposition: 'none' }),
  structure: issue('CHECKER_STRUCTURE_LINK', { category: 'structure', autoFixAvailable: false, fixDisposition: 'none' }),
};
function report(issueKeys, extra = {}) {
  return {
    packName: '_AUTHOR_PACK_.zip', packTitle: '_AUTHOR_TITLE_', packVersion: 2, packUuid: '_AUTHOR_UUID_', zipPath: '/_AUTHOR_DIR_/p.zip',
    verdict: 'needsFix', summary: { errors: 1, warnings: 3, infos: 1, ok: 4 }, correctionsAvailable: 3, optionalCorrectionsAvailable: 1,
    audioSummary: { total: 3, ok: 1, infos: 1 }, imageSummary: { total: 2, ok: 1 }, titleSummary: { total: 1, ok: 1 },
    structureSummary: { luniiCompatible: true, storyStudioEditable: true, stageCount: 4, storyCount: 2, actionCount: 1, referencedAudioCount: 3, referencedImageCount: 2 },
    nightMode: { detected: true },
    audioItems: [audio('a1'), audio('a2', { status: 'ok', integratedLufs: undefined, sampleRate: undefined, codec: undefined, channels: undefined }), audio('a3', { truePeakDb: 0.4 }), audio('a5', { integratedLufs: -8 }), audio('a9', { truePeakDb: undefined })],
    imageItems: [{ filePath: 'i1', label: '_AUTHOR_I1_.png', status: 'warning', width: 640, height: 480, format: '_AUTHOR_FMT_' }, { filePath: 'i2', label: '_AUTHOR_I2_', status: 'ok' }],
    issues: issueKeys.map((key) => ISSUES[key]),
    technicalLog: ['_RAW_LOG_A_', '_RAW_LOG_B_'],
    ...extra,
  };
}
// Une variante par branche de verdict, plus l'ordre des cartes.
const REPORTS = {
  conform: report([], { verdict: 'valid', nightMode: { detected: false }, titleSummary: { total: 1, ok: 0, warnings: 1 }, structureSummary: { stageCount: 1 } }),
  blocking: report(['clippedError', 'silence', 'structure'], { verdict: 'invalid' }),
  saturated: report(['clipped']),
  saturatedFixable: report(['clipped', 'silence', 'volume']),
  listenOne: report(['listen', 'silence']),
  listenTwo: report(['listen', 'listen2', 'image']),
  optionalOne: report(['optional'], { verdict: 'valid' }),
  optionalTwo: report(['optional', 'optional2'], { verdict: 'valid' }),
  fixable: report(['silence', 'optional', 'volume', 'volumeHigh', 'rate', 'channels', 'format', 'image', 'imageFormat', 'imageDims', 'title']),
};

let current, original, engine;
test.before(async () => {
  current = await server(); original = await server(true);
  const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js');
  engine = initializeI18n('fr');
  const { pseudoResources } = await current.ssrLoadModule('/src/i18n/pseudo.js');
  for (const [ns, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', ns, values, true, true);
});
test.after(async () => { await current?.close(); await original?.close(); });

const load = async (path) => [await current.ssrLoadModule(path), await original.ssrLoadModule(path)];
const html = (element) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, element));

test('Vérificateur : catalogue, métadonnées, règle d’or par mutation, pluriels CLDR', async () => {
  assert.equal(BASE, '97803eaf13d7847aa37ffe75a51ebd838df9b5fc');
  const metadata = { checker: meta, native: metaNative };
  assert.deepEqual(checkCatalogues(resources, metadata).errors, []);
  for (const [key, text] of Object.entries(fr)) {
    assert.ok(meta[key]?.context?.length > 20, `${key}: contexte`);
    for (const lng of ['en', 'it']) if (key in resources[lng].checker) {
      assert.equal(meta[key][lng].status, 'ai-reviewed'); assert.equal(meta[key][lng].sourceHash, sourceHash(text));
      const base = key.replace(/_(one|many|other)$/, '');
      if (!CHECKER_NEUTRAL_KEYS[lng].has(base)) assert.notEqual(resources[lng].checker[key], text, `${lng}:${key}`);
    }
  }
  // Chaque clé neutre l'est réellement (sinon la liste masquerait une fuite).
  for (const lng of ['en', 'it']) for (const base of CHECKER_NEUTRAL_KEYS[lng]) {
    assert.ok(Object.entries(resources[lng].checker).some(([key, value]) => key.replace(/_(one|many|other)$/, '') === base && value === fr[key]), `${lng}:${base} neutre inutile`);
  }
  for (const lng of ['en', 'it']) {
    const mutation = structuredClone(resources); mutation[lng].checker['report.empty'] = fr['report.empty'];
    assert.ok(checkCatalogues(mutation, metadata).errors.some((e) => e.includes(`${lng}/checker:report.empty règle d’or`)));
    const nativeMutation = structuredClone(resources); nativeMutation[lng].native['checker.pack.title'] = frNative['checker.pack.title'];
    assert.ok(checkCatalogues(nativeMutation, metadata).errors.some((e) => e.includes(`${lng}/native:checker.pack.title règle d’or`)));
  }
  assert.ok(checkSource("translateChecker(unknownKey)", 'src/store/x.js', resources).errors.some((e) => e.includes('clé dynamique non déclarée')));
  assert.ok(checkSource("translateChecker('checker:nope.missing.key')", 'src/store/x.js', resources).errors.some((e) => e.includes('clé FR absente')));
  for (const lng of LANGUAGES) assert.equal(Object.keys(resources[lng].checker).some((k) => k.endsWith('_zero')), false);
  const i18n = createTestI18n();
  const plurals = [...new Set(Object.keys(fr).filter((k) => /_(one|many|other)$/.test(k)).map((k) => k.replace(/_(one|many|other)$/, '')))];
  assert.ok(plurals.length >= 15);
  for (const lng of LANGUAGES) {
    await i18n.changeLanguage(lng);
    for (const key of plurals) for (const count of [0, 1, 2, 1000000]) {
      const category = new Intl.PluralRules(lng).select(count);
      const expected = resources[lng].checker[`${key}_${category}`].replaceAll('{{count}}', count).replace(/{{(\w+)}}/g, '_$1_');
      assert.equal(i18n.t(`checker:${key}`, { count, automatic: '_automatic_', optional: '_optional_', shortcut: '_shortcut_' }), expected, `${lng}:${key}:${count}`);
    }
  }
  // Repli « Enregistrer sous… » (lot 4.13 : libellé affiché, points de suspension typographiques).
  await i18n.changeLanguage('fr');
  assert.equal(i18n.t('common:project.saveAs.fallbackLabel'), 'Enregistrer sous…');
  assert.throws(() => surface('<span title="Journal technique">Journal technique</span>'), /hors catalogue/);
});

test('Vérificateur : ESLint refuse un texte français ajouté dans un fichier raccordé', async () => {
  const eslint = new ESLint();
  for (const file of Object.keys(sources)) {
    const [result] = await eslint.lintText(`${file.endsWith('.jsx') ? 'export const Leak = () => <p>Analyse du pack terminée</p>;' : "export const leak = 'Analyse du pack terminée';"}\n`, { filePath: file });
    assert.ok(result.messages.some((message) => message.ruleId === 'i18next/no-literal-string'), file);
  }
});

test('Vérificateur : rendus FR identiques à BASE, puis EN/IT distincts et pseudo-locale', async () => {
  const [now, old] = await load('/src/components/CommunityPackChecker/CommunityPackChecker.jsx');
  const [nowConform, oldConform] = await load('/src/components/CommunityPackChecker/CommunityPackConforming.jsx');
  const [nowModalModule, oldModalModule] = await load('/src/components/CommunityPackChecker/CommunityPackMetadataModal.jsx');
  const [nowDialog, oldDialog] = await load('/src/components/common/Dialog.jsx');
  const nowModal = { ...nowModalModule, Provider: nowDialog.ErrorDialogProvider }; const oldModal = { ...oldModalModule, Provider: oldDialog.ErrorDialogProvider };
  const scenarios = [];
  for (const [name, value] of Object.entries(REPORTS)) {
    const selected = new Set();
    scenarios.push([`ReportView:${name}`, (m) => React.createElement(m.ReportView, { report: value, busy: name === 'fixable', canFix: true, onExportReport() {}, onFixPack() {}, selectedOptionalSilences: selected, onToggleOptionalSilence() {} }), true]);
    scenarios.push([`Corrections:${name}`, (m) => React.createElement(m.FixableCorrectionsList, { report: value, selectedOptionalSilences: selected, onToggleOptionalSilence() {} })]);
    scenarios.push([`Groups:${name}`, (m) => React.createElement('div', null, m.buildProblemGroups(value).map((group) => React.createElement(m.ProblemGroupCard, { key: group.id, group, expanded: true, onToggle() {} })))]);
    scenarios.push([`Details:${name}`, (m) => React.createElement('div', null, m.buildProblemGroups(value).flatMap((group) => group.records).map((record) => React.createElement(m.MiniFile, { key: record.id, record, open: true, onToggle() {} })))]);
  }
  const reportFor = REPORTS.fixable;
  scenarios.push(['TechnicalLog', (m) => React.createElement(m.TechnicalLog, { report: reportFor, onCopyLog() {}, onExportLog() {}, onExportJson() {} })]);
  for (const status of ['fixing', 'analyzing', 'idle']) scenarios.push([`ProcessLog:${status}`, (m) => React.createElement(m.ProcessLog, { status, lines: ['_RAW_LINE_'] })]);
  const conformReports = [REPORTS.conform, { ...REPORTS.fixable, titleSummary: { total: 1, ok: 1 } }, { ...REPORTS.fixable, nightMode: { detected: false }, structureSummary: { luniiCompatible: true, storyStudioEditable: true } }];
  conformReports.forEach((value, index) => {
    scenarios.push([`Conforming:${index}`, (m, c) => React.createElement('div', null, c.buildConformingGroups(value).map((group) => React.createElement(c.ConformingGroupCard, { key: group.id, group, expanded: true, onToggle() {} })))]);
    scenarios.push([`ConformingFiles:${index}`, (m, c) => React.createElement('div', null, [...(value.audioItems ?? []).map((item) => ['audio', item]), ...(value.imageItems ?? []).map((item) => ['image', item])].map(([kind, item]) => React.createElement(c.ConformingFile, { key: item.filePath, kind, item, open: true, onToggle() {} })))]);
  });
  for (const [busy, value] of [[false, REPORTS.fixable], [true, REPORTS.conform], [false, { ...REPORTS.conform, packName: '', issues: [ISSUES.title], packUuid: '_AUTHOR_UUID_' }]]) {
    scenarios.push([`Metadata:${busy}`, (m, c, md) => React.createElement(md.Provider, null, React.createElement(md.CommunityPackMetadataModal, { report: value, busy, onCancel() {}, onSubmit() {} }))]);
  }
  for (const [name, build] of scenarios) {
    await engine.changeLanguage('fr');
    const before = JSON.stringify(REPORTS);
    const frHtml = html(build(now, nowConform, nowModal));
    const baseHtml = html(build(old, oldConform, oldModal));
    // FICHED deliberately replaces the description guidance; BASE stays independent.
    const expected = fixed(baseHtml).replaceAll('Description ou notes de version…', 'Texte libre : présentation, contenu, notes de version…');
    assert.equal(frHtml, expected, `FR ${name}`);
    const seen = [frHtml];
    for (const lng of ['en', 'it', 'pseudo']) {
      await engine.changeLanguage(lng);
      const output = html(build(now, nowConform, nowModal));
      assert.doesNotMatch(output, /\[object Object\]|checker:[a-z]+\./);
      if (lng === 'pseudo') surface(output); else seen.push(output);
    }
    if (/[A-Za-zÀ-ÿ]{3}/.test(frHtml.replace(/<[^>]+>|_AUTHOR_\w+|_RAW_\w+/g, ''))) {
      assert.notEqual(seen[0], seen[1], `EN ${name}`); assert.notEqual(seen[0], seen[2], `IT ${name}`);
    }
    assert.equal(JSON.stringify(REPORTS), before, 'données du rapport inchangées');
  }
  await engine.changeLanguage('fr');
  // La seule correction FR autorisée est bien rendue (aucun test existant ne la portait).
  const busy = html(React.createElement(now.ReportView, { report: REPORTS.fixable, busy: true, canFix: true, onExportReport() {}, onFixPack() {} }));
  assert.match(busy, /Correction…</); assert.doesNotMatch(busy, /Correction\.\.\./);
  const busyBase = html(React.createElement(old.ReportView, { report: REPORTS.fixable, busy: true, canFix: true, onExportReport() {}, onFixPack() {} }));
  assert.match(busyBase, /Correction\.\.\.</);
});

test('Vérificateur : exports HTML/Markdown/journal/JSON identiques à BASE en FR, langue du clic ensuite', async () => {
  const [now, old] = await load('/src/components/CommunityPackChecker/communityPackExports.js');
  const dateless = (text) => text.replace(/(_AUTHOR_PACK_\.zip|Pack analysé|\[[^\]]*\]) · [^<]+</g, '$1 · DATE<');
  for (const [name, value] of [...Object.entries(REPORTS), ['empty-name', { ...REPORTS.fixable, packName: '' }]]) {
    await engine.changeLanguage('fr');
    for (const format of ['formatHtmlReport', 'formatReadableReport', 'formatTechnicalLog', 'formatDiagnosticJson']) {
      assert.equal(dateless(now[format](value)), fixed(dateless(old[format](value))), `${format}:${name}`);
    }
    assert.equal(now.reportBaseName(value), old.reportBaseName(value));
    const seen = [];
    for (const lng of ['fr', 'en', 'it', 'pseudo']) {
      await engine.changeLanguage(lng);
      const htmlReport = now.formatHtmlReport(value); const markdown = now.formatReadableReport(value);
      assert.doesNotMatch(htmlReport + markdown, /\[object Object\]|checker:[a-z]+\./);
      assert.match(htmlReport, new RegExp(`<html lang="${lng === 'pseudo' ? 'fr' : lng}">`));
      if (lng === 'pseudo') {
        surface(htmlReport);
        for (const line of markdown.split('\n').filter((row) => /\p{L}{2}/u.test(row) && !/_AUTHOR_|_RAW_|^```/.test(row))) assert.ok(/\[|[ëïüàô]/.test(line), `markdown hors catalogue : ${line}`);
      } else seen.push([htmlReport, markdown, now.reportBaseName({})]);
    }
    for (let i = 0; i < 3; i++) { assert.notEqual(seen[0][i], seen[1][i], `EN ${name}`); assert.notEqual(seen[0][i], seen[2][i], `IT ${name}`); }
  }
  await engine.changeLanguage('fr');
});

test('Vérificateur : fonctions de mesure et de classement par code, FR identique, sans lecture de mots', async () => {
  const [nowFormat, oldFormat] = await load('/src/components/CommunityPackChecker/packCheckerFormat.js');
  const [nowClass, oldClass] = await load('/src/components/CommunityPackChecker/packCheckerIssueClassification.js');
  const items = [audio('x'), audio('y', { codec: undefined, channels: undefined, sampleRate: undefined, leadingSilenceSecs: undefined, trailingSilenceSecs: undefined, integratedLufs: undefined, truePeakDb: undefined }), audio('z', { integratedLufs: -8 }), { width: 640, height: 480, format: '_AUTHOR_FMT_' }, {}];
  await engine.changeLanguage('fr');
  for (const item of items) {
    assert.deepEqual(nowFormat.audioMeasureRows(item), fixedDeep(oldFormat.audioMeasureRows(item)));
    assert.deepEqual(nowFormat.imageMeasureRows(item), fixedDeep(oldFormat.imageMeasureRows(item)));
    for (const value of Object.values(ISSUES)) for (const kind of ['audio', 'image', 'title']) {
      assert.equal(nowClass.measuredIssueSummary(value, item, kind), fixed(oldClass.measuredIssueSummary(value, item, kind)));
    }
  }
  assert.equal(nowFormat.cleanLabel(''), oldFormat.cleanLabel(''));
  // Le classement reste porté par category/code : un message traduit ne déplace rien.
  for (const value of Object.values(ISSUES)) {
    const changed = { ...value, message: 'volume niveau sonore saturation silence', autoFixDescription: 'other words' };
    for (const fn of ['isAutomaticSilenceIssue', 'isOptionalSilenceIssue', 'isAutomaticVolumeIssue', 'isAudioFormatIssue', 'isSaturatedIssue']) {
      assert.equal(nowClass[fn](changed), nowClass[fn](value), fn);
    }
  }
  assert.equal(nowClass.isAutomaticVolumeIssue({ ...ISSUES.volume, code: 'OTHER' }), false);
  const seen = [];
  for (const lng of LANGUAGES) {
    await engine.changeLanguage(lng);
    seen.push([nowFormat.audioMeasureRows(items[0]).map((row) => row.label + row.value).join('|'), nowClass.measuredIssueSummary(ISSUES.volume, items[2], 'audio')]);
  }
  assert.equal(seen[1][0].includes('0.10 s'), true, 'séparateur décimal EN');
  assert.equal(seen[0][0].includes('0,10 s'), true, 'séparateur décimal FR d’origine');
  for (let i = 0; i < 2; i++) { assert.notEqual(seen[0][i], seen[1][i]); assert.notEqual(seen[0][i], seen[2][i]); }
  await engine.changeLanguage('fr');
});

test('Rapports graphe : refus, médias, qualification et relecture — FR identique, objets relus à chaud', async () => {
  const [nowOutcome, oldOutcome] = await load('/src/store/advancedExport/exportOutcome.js');
  const [nowReadiness, oldReadiness] = await load('/src/store/advancedExport/exportReadiness.js');
  const [nowReport, oldReport] = await load('/src/components/AdvancedWorkspace/ExportReport.jsx');
  const [nowDiag, oldDiag] = await load('/src/components/AdvancedWorkspace/DiagnosticsPanel.jsx');
  const [nowReview, oldReview] = await load('/src/components/AdvancedWorkspace/ZipReviewPanel.jsx');
  const [nowRequest, oldRequest] = await load('/src/store/advancedExport/exportRequest.js');
  const coded = { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' };
  const causes = ['binding-absent', 'path-null', 'not-found', 'not-regular', 'read-denied', 'empty', 'undecodable', 'validation-failed', 'tool-unavailable', 'tool-interrupted', 'processing-failed', '_RAW_CAUSE_', undefined];
  const raws = [
    { kind: 'payload-decode', error: { code: 'ADVANCED_PAYLOAD_INVALID', path: '/_RAW_PATH_', found: '_RAW_FOUND_', expected: '_RAW_EXPECTED_' } },
    ...['graph-integrity', 'authoring-action-required', 'pack-identity', 'readiness-blocked', 'standard-serialization', '_RAW_PREP_'].map((kind) => ({ kind: 'preparation', error: { kind, message: coded, errors: [{ ...coded, path: '/_RAW_P_' }], diagnostics: kind === 'readiness-blocked' ? ['_RAW_LINE_'] : [{ ...coded, path: '/_RAW_D_' }] } })),
    { kind: 'media-unavailable', entries: causes.map((cause, index) => ({ assetRef: `_RAW_REF_${index % 4}`, field: ['image', 'audio', undefined, '_RAW_FIELD_'][index % 4], stageIds: [`_RAW_S${index}_`], cause, detail: index === 2 ? '_RAW_DETAIL_' : '', lastKnownPath: index === 2 ? '/_RAW_OLD_' : null })) },
    { kind: 'media-unavailable', entries: [{ assetRef: '_RAW_ONE_', field: 'image', stageIds: [], cause: 'not-found' }] },
    { kind: 'archive-name-collision', conflicts: [{ assetRef: '_RAW_A_', archiveName: '_RAW_B_' }] },
    { kind: 'media-oracle', disagreements: [{ assetRef: '_RAW_A_', stageUuid: '_RAW_UUID_', kind: 'audio', expected: '_RAW_X_', observed: '_RAW_Y_' }, { assetRef: '_RAW_B_', expected: '_RAW_a<b&', observed: '_RAW_Z_' }] },
    { kind: 'export-cancelled' }, { kind: 'output-write', path: '/_RAW_PARTIAL_', message: coded }, { kind: 'output-write' },
    { kind: 'request', message: coded }, { kind: 'request' }, { kind: '_RAW_KIND_' }, '_RAW_UNTYPED_', null,
  ];
  await engine.changeLanguage('fr');
  const states = [];
  for (const raw of raws) {
    const a = nowOutcome.classifyExportRefusal(raw); const b = oldOutcome.classifyExportRefusal(raw);
    assert.equal(a.title, fixed(b.title)); assert.equal(a.message, fixed(b.message)); assert.equal(a.kind, b.kind); assert.equal(a.preparationKind, b.preparationKind);
    const view = (m, refusal) => React.createElement(m.ExportRefusalReport, { refusal, onDismiss() {}, onOpenDiagnostics() {}, stagePaths: [{ uuid: '_RAW_S2_', path: '/_RAW_STAGE_' }], onFocusPath() {} });
    assert.equal(html(view(nowReport, a)), fixed(html(view(oldReport, b))), `refus FR ${raw?.kind ?? raw}`);
    for (const embedded of [true]) assert.equal(html(React.createElement(nowReport.ExportRefusalReport, { refusal: a, embedded })), fixed(html(React.createElement(oldReport.ExportRefusalReport, { refusal: b, embedded }))));
    states.push(a);
  }
  for (const cause of causes) assert.equal(nowOutcome.groupUnavailableMedia([{ assetRef: 'r', cause }])[0].causeLabel, fixed(oldOutcome.groupUnavailableMedia([{ assetRef: 'r', cause }])[0].causeLabel));
  for (const field of ['image', 'audio', '_RAW_F_', undefined]) assert.equal(nowOutcome.mediaFieldLabel(field), fixed(oldOutcome.mediaFieldLabel(field)));
  const success = { conversions: ['verbatim', 'renamed', 'reencoded', 'resized', '_RAW_T_', undefined].map((transformation) => ({ transformation })) };
  assert.deepEqual(JSON.parse(JSON.stringify(nowOutcome.summarizeExportSuccess(success))), fixedDeep(JSON.parse(JSON.stringify(oldOutcome.summarizeExportSuccess(success)))));
  const readiness = { blocked: true, interoperability: 'PREPARED', dimensions: ['UNTESTED', 'PREPARED', 'SUPPORTED', '_RAW_Q_'].map((qualification) => ({ id: qualification, qualification })), unevaluated: [],
    diagnostics: [{ source: 'decode', severity: 'ERROR', ...coded }, { source: 'decode', ...coded }, { source: 'graph-integrity', ...coded }, ...['INFO', 'WARNING', 'ACTION_REQUIRED', 'ERROR', '_RAW_L_'].map((level) => ({ source: 'authoring', level, ...coded })), { source: 'readiness', level: 'WARNING', ...coded }, { source: '_RAW_SRC_', ...coded }, coded] };
  const summaryNow = nowReadiness.summarizeReadiness(readiness);
  assert.deepEqual(JSON.parse(JSON.stringify(summaryNow)), fixedDeep(JSON.parse(JSON.stringify(oldReadiness.summarizeReadiness(readiness)))));
  for (const interoperability of [undefined, 'UNTESTED', '_RAW_I_']) assert.equal(nowReadiness.summarizeReadiness({ ...readiness, interoperability }).interoperabilityLabel, oldReadiness.summarizeReadiness({ ...readiness, interoperability }).interoperabilityLabel);
  for (const outputFolder of ['', '/out']) {
    const failure = (m) => { try { m.buildExportRequest({ project: outputFolder ? {} : { authoring: { payload: 'x' } }, outputFolder }); return null; } catch (error) { return [error.code, error.message]; } };
    assert.deepEqual(failure(nowRequest), fixedDeep(failure(oldRequest)));
  }
  const diagnostics = (m) => React.createElement(m.DiagnosticsPanel, { issues: [{ id: '1', message: '_RAW_MSG_', category: '_RAW_CAT_', nodePath: '/_RAW_N_', nodeLabel: '_AUTHOR_NODE_' }, { id: '2', message: '_RAW_MSG2_', category: '_RAW_CAT_' }], onFocusPath() {}, onGesture() {}, onOpenForm() {} });
  const issuesPanel = (m, o) => React.createElement(m.AdvancedIssuesPanel, { context: { blockingIssues: [], working: true, exportState: { refusal: o.classifyExportRefusal({ kind: 'export-cancelled' }), dismissRefusal() {} } }, onRequestClose() {} });
  const review = (m, isCurrentRevision) => React.createElement(m.ZipReviewPanel, { review: { zipPath: '/_RAW_ZIP_', isCurrentRevision }, onClose() {} });
  assert.equal(html(diagnostics(nowDiag)), fixed(html(diagnostics(oldDiag))));
  assert.equal(html(React.createElement(nowDiag.DiagnosticsPanel, { issues: [] })), fixed(html(React.createElement(oldDiag.DiagnosticsPanel, { issues: [] }))));
  assert.equal(html(issuesPanel(nowDiag, nowOutcome)), fixed(html(issuesPanel(oldDiag, oldOutcome))));
  for (const flag of [true, false]) assert.equal(html(review(nowReview, flag)), fixed(html(review(oldReview, flag))));
  // Même objet de refus déjà classé, même lignes de qualification : relus FR → EN → IT.
  const seen = [];
  for (const lng of [...LANGUAGES, 'pseudo']) {
    await engine.changeLanguage(lng);
    const outputs = [...states.map((refusal) => html(React.createElement(nowReport.ExportRefusalReport, { refusal, onDismiss() {}, onOpenDiagnostics() {} }))), html(diagnostics(nowDiag)), html(issuesPanel(nowDiag, nowOutcome)), html(review(nowReview, true)), html(review(nowReview, false)),
      summaryNow.diagnostics.map((row) => `${row.levelLabel}|${row.sourceLabel}`).join(), summaryNow.interoperabilityLabel, summaryNow.dimensions.map((row) => row.qualificationLabel).join()];
    for (const output of outputs) assert.doesNotMatch(output, /\[object Object\]|checker:[a-z]+\./);
    if (lng === 'pseudo') outputs.slice(0, -3).forEach(surface); else seen.push(outputs);
  }
  for (let i = 0; i < seen[0].length; i++) { assert.notEqual(seen[0][i], seen[1][i], `EN ${i}`); assert.notEqual(seen[0][i], seen[2][i], `IT ${i}`); }
  const oracle = states.find((refusal) => refusal.kind === 'media-oracle');
  assert.match(html(React.createElement(nowReport.ExportRefusalReport, { refusal: oracle })), /<code>_RAW_a&lt;b&amp;<\/code>/, 'donnée technique échappée');
  await engine.changeLanguage('fr');
});

test('Pastille « à corriger », validation et identité : FR identique, issues relues à chaud sans recalcul', async () => {
  const [nowPill, oldPill] = await load('/src/components/layout/ValidationPill.jsx');
  const [nowValidation, oldValidation] = await load('/src/store/projectValidation.js');
  const [nowIdentity, oldIdentity] = await load('/src/store/packIdentityCheck.js');
  const projects = [
    { projectType: 'pack', projectName: '', rootEntries: [] },
    { projectType: 'pack', projectName: '_AUTHOR_P_', rootAudio: 'a', rootImage: 'b', rootEntries: [{ id: 's1', type: 'story', name: '' }, { id: 'm1', type: 'menu', name: '_AUTHOR_MENU_', children: [] }, { id: 's1', type: 'story', name: '_AUTHOR_S_' }] },
    { projectType: undefined },
  ];
  await engine.changeLanguage('fr');
  for (const project of projects) {
    const a = nowValidation.getProjectValidationIssues(project); const b = oldValidation.getProjectValidationIssues(project);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    assert.deepEqual(nowValidation.getGenerateErrors(project), oldValidation.getGenerateErrors(project));
  }
  const issues = nowValidation.getProjectValidationIssues(projects[1]);
  const pill = (m, props) => React.createElement(m.ValidationPill, { open: true, onOpenChange() {}, ...props });
  const cases = [{ validationIssues: [] }, { validationIssues: issues }, { validationIssues: issues.slice(0, 1), shortcutLabel: 'Ctrl+K' }, { pathAuditPending: true, validationIssues: issues }, { validationIssues: [{ id: 'x', status: 'warning', text: '_RAW_NO_LOCATION_' }] }];
  for (const props of cases) assert.equal(html(pill(nowPill, props)), html(pill(oldPill, props)));
  const errors = [{ code: 'COMFYUI_SERVICE_ERROR', params: {} }, '', "L'UUID du pack « {x} » n'est pas lisible."];
  for (const error of errors) {
    const invoke = async () => { throw error; };
    const identityNow = await nowIdentity.packIdentityRefusal('x', invoke), identityOld = await oldIdentity.packIdentityRefusal('x', invoke);
    // Lot 4.13 : seules les phrases du catalogue UI sont corrigées ; les messages Rust gardent leur typographie.
    assert.equal(identityNow, identityNow === identityOld ? identityOld : fixed(identityOld));
  }
  const refusal = await nowIdentity.checkPackIdentity('x', async () => { throw errors[0]; });
  const before = JSON.stringify(issues); const seen = [];
  for (const lng of [...LANGUAGES, 'pseudo']) {
    await engine.changeLanguage(lng);
    const outputs = [...cases.map((props) => html(pill(nowPill, { ...props, validationIssues: props.validationIssues === issues ? issues : props.validationIssues }))), issues.map((row) => row.text).join('\n'), nowIdentity.presentIdentityRefusal(refusal.error)];
    if (lng === 'pseudo') outputs.slice(0, 4).forEach(surface); else seen.push(outputs);
  }
  for (let i = 0; i < seen[0].length; i++) { assert.notEqual(seen[0][i], seen[1][i], `EN ${i}`); assert.notEqual(seen[0][i], seen[2][i], `IT ${i}`); }
  assert.equal(JSON.stringify(issues.map(({ id, status }) => ({ id, status }))), JSON.stringify(JSON.parse(before).map(({ id, status }) => ({ id, status }))));
  await engine.changeLanguage('fr');
});

test('Parcours du vérificateur : étape 1 identique à BASE, natifs et libellés vivants du dialogue UUID', async () => {
  const [now, old] = await load('/src/components/CommunityPackChecker/CommunityPackCheckerFunnel.jsx');
  const { checkerText } = await current.ssrLoadModule('/src/i18n/useCheckerTranslation.js');
  const { checkerRef } = await current.ssrLoadModule('/src/i18n/checkerPresentation.js');
  const { presentStoredError } = await current.ssrLoadModule('/src/i18n/userMessage.js');
  await engine.changeLanguage('fr');
  const funnel = (m) => React.createElement(m.CommunityPackCheckerFunnel, { onClose() {} });
  const fixtures = [{}, { zipPath: '/_AUTHOR_DIR_/p.zip' }, { step: 1, report: REPORTS.fixable }, { step: 1, report: REPORTS.optionalOne }, { step: 1, report: REPORTS.conform }, { step: 2, report: REPORTS.fixable },
    { phase: 'analyzing' }, { phase: 'fixing' }, ...[{ audioFixed: 1, imageFixed: 2, metadataFixed: true }, { imageFixed: 1 }, {}].map((result) => ({ phase: 'done', result: { fixedZipPath: '/_AUTHOR_OUT_.zip', ...result } }))];
  for (const fixture of fixtures) {
    globalThis.__checkerFixture = fixture;
    assert.equal(html(funnel(now)), fixed(html(funnel(old))), JSON.stringify(fixture));
  }
  const dialog = () => html(React.createElement('div', null, checkerText('checker:metadata.uuidPrompt.title'), presentStoredError(checkerRef('checker:metadata.uuidPrompt.message')), checkerText('checker:metadata.uuidPrompt.confirm'), checkerText('checker:metadata.uuidPrompt.keep')));
  assert.equal(dialog(), `<div>Générer un nouvel UUID ?La correction crée une nouvelle archive. Un nouvel UUID permet de l’identifier comme un pack distinct.Générer un nouvel UUIDConserver l’UUID actuel</div>`);
  const seen = [];
  for (const lng of [...LANGUAGES, 'pseudo']) {
    await engine.changeLanguage(lng);
    const outputs = [...fixtures.map((fixture) => { globalThis.__checkerFixture = fixture; return html(funnel(now)); }), dialog(), engine.t('native:checker.pack.title'), engine.t('native:file.pack.filterLabel'), engine.t('native:export.output.title')];
    if (lng === 'pseudo') outputs.slice(0, -3).forEach(surface); else seen.push(outputs);
  }
  for (let i = 0; i < seen[0].length; i++) { assert.notEqual(seen[0][i], seen[1][i], `EN ${i}`); assert.notEqual(seen[0][i], seen[2][i], `IT ${i}`); }
  delete globalThis.__checkerFixture;
  await engine.changeLanguage('fr');
});
