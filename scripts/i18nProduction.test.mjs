import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import i18next from 'i18next';
import { BASE, sources, dependencySources } from './i18nProductionSourceFixture.mjs';
import { applyLot413 } from './i18nLot413Corrections.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { checkCatalogues, checkSource, sourceHash } from './check-i18n.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import fr from '../src/locales/fr/production.json' with { type: 'json' };
import en from '../src/locales/en/production.json' with { type: 'json' };
import it from '../src/locales/it/production.json' with { type: 'json' };
import meta from '../src/locales/_meta/production.json' with { type: 'json' };
import { productionRef } from '../src/i18n/productionPresentation.js';
import { presentUserMessage, presentStoredError } from '../src/i18n/userMessage.js';
import { renderJobReport, PRODUCTION_STATUS_LABELS } from '../src/store/production/productionReport.js';
import { documentBlockage } from '../src/store/production/advancedProduction.js';
import { readsAsCancellation, freeJobOutcome } from '../src/store/production/renderQueueWork.js';

const resources = { fr: { production: fr }, en: { production: en }, it: { production: it } };
// Textes ajoutés après BASE pour la vérification disque indéterminée. Ils sont
// ancrés explicitement ici ; la fixture d'équivalence historique reste intacte.
const FILE_VERIFICATION_COPY = {
  'refusal.verification.title': 'Vérification impossible',
  'refusal.verification.message': 'La présence de certains médias n’a pas pu être vérifiée. Rien n’a été généré. Réessayez.',
};
function surface(html) {
  assert.doesNotMatch(html, /production:[a-z]+\.|\[object Object\]/);
  const values = [...html.matchAll(/>([^<>]+)</g), ...html.matchAll(/(?:title|aria-label|alt|placeholder)="([^"]+)"/g)].map(m => m[1].trim());
  for (const value of values) {
    if (!/\p{L}{2}/u.test(value) || value.includes('_AUTHOR_') || value.includes('_RAW_')) continue;
    assert.ok(value.includes('[') || /[ëïü]/.test(value), `hors catalogue : ${value}`);
  }
}
async function server(original = false) {
  return createServer({ configFile: false, plugins: [{ name: 'production-fixture', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && sources[file]) code = sources[file];
    if (id.endsWith('/RenderQueuePanel/RenderQueuePanel.jsx')) code += '\nexport { JobCard };';
    if (id.endsWith('/common/AppModalPortal.jsx')) return 'import {createElement} from "react"; export function AppModalPortal({children}) {return createElement("div",null,children);}';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}
const job = (status = 'pending', extra = {}) => ({ id: 'j', nature: 'free', projectName: '_AUTHOR_NAME_', outputFolder: '/_AUTHOR_FOLDER_', status, logs: [], warnings: [], createdAt: 1000, ...extra });

test('Production : catalogue, source indépendante, mutation FR détectée et exception common', () => {
  assert.equal(BASE, 'ead31360c9da01844f0dbc878395ea60990914bc');
  assert.deepEqual(checkCatalogues(resources, { production: meta }).errors, []);
  assert.ok(checkSource('productionRef(unknownKey)', 'src/hooks/unknown.js', resources).errors.some(error => error.includes('clé dynamique non déclarée')));
  // Lot 4.13 : corrections FR explicites appliquées à la source BASE.
  const source = applyLot413(Object.values({ ...sources, ...dependencySources }).join('\n'));
  const interpolated = new Set(['report.measurement.initial', 'report.measurement.final', 'report.measurement.gain', 'report.measurement.limiting', 'generation.blocked.message', 'save.error.message', 'save.rollback.message', 'refusal.empty.message', 'refusal.media.message', 'refusal.assessment.message', 'refusal.mediaCheck.message', 'work.prepare.message', 'work.lock.message', 'native.title.qualified']);
  for (const [key, text] of Object.entries(fr)) {
    for (const lng of ['en', 'it']) if (key in resources[lng].production) {
      assert.equal(meta[key][lng].status, 'ai-reviewed');
      assert.equal(meta[key][lng].sourceHash, sourceHash(text));
      if (!['native.title.qualified', 'report.measurement.gain'].includes(key)) assert.notEqual(resources[lng].production[key], text, `${lng}:${key}`);
    }
    if (interpolated.has(key) || /_(one|many|other)$/.test(key)) continue;
    if (Object.hasOwn(FILE_VERIFICATION_COPY, key)) {
      assert.equal(text, FILE_VERIFICATION_COPY[key]);
      continue;
    }
    assert.ok(source.includes(text) || source.includes(text.replaceAll("'", "\\'")), `${key}: absent de git show BASE`);
  }
  for (const lng of ['en', 'it']) {
    const mutation = structuredClone(resources); mutation[lng].production['queue.panel.title'] = fr['queue.panel.title'];
    assert.ok(checkCatalogues(mutation, { production: meta }).errors.some(e => e.includes(`${lng}/production:queue.panel.title règle d’or`)));
  }
  const common = createTestI18n();
  assert.equal(common.t('common:toolbar.generate.blocked'), 'Passe par « À corriger » avant de générer.');
  assert.equal(common.t('common:project.saveAs.fallbackLabel'), 'Enregistrer sous…');
  assert.throws(() => surface('<span title="File de rendu">File de rendu</span>'), /hors catalogue/);
});

test('Production : CLDR, codes/paramètres, tables/rapport/refus conservés à chaud sans mutations auteur', async () => {
  i18next.init(createTestI18n().options);
  const state = { project: { name: '_AUTHOR_NAME_', text: 'Auteur...' }, undo: [], dirty: false, error: productionRef('production:save.error.message', { reason: { userMessage: { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' } } }) };
  const before = JSON.stringify(state);
  const rollback = productionRef('production:save.rollback.message', { reason: { userMessage: '_RAW_SAVE_' }, rollback: { userMessage: '_RAW_ROLLBACK_' } });
  assert.equal(presentUserMessage(rollback).technicalDetail, '_RAW_SAVE_\n_RAW_ROLLBACK_');
  assert.equal(presentStoredError(productionRef('production:generation.blocked.message', { errors: { messages: ['ERROR A', 'ERROR B'], separator: '\n• ', data: true } })), 'Impossible de générer le pack :\n\n• ERROR A\n• ERROR B');
  const table = PRODUCTION_STATUS_LABELS;
  const report = renderJobReport(job('running', { logs: [{ code: 'GENERATION_QUEUE_START', params: { projectName: '_AUTHOR_NAME_' } }], gateObservations: [{ gate: 'readiness', label: { code: 'LABEL_EXPORT_READINESS_VALUE', params: {} }, note: { code: 'GENERATION_GATE_PUBLICATION_FOLLOWS', params: {} }, outcome: 'passed', blocking: false, reasons: [{ code: 'COMFYUI_SERVICE_ERROR', params: {}, path: 'path' }] }] }));
  const refusal = documentBlockage({ blocked: true, blocking: [] });
  const seen = [];
  for (const lng of ['fr', 'en', 'it']) {
    await i18next.changeLanguage(lng);
    for (const count of [0, 1, 2, 1000000]) for (const key of ['queue.warnings.count', 'report.warnings.count', 'report.progress.count', 'queue.active.count', 'refusal.readiness.message']) {
      const category = new Intl.PluralRules(lng).select(count);
      assert.equal(i18next.t(`production:${key}`, { count }), resources[lng].production[`${key}_${category}`].replaceAll('{{count}}', count));
    }
    assert.equal(Object.keys(resources[lng].production).some(k => k.endsWith('_zero')), false);
    const envelope = { code: 'GENERATION_QUEUE_OUTPUT_FOLDER', params: { outputFolder: '/_AUTHOR_FOLDER_' }, detail: '_RAW_DETAIL_' };
    const shown = presentUserMessage(envelope, { allowLegacyFrench: false });
    assert.equal(shown.code, envelope.code); assert.notEqual(shown.code, 'GENERATION_QUEUE_CANCELLED');
    assert.equal(shown.fallback, false); assert.equal(shown.technicalDetail, '_RAW_DETAIL_');
    assert.ok(shown.message.includes('/_AUTHOR_FOLDER_')); assert.doesNotMatch(shown.message, /\[object Object\]/);
    assert.equal(readsAsCancellation({ code: 'GENERATION_CANCELLED', params: {}, detail: 'text changed' }), true);
    assert.equal(readsAsCancellation({ code: 'OTHER_ERROR', params: {}, detail: 'annulé canceled annullato' }), false);
    assert.throws(() => freeJobOutcome({}), error => {
      assert.equal(error.presentationRef.key, 'production:work.result.missing');
      assert.notEqual(error.presentationRef.key, 'production:work.media.unknown');
      assert.equal(presentUserMessage(error).message, i18next.t('production:work.result.missing')); return true;
    });
    seen.push([table.running, report.statusLabel, report.progress.lines[0], refusal.title, refusal.message, presentStoredError(state.error), report.gates.entries[0].label, report.gates.entries[0].note, report.gates.entries[0].reasons[0].message]);
    assert.equal(JSON.stringify(state), before);
  }
  for (let n = 0; n < seen[0].length; n++) { assert.notEqual(seen[0][n], seen[1][n]); assert.notEqual(seen[0][n], seen[2][n]); }
  await i18next.changeLanguage('fr');
});

test('Production : surfaces réellement rendues contre BASE, FR/EN/IT/pseudo, attributs et dialogue ouvert', async () => {
  const current = await server(); const original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    for (const [ns, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', ns, values);
    const nowReport = await current.ssrLoadModule('/src/store/production/productionReport.js');
    const oldReport = await original.ssrLoadModule('/src/store/production/productionReport.js');
    const jobs = ['pending', 'running', 'done', 'error', 'canceled'].map(status => job(status, {
      cancelRequested: status === 'running',
      logs: status !== 'pending' ? [{ code: 'GENERATION_QUEUE_START', params: { projectName: '_AUTHOR_NAME_' } }] : [],
      resultPath: status === 'done' ? '/_AUTHOR_RESULT_.zip' : null,
      warnings: status === 'done' ? [{ code: 'COMFYUI_SERVICE_ERROR', params: {}, initialIntegratedLufs: -15, finalIntegratedLufs: -16, gainDb: -1, expectedLimitingDb: 1 }] : [],
    }));
    const scenarios = [
      ['RenderQueuePanel/RenderQueuePanel', 'RenderQueuePanel', { jobs: [] }],
      ['RenderQueuePanel/RenderQueuePanel', 'RenderQueuePanel', { jobs }],
      ...jobs.map(j => ['RenderQueuePanel/RenderQueuePanel', 'JobCard', { job: j, expanded: true }]),
      ['production/AdvancedJobReport', 'AdvancedJobReport', { job: job('done', { result: {} }), onReview() {} }],
      ['common/SaveProgressModal', 'SaveProgressModal', { title: '_AUTHOR_TITLE_', doneTitle: '_AUTHOR_DONE_', data: { complete: false, lines: [{ code: 'GENERATION_QUEUE_START', params: { projectName: '_AUTHOR_NAME_' } }] } }],
      ...jobs.map(j => ['production/ProductionReport', 'ProductionReport', { job: j, onCancel() {} }]),
      ['production/ProductionReport', 'ProductionReport', { job: job('running', { logs: [{ code: 'GENERATION_QUEUE_START', params: { projectName: '_AUTHOR_NAME_' } }], gateObservations: [{ gate: 'readiness', label: { code: 'LABEL_EXPORT_READINESS_VALUE', params: {} }, outcome: 'passed', blocking: false, reasons: [] }] }) }],
    ];
    for (const [file, name, props] of scenarios) {
      const now = (await current.ssrLoadModule(`/src/components/${file}.jsx`))[name]; const old = (await original.ssrLoadModule(`/src/components/${file}.jsx`))[name];
      const render = (component, module) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(component,
        name === 'ProductionReport' ? { ...props, report: module.renderJobReport(props.job) } : props)));
      await engine.changeLanguage('fr'); assert.equal(render(now, nowReport), applyLot413(render(old, oldReport)), `${name}:${props.job?.status ?? ''}`);
      for (const lng of ['en', 'it', 'pseudo']) {
        await engine.changeLanguage(lng); const html = render(now, nowReport);
        assert.doesNotMatch(html, /\[object Object\]|production:[a-z]+\./);
        if (lng === 'pseudo') surface(html);
      }
    }
    const modal = (await current.ssrLoadModule('/src/components/common/SaveProgressModal.jsx')).SaveProgressModal;
    const ref = { key: 'production:save.media.deferred' };
    const props = { title: ref, doneTitle: ref, data: { complete: false, lines: [ref] } }; const before = JSON.stringify(props); const seen = [];
    for (const lng of ['fr', 'en', 'it', 'pseudo']) {
      await engine.changeLanguage(lng);
      const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(modal, props)));
      seen.push(html); if (lng === 'pseudo') surface(html); assert.equal(JSON.stringify(props), before);
    }
    assert.notEqual(seen[0], seen[1]); assert.notEqual(seen[0], seen[2]);
    const work = await current.ssrLoadModule('/src/store/production/advancedProduction.js');
    const originalWork = await original.ssrLoadModule('/src/store/production/advancedProduction.js');
    await engine.changeLanguage('fr');
    for (const count of [0, 1, 2, 1000000]) {
      const summary = { blocked: true, blocking: Array.from({ length: count }, () => ({ levelLabel: '_AUTHOR_LEVEL_', code: '_CODE_', message: '_AUTHOR_DETAIL_' })) };
      assert.equal(work.documentBlockage(summary).message, applyLot413(originalWork.documentBlockage(summary).message));
    }
    assert.equal(work.emptyPackBlockage([]).message, applyLot413(originalWork.emptyPackBlockage([]).message));
    // Le journal porte le diagnostic brut tel que l'exécuteur l'écrit pour une erreur codée.
    const errorReport = nowReport.renderJobReport(job('error', { errorMessage: { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' }, logs: [{ code: 'TOOL_PROCESS_OUTPUT', params: { output: '_RAW_TOOL_' }, detail: '_RAW_TOOL_' }] }));
    const component = (await current.ssrLoadModule('/src/components/production/ProductionReport.jsx')).ProductionReport;
    await engine.changeLanguage('pseudo');
    const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(component, { report: errorReport })));
    // Diagnostic brut visible une seule fois, dans le journal ; aucun volet ajouté au rapport d'origine.
    assert.doesNotMatch(html, /<details/); assert.equal(html.split('_RAW_TOOL_').length - 1, 1); surface(html);
  } finally { await current.close(); await original.close(); }
});

test('Production : refus IPC typés et rejet sans valeur restent des refus dans les trois langues', async () => {
  const current = await server(); const original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const now = await current.ssrLoadModule('/src/store/production/advancedRenderWork.js');
    const old = await original.ssrLoadModule('/src/store/production/advancedRenderWork.js');
    const envelope = { kind: 'output-write', message: { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' }, path: '/_AUTHOR_PARTIAL_' };
    const request = { job: { request: {} }, invokeExport: async () => { throw envelope; } };
    const result = await now.runAdvancedWork(request); const originalResult = await old.runAdvancedWork(request);
    assert.equal(result.refusal.title, applyLot413(originalResult.refusal.title)); assert.equal(result.refusal.message, applyLot413(originalResult.refusal.message));
    const seen = [];
    for (const lng of ['fr', 'en', 'it']) {
      await engine.changeLanguage(lng); seen.push([result.refusal.title, result.refusal.message]);
      assert.equal(result.outcome, 'refused'); assert.equal(result.refusal.kind, 'output-write'); assert.equal(result.refusal.cancelled, false);
      assert.equal(result.refusal.path, '/_AUTHOR_PARTIAL_'); assert.equal(result.refusal.technicalDetail, '_RAW_TOOL_');
      for (const value of [null, undefined]) {
        const empty = await now.runAdvancedWork({ job: { request: {} }, invokeExport: async () => { throw value; } });
        assert.equal(empty.outcome, 'refused'); assert.equal(empty.refusal.kind, 'untyped'); assert.equal(empty.refusal.cancelled, false);
        assert.notEqual(empty.refusal.kind, 'export-cancelled');
      }
      const start = presentUserMessage({ code: 'GENERATION_QUEUE_START', params: { projectName: { key: 'common:status.node.fallback' } } });
      assert.equal(start.code, 'GENERATION_QUEUE_START'); assert.equal(start.fallback, false); assert.ok(start.message.includes(engine.t('common:status.node.fallback')));
    }
    assert.notEqual(seen[0][0], seen[1][0]); assert.notEqual(seen[0][1], seen[2][1]);
  } finally { await current.close(); await original.close(); }
});

test('Production : vrais dialogues de garde génération, refus listés sans JSON et traduction à chaud', async () => {
  const current = await server(); const original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const now = await current.ssrLoadModule('/src/hooks/usePackGeneration.js'); const old = await original.ssrLoadModule('/src/hooks/usePackGeneration.js');
    const { presentTree } = await current.ssrLoadModule('/src/i18n/treePresentation.js');
    const { presentStoredError } = await current.ssrLoadModule('/src/i18n/userMessage.js');
    async function dialog(module, pending) {
      let api, captured;
      function Capture() {
        api = module.usePackGeneration({ store: { project: { projectType: 'simple', projectName: '_AUTHOR_NAME_' } }, renderQueue: {}, pathAudit: {}, pathAuditPending: pending, workspaceDirRef: { current: '' }, importedPackPendingMetaRef: { current: false }, showErrorDialog: value => { captured = value; } });
        return null;
      }
      renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Capture)));
      await api.handleGenerate(null, { skipMetadata: true }); return captured;
    }
    for (const pending of [true, false]) {
      await engine.changeLanguage('fr');
      const currentDialog = await dialog(now, pending), oldDialog = await dialog(old, pending);
      const render = value => renderToStaticMarkup(React.createElement('div', null, React.createElement('h2', null, presentTree(value.title)), React.createElement('p', null, presentStoredError(value.message))));
      assert.equal(render(currentDialog), render(oldDialog));
      const seen = [];
      for (const lng of ['fr', 'en', 'it']) { await engine.changeLanguage(lng); const html = render(currentDialog); seen.push(html); assert.doesNotMatch(html, /\[object Object\]|&quot;messages&quot;|production:[a-z]+\./); }
      assert.notEqual(seen[0], seen[1]); assert.notEqual(seen[0], seen[2]);
      for (const [ns, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', ns, values);
      await engine.changeLanguage('pseudo'); surface(render(currentDialog));
    }
  } finally { await current.close(); await original.close(); }
});
