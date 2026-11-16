import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';

const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [{
  name: 'checker-report-details', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/CommunityPackChecker.jsx')) return code + '\nexport { buildProblemGroups, ProblemGroupCard, TechnicalDetail };';
  },
}, react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
test.after(() => server.close());
const ui = await server.ssrLoadModule('/src/components/CommunityPackChecker/CommunityPackChecker.jsx');
const { formatHtmlReport } = await server.ssrLoadModule('/src/components/CommunityPackChecker/communityPackExports.js');
const { presentCheckerReport } = await server.ssrLoadModule('/src/i18n/checkerMessages.js');
const { reportPresentationCounts } = await server.ssrLoadModule('/src/components/CommunityPackChecker/packCheckerIssueClassification.js');
const { translateChecker } = await server.ssrLoadModule('/src/i18n/checkerPresentation.js');
const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
const engine = initializeI18n('fr');
const render = (element) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, element));
const issue = (extra) => ({ category: 'audio', severity: 'error', fixDisposition: 'automatic', autoFixAvailable: true, filePath: 'assets/story.mp3', label: 'Chat', code: 'audioLeadingSilenceTooShort', ...extra });
const base = {
  packName: 'Pack.zip', verdict: 'needsFix', correctionsAvailable: 1, optionalCorrectionsAvailable: 0,
  titleSummary: { total: 1, warnings: 1 }, audioItems: [{ filePath: 'assets/story.mp3', itemType: 'CHECKER_ROLE_STORY', leadingSilenceSecs: 0.12 }],
  structureSummary: { luniiCompatible: true, storyStudioEditable: false },
  issues: [issue({ autoFixDescription: 'Volume., Ajouter 0.40 s. Sera corrigé au mieux, mais restera un peu faible.', technicalDetails: 'Détecté : 0.12 s. Niveau : -20.1 LUFS. Fenêtre : -20.0 à -10.0 LUFS.' }),
    issue({ category: 'title', severity: 'warning', code: 'CHECKER_TITLE', filePath: null, label: 'Nom', autoFixAvailable: false, fixDisposition: 'manual' }),
    issue({ category: 'structure', code: 'CHECKER_AUTHORING_CLASSIFICATION_REFUSED', autoFixAvailable: false, fixDisposition: 'manual', filePath: null, message: 'authoring-editable', technicalDetails: 'canonique' })],
};
const report = (value) => render(React.createElement(ui.ReportView, { report: value }));
const callout = (text, css) => text.match(new RegExp(`<div class="${css}">([\\s\\S]*?)</div>`))[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

test('D5/D8: same independent counts on screen and HTML, including assisted naming', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    await engine.changeLanguage(lng);
    const screen = callout(report(base), 'checker-report-callout');
    const exported = callout(formatHtmlReport(base), 'report-callout');
    assert.equal(screen, exported);
    assert.deepEqual([...screen.matchAll(/\d+/g)].map(([number]) => Number(number)), [0, 0, 1, 1, 0]);
  }
});

test('D1/D9/D15: automatic rows, translated roles, graph information, localized decimals and complete best effort sentence', async () => {
  for (const [lng, role, decimal] of [['fr', 'Histoire', ','], ['en', 'Story', '.'], ['it', 'Storia', ',']]) {
    await engine.changeLanguage(lng);
    const groups = ui.buildProblemGroups(base);
    const expanded = render(React.createElement('div', null, groups.map(group => React.createElement(ui.ProblemGroupCard, { key: group.id, group, expanded: true, onToggle() {} }))));
    const html = formatHtmlReport(base);
    for (const text of [expanded, html]) {
      assert.match(text, new RegExp(role));
      assert.doesNotMatch(text.replace(/<style>[\s\S]*?<\/style>/g, ''), /mini-severity--error|authoring-editable|canonique|volume\.,|Volume\.,/);
    }
    assert.ok(html.includes(`0${decimal}40 s`));
    assert.ok(html.includes(`-20${decimal}1 LUFS`));
    assert.ok(html.includes(`-20${decimal}0 à -10${decimal}0 LUFS`));
    assert.match(html, /Sera corrigé au mieux, mais restera un peu faible\./);
    assert.doesNotMatch(report({ ...base, correctionsAvailable: 0, titleSummary: { total: 1, ok: 1 }, issues: [base.issues[2]] }), /checker-report-verdict--(?:listen|fix)/);
  }
});

test('D5/D17: four structural findings are four points to check, zero sounds to listen to', async () => {
  await engine.changeLanguage('fr');
  const value = { ...base, verdict: 'invalid', correctionsAvailable: 0, issues: Array.from({ length: 4 }, (_, i) => issue({ category: 'structure', filePath: null, code: `missing${i}`, label: `Écran ${i}`, autoFixAvailable: false, fixDisposition: 'manual' })) };
  for (const text of [report(value), formatHtmlReport(value)]) {
    assert.match(text, /<strong>4<\/strong><small>points<\/small>/);
    assert.doesNotMatch(text, /<strong>4<\/strong> à écouter/);
    assert.match(text, /<strong>4<\/strong> à vérifier/);
  }
});

test('D15: a finding without an automatic action has a finding heading and translated category', async () => {
  await engine.changeLanguage('fr');
  const html = formatHtmlReport({ ...base, issues: [base.issues[1], base.issues[2]] });
  assert.match(html, />Constat</);
  assert.doesNotMatch(html, />title<|>structure<|>TITLE</);
});

test('D9: real Rust structure envelope keeps its classification after translation', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    await engine.changeLanguage(lng);
    const raw = { ...base, correctionsAvailable: 0, issues: [{ category: 'structure', severity: 'warning', autoFixAvailable: false, fixDisposition: 'none', message: JSON.stringify({ code: 'CHECKER_AUTHORING_CLASSIFICATION_REFUSED', params: {} }), technicalDetails: 'authoring-editable / canonique' }] };
    const presented = presentCheckerReport(raw);
    assert.equal(presented.issues[0].code, 'CHECKER_AUTHORING_CLASSIFICATION_REFUSED');
    for (const html of [report(presented), formatHtmlReport(raw)]) {
      assert.doesNotMatch(html, /(?:checker-)?group--review|authoring-editable|canonique/);
    }
    assert.equal(raw.issues[0].code, undefined);
  }
});

test('D15: trailing silence description uses the translated side and decimal separator', async () => {
  const description = JSON.stringify({ code: 'CHECKER_SILENCE_PADDING_DESCRIPTION', params: { side: { code: 'LABEL_SILENCE_END', params: {} }, targetSilenceSeconds: '0.40' } });
  for (const [lng, expected] of [['fr', 'Ajouter du silence à la fin pour atteindre 0,40 s.'], ['en', 'Add silence at the end to reach 0.40 s.'], ['it', 'Aggiungere silenzio alla fine fino a 0,40 s.']]) {
    await engine.changeLanguage(lng);
    const html = formatHtmlReport({ ...base, issues: [issue({ autoFixDescription: description })] });
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /au fin/);
  }
});

test('les descriptions des corrections combinées et des silences restent lisibles dans les détails et le HTML', async () => {
  const envelope = (code, params = {}) => JSON.stringify({ code, params });
  const autoFixDescription = envelope('UI_MESSAGE_PARTS', { parts: { data: true, separator: ', ', messages: [
    envelope('CHECKER_VOLUME_BEST_EFFORT'),
    envelope('CHECKER_SILENCE_PADDING_DESCRIPTION', { side: { code: 'LABEL_SILENCE_END', params: {} }, targetSilenceSeconds: '0.40' }),
  ] } });
  for (const [lng, sentence] of [['fr', 'Sera corrigé au mieux, mais restera un peu faible.'], ['en', 'Will be adjusted as much as possible, but will remain a little quiet.'], ['it', 'Sarà corretto al meglio, ma resterà un po’ basso.']]) {
    await engine.changeLanguage(lng);
    const raw = { ...base, issues: [issue({ autoFixDescription })] };
    const shown = presentCheckerReport(raw);
    const record = ui.buildProblemGroups(shown)[0].records[0];
    for (const html of [render(React.createElement(ui.TechnicalDetail, { record })), formatHtmlReport(raw)]) {
      assert.ok(html.includes(sentence));
      assert.doesNotMatch(html, /\.,|\[object Object\]|UI_MESSAGE_PARTS/);
    }
  }
});

test('M1: missing story title belongs only to assisted naming; other missing fields still need structural review', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    await engine.changeLanguage(lng);
    const envelope = (code, params = {}) => JSON.stringify({ code, params });
    const missingField = (field) => ({ category: 'structure', severity: 'error', autoFixAvailable: false,
      fixDisposition: 'none', message: envelope('CHECKER_STORY_FIELD_MISSING', { field }) });
    const raw = { ...base, verdict: 'invalid', correctionsAvailable: 0,
      structureSummary: { luniiCompatible: false, storyStudioEditable: false, stageCount: 16 },
      issues: [{ category: 'title', severity: 'error', autoFixAvailable: false, fixDisposition: 'none',
        message: envelope('CHECKER_PACK_TITLE_EMPTY') }, missingField('title')] };
    const shown = presentCheckerReport(raw);
    assert.deepEqual(reportPresentationCounts(shown), { assisted: 1, review: 0, listen: 0, automatic: 0, optional: 0 });
    const groups = ui.buildProblemGroups(shown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, 'title');
    assert.equal(groups[0].count, 1);
    for (const html of [report(shown), formatHtmlReport(raw)]) {
      assert.match(html, /report-verdict--fix/);
      assert.doesNotMatch(html, /(?:checker-)?group--structure|story\.json/);
      assert.match(html, /summary-tile--ok[\s\S]*?16/);
    }
    const broken = { ...raw, issues: [...raw.issues, missingField('stageNodes')] };
    for (const html of [report(presentCheckerReport(broken)), formatHtmlReport(broken)]) {
      assert.match(html, /report-verdict--listen/);
      assert.match(html, /(?:checker-)?group--structure/);
      assert.match(html, /summary-tile--listen/);
    }
    const invalidAudio = { ...raw, issues: [...raw.issues, issue({ code: 'CHECKER_AUDIO_FORMAT', severity: 'error' })] };
    for (const html of [report(presentCheckerReport(invalidAudio)), formatHtmlReport(invalidAudio)]) {
      assert.match(html, /report-verdict--listen/);
    }
    assert.equal(raw.issues[1].category, 'structure');
  }
});

test('m1: clipping percentages follow the decimal separator on screen and in HTML', async () => {
  for (const [lng, decimal] of [['fr', ','], ['en', '.'], ['it', ',']]) {
    await engine.changeLanguage(lng);
    const value = { ...base, issues: [issue({ code: 'CHECKER_AUDIO_CLIPPED', severity: 'warning',
      autoFixAvailable: false, fixDisposition: 'none', message: '0.05 %', technicalDetails: '0.05 %' })] };
    const groups = ui.buildProblemGroups(value);
    for (const html of [render(React.createElement(ui.TechnicalDetail, { record: groups[0].records[0] })), formatHtmlReport(value)]) {
      assert.ok(html.includes(`0${decimal}05 %`));
    }
  }
});

test('m2: graph editor is mentioned once without a problem group or point count', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    await engine.changeLanguage(lng);
    const value = { ...base, issues: [base.issues[2]] };
    assert.deepEqual(ui.buildProblemGroups(value), []);
    for (const html of [report(value), formatHtmlReport(value)]) {
      assert.equal([...html.matchAll(/class="(?:checker-)?graph-information"/g)].length, 1);
      assert.doesNotMatch(html, /(?:checker-)?group--graphEditor/);
      assert.equal(html.split(translateChecker('checker:structure.graphEditor')).length - 1, 1);
    }
  }
});

test('m7: two optional edges on one file have distinct rows and each suggestion appears once', async () => {
  await engine.changeLanguage('fr');
  const leading = issue({ code: 'audioLeadingSilenceLong', severity: 'info', fixDisposition: 'optional',
    message: 'Début long', autoFixDescription: 'Réduire le début' });
  const trailing = { ...leading, code: 'audioTrailingSilenceLong', message: 'Fin longue', autoFixDescription: 'Réduire la fin' };
  const value = { ...base, audioItems: [{ ...base.audioItems[0], leadingSilenceSecs: 1.35, trailingSilenceSecs: 1.35 }],
    issues: [leading, trailing] };
  const group = ui.buildProblemGroups(value)[0];
  assert.equal(group.count, 2);
  assert.deepEqual(group.records.map(record => record.sectionIssues.map(issue => issue.code)), [[leading.code], [trailing.code]]);
  for (const html of [render(React.createElement(ui.ProblemGroupCard, { group, expanded: true, onToggle() {} })), formatHtmlReport(value)]) {
    assert.match(html, /2<\/strong><small>suggestions<\/small>/);
    const summaries = [...html.split('class="section-head"')[0].matchAll(/class="(?:checker-)?mini-problem"[^>]*>([^<]*)</g)].map(match => match[1]);
    assert.equal(summaries.length, 2);
    assert.notEqual(summaries[0], summaries[1]);
  }
});
