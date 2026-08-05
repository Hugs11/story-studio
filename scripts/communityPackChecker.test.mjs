import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDiagnosticJson,
  formatHtmlReport,
  formatReadableReport,
  formatTechnicalLog,
  reportBaseName,
} from '../src/components/CommunityPackChecker/communityPackExports.js';
import {
  isOptionalSilenceIssue,
  optionalSilenceIssues,
  optionalSilenceSelectionKey,
  packCorrectionCounts,
  serializeOptionalSilenceSelection,
} from '../src/components/CommunityPackChecker/packCheckerIssueClassification.js';

const report = {
  packName: 'Le voyage de Milo.zip',
  verdict: 'needsFix',
  summary: { errors: 1, warnings: 2, infos: 1, ok: 4 },
  correctionsAvailable: 2,
  optionalCorrectionsAvailable: 1,
  audioSummary: { ok: 3, total: 4 },
  imageSummary: { ok: 1, total: 1 },
  structureSummary: { luniiCompatible: false, storyStudioEditable: true },
  nightMode: { detected: false },
  issues: [{
    severity: 'warning',
    category: 'audio',
    label: 'Introduction',
    message: 'Le silence au début est trop court.',
    filePath: 'assets/intro.mp3',
    technicalDetails: 'Détecté : 0.30 s.',
    autoFixDescription: 'Ajouter du silence.',
    autoFixAvailable: true,
    code: 'audioLeadingSilenceTooShort',
    fixDisposition: 'automatic',
  }, {
    severity: 'info',
    category: 'audio',
    label: 'Introduction',
    message: 'Le silence à la fin est long.',
    filePath: 'assets/intro.mp3',
    technicalDetails: 'Détecté : 1.50 s.',
    autoFixDescription: 'Ramener facultativement le silence à la fin à 0,40 s.',
    autoFixAvailable: true,
    code: 'audioTrailingSilenceLong',
    fixDisposition: 'optional',
  }],
  technicalLog: ['[OK] Lecture du ZIP', '[WARN] intro.mp3 silence court'],
};

test('reportBaseName removes zip extension and dangerous filename characters', () => {
  assert.equal(reportBaseName({ packName: 'Milo: forêt.zip' }), 'Milo_ forêt');
});

test('formatReadableReport includes verdict, issues and technical log', () => {
  const text = formatReadableReport(report);
  assert.match(text, /Pack analysé : Le voyage de Milo\.zip/);
  assert.match(text, /Verdict : Pack à corriger avant validation/);
  assert.match(text, /Introduction : Le silence au début est trop court/);
  assert.match(text, /Suggestions facultatives : 1/);
  assert.match(text, /Suggestion facultative : Ramener facultativement/);
  assert.match(text, /\[WARN\] intro\.mp3 silence court/);
});

test('formatTechnicalLog keeps one log line per line', () => {
  assert.equal(formatTechnicalLog(report), '[OK] Lecture du ZIP\n[WARN] intro.mp3 silence court');
});

test('formatDiagnosticJson serializes the structured report', () => {
  assert.equal(JSON.parse(formatDiagnosticJson(report)).packName, 'Le voyage de Milo.zip');
});

test('formatHtmlReport builds a standalone browser document', () => {
  const text = formatHtmlReport(report);
  assert.match(text, /<!doctype html>/i);
  assert.match(text, /<style>/);
  assert.match(text, /Vérifier un pack/);
  assert.match(text, /Le voyage de Milo\.zip/);
  assert.match(text, /Imprimer \/ PDF/);
  assert.match(text, /Suggestions facultatives/);
  assert.match(text, /<strong>1<\/strong> facultatives/);
});

test('optional silence classification and counters stay separate from automatic fixes', () => {
  const suggestions = optionalSilenceIssues(report);
  assert.equal(suggestions.length, 1);
  assert.equal(isOptionalSilenceIssue(suggestions[0]), true);
  assert.deepEqual(packCorrectionCounts(report), { automatic: 2, optional: 1 });
});

test('optional silence selection is empty by default and serializes exact file edges', () => {
  assert.deepEqual(serializeOptionalSilenceSelection(report, new Set()), []);
  const suggestion = optionalSilenceIssues(report)[0];
  const selected = new Set([optionalSilenceSelectionKey(suggestion)]);
  assert.deepEqual(serializeOptionalSilenceSelection(report, selected), [{
    filePath: 'assets/intro.mp3',
    edge: 'trailing',
  }]);
});

test('suggestion-only reports stay visibly conforming', () => {
  const suggestionOnly = {
    ...report,
    verdict: 'valid',
    correctionsAvailable: 0,
    optionalCorrectionsAvailable: 1,
    summary: { errors: 0, warnings: 0, infos: 1, ok: 4 },
    issues: [report.issues[1]],
  };
  const html = formatHtmlReport(suggestionOnly);
  assert.match(html, /Pack conforme, avec 1 ajustement facultatif/);
});
