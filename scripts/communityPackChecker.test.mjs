import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDiagnosticJson,
  formatHtmlReport,
  formatReadableReport,
  formatTechnicalLog,
  reportBaseName,
} from '../src/components/CommunityPackChecker/communityPackExports.js';

const report = {
  packName: 'Le voyage de Milo.zip',
  verdict: 'needsFix',
  summary: { errors: 1, warnings: 2, infos: 1, ok: 4 },
  correctionsAvailable: 2,
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
});
