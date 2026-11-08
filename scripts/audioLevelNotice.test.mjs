import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { installMountedDom } from './treeMountedDom.mjs';
import { audioLevelMark, audioLevelMessage, createAudioLevelWatcher, generationLevelLabel } from '../src/store/audioLevelNotice.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('silence : mesure JSON vers texte dédié dans les trois langues, avec ou sans harmonisation', async () => {
  const catalogues = Object.fromEntries(await Promise.all(['fr', 'en', 'it'].map(async (language) => [
    language, JSON.parse(await readFile(new URL(`../src/locales/${language}/tree.json`, import.meta.url), 'utf8')),
  ])));
  for (const [silent, integratedLufs, truePeakDb, expected] of [
    [true, -70, null, 'silent'], // Silence numérique.
    [true, -80, -77, 'silent'], // Indicateur silent de Rust : la pastille le suit, quels que soient les niveaux reçus.
    [false, null, -47, 'AUDIO_NEAR_MUTE_BOOST'],
    [true, null, null, 'silent'],
    [false, null, null, 'AUDIO_NEAR_MUTE_BOOST'],
    [false, -70, null, 'AUDIO_NEAR_MUTE_BOOST'],
    [false, -50, -47, 'AUDIO_NEAR_MUTE_BOOST'],
  ]) {
    let verdict;
    const watcher = createAudioLevelWatcher({
      measure: async () => ({ silent, notice: silent ? null : 'AUDIO_NEAR_MUTE_BOOST', integratedLufs, truePeakDb }),
      onVerdict: (value) => { verdict = value; },
    });
    watcher.start('/sound.wav'); await tick();
    assert.equal(verdict, expected);
    for (const harmonize of [true, false]) {
      const mark = audioLevelMark(verdict, harmonize);
      assert.equal(mark.code, expected);
      for (const catalogue of Object.values(catalogues)) {
        const key = expected === 'silent' ? 'audio.level.silent'
          : harmonize ? 'audio.level.nearMuteBoost' : 'audio.level.nearMuteNoHarmonize';
        const t = (key, { label }) => catalogue[key.replace('tree:', '')].replace('{{label}}', label);
        const message = audioLevelMessage(mark, 'Titre', t);
        assert.equal(message, catalogue[key].replace('{{label}}', 'Titre'));
        if (expected === 'silent') {
          assert.match(message, /ne jouera rien|will play nothing|non riprodurrà nulla/);
          assert.doesNotMatch(message, /amplifiera|amplify|amplificherà/);
        }
      }
    }
    watcher.stop();
  }
});

test('le repère suit l option d harmonisation sans remesurer', () => {
  assert.deepEqual(audioLevelMark('AUDIO_STRONG_LIMITING', true), { code: 'AUDIO_STRONG_LIMITING', harmonizeOff: false });
  assert.equal(audioLevelMark('AUDIO_STRONG_LIMITING', false), null);
  assert.deepEqual(audioLevelMark('AUDIO_NEAR_MUTE_BOOST', true), { code: 'AUDIO_NEAR_MUTE_BOOST', harmonizeOff: false });
  assert.deepEqual(audioLevelMark('AUDIO_NEAR_MUTE_BOOST', false), { code: 'AUDIO_NEAR_MUTE_BOOST', harmonizeOff: true });
  assert.equal(audioLevelMark(null, true), null);
});

test('observateur : ancien verdict retiré, demande précédente annulée, erreur et null sans verdict', async () => {
  const verdicts = []; const signals = []; const resolvers = [];
  const watcher = createAudioLevelWatcher({
    measure: (path, { signal }) => { signals.push(signal); return new Promise((resolve, reject) => resolvers.push({ resolve, reject, path })); },
    onVerdict: (value) => verdicts.push(value),
  });
  watcher.start('/a.wav'); await tick();
  watcher.start('/b.wav'); await tick();
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(verdicts, [null, null]);
  resolvers[0].resolve({ notice: 'AUDIO_STRONG_LIMITING' }); await tick();
  assert.deepEqual(verdicts, [null, null], 'résultat périmé ignoré');
  resolvers[1].resolve({ notice: 'AUDIO_NEAR_MUTE_BOOST' }); await tick();
  assert.equal(verdicts.at(-1), 'AUDIO_NEAR_MUTE_BOOST');
  watcher.start('/c.wav'); await tick();
  resolvers[2].resolve(null); await tick();
  assert.equal(verdicts.at(-1), null);
  watcher.start('/d.wav'); await tick();
  resolvers[3].reject(new Error('boom')); await tick();
  assert.equal(verdicts.at(-1), null);
});

test('hook monté : inerte sans fichier, mesure, changement de fichier, retouche, préférence', async () => {
  const dom = installMountedDom();
  const listeners = new Map();
  dom.document.defaultView.addEventListener = (type, cb) => listeners.set(type, cb);
  dom.document.defaultView.removeEventListener = (type) => listeners.delete(type);
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { useAudioLevelNotice } = await server.ssrLoadModule('/src/hooks/useAudioLevelNotice.js');
    const settings = await server.ssrLoadModule('/src/store/audioLevelAlertSettings.js');
    const calls = []; const pending = [];
    const measure = (path, { signal }) => { calls.push({ path, signal }); return new Promise((resolve) => pending.push(resolve)); };
    let seen; const target = { current: null };
    function Probe({ file }) { seen = useAudioLevelNotice(file, target, { measure, runtime: () => true }); return null; }
    const render = (file) => act(async () => { root.render(React.createElement(Probe, { file })); await tick(); });
    await render(null);
    assert.equal(calls.length, 0); assert.equal(seen, null);
    await render('/a.wav');
    assert.equal(calls.length, 1);
    await act(async () => { pending[0]({ notice: 'AUDIO_STRONG_LIMITING' }); await tick(); });
    assert.equal(seen, 'AUDIO_STRONG_LIMITING');
    await render('/b.wav');
    assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, true);
    assert.equal(seen, null, 'ancien verdict retiré');
    await act(async () => { pending[1]({ notice: 'AUDIO_NEAR_MUTE_BOOST' }); await tick(); });
    assert.equal(seen, 'AUDIO_NEAR_MUTE_BOOST');
    await act(async () => { listeners.get('local-file-changed')({ detail: { path: '/b.wav' } }); await tick(); });
    assert.equal(calls.length, 3); assert.equal(seen, null, 'retouche en place : verdict retiré');
    await act(async () => { pending[2](null); await tick(); });
    assert.equal(seen, null);
    // C3 : retouche externe = nouvelle empreinte du contenu (URL locale) ; `null` = on attend.
    let versioned; let version = null;
    function VersionProbe({ file }) { versioned = useAudioLevelNotice(file, target, { measure, runtime: () => true, version }); return null; }
    const renderVersion = (file) => act(async () => { root.render(React.createElement(VersionProbe, { file })); await tick(); });
    const before = calls.length;
    await renderVersion('/v.wav');
    assert.equal(calls.length, before, 'empreinte pas encore connue : pas de mesure');
    version = 'blob:1'; await renderVersion('/v.wav');
    assert.equal(calls.length, before + 1);
    await act(async () => { pending.at(-1)({ notice: 'AUDIO_NEAR_MUTE_BOOST' }); await tick(); });
    assert.equal(versioned, 'AUDIO_NEAR_MUTE_BOOST');
    version = 'blob:2'; await renderVersion('/v.wav');
    assert.equal(calls.length, before + 2, 'retouche externe : remesure'); assert.equal(versioned, null);
    await act(async () => { pending.at(-1)(null); await tick(); });
    await renderVersion(null);
    const total = calls.length;
    await act(async () => { settings.writeAudioLevelAlerts(false); await tick(); });
    assert.equal(calls.length, total);
    settings.writeAudioLevelAlerts(true); await render(null);
    await act(async () => { await render('/a2.wav'); });
    await act(async () => { pending.at(-1)({ silent: true, notice: null, integratedLufs: -70, truePeakDb: null }); await tick(); });
    assert.equal(seen, 'silent');
    await act(async () => { settings.writeAudioLevelAlerts(false); await tick(); });
    assert.equal(seen, null, 'préférence désactivée : le silence ne laisse aucune pastille');
    const off = calls.length;
    await render('/c.wav');
    assert.equal(calls.length, off, 'préférence désactivée : aucune mesure');
  } finally {
    await act(async () => root.unmount());
    await server.close(); dom.restore();
  }
});

test('rendu de la pastille : textes éditeur au futur, texte adapté sans harmonisation, pas de title natif', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { I18nextProvider } = await import('react-i18next');
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const engine = initializeI18n('fr');
    const { AudioLevelMark } = await server.ssrLoadModule('/src/components/editors/AudioLevelMark.jsx');
    const html = (mark) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(AudioLevelMark, { mark, label: 'Titre' }))).replaceAll('&#x27;', "'");
    const limiting = html({ code: 'AUDIO_STRONG_LIMITING', harmonizeOff: false });
    assert.match(limiting, /audio-level-mark/);
    assert.ok(limiting.includes(engine.t('tree:audio.level.strongLimiting', { label: 'Titre' })));
    assert.ok(limiting.includes('Story Studio réduira fortement les pointes'));
    assert.ok(!limiting.includes(engine.t('rust:AUDIO_STRONG_LIMITING', { label: 'Titre' })));
    assert.ok(limiting.includes(engine.t('tree:audio.level.current')));
    assert.doesNotMatch(limiting, / title=/);
    const nearMute = html({ code: 'AUDIO_NEAR_MUTE_BOOST', harmonizeOff: false });
    assert.ok(nearMute.includes(engine.t('tree:audio.level.nearMuteBoost', { label: 'Titre' })));
    assert.ok(nearMute.includes("Story Studio l'amplifiera fortement"));
    assert.ok(nearMute.includes(engine.t('tree:audio.level.current')));
    assert.ok(!nearMute.includes(engine.t('rust:AUDIO_NEAR_MUTE_BOOST', { label: 'Titre' })));
    const adapted = html({ code: 'AUDIO_NEAR_MUTE_BOOST', harmonizeOff: true });
    assert.ok(adapted.includes(engine.t('tree:audio.level.nearMuteNoHarmonize', { label: 'Titre' })));
    assert.ok(adapted.includes(engine.t('tree:audio.level.current')));
    for (const harmonize of [true, false]) {
      const silent = html(audioLevelMark('silent', harmonize));
      assert.ok(silent.includes("L'audio « Titre » est silencieux : la Lunii ne jouera rien à cet endroit."));
      assert.ok(silent.includes(engine.t('tree:audio.level.current')));
      assert.doesNotMatch(silent, /amplifiera|inaudible/);
    }
    assert.equal(html(null), '');
  } finally { await server.close(); }
});

test('B2 : le libellé du repère est celui que le rapport de génération donne à l emplacement', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const { presentUserMessage } = await server.ssrLoadModule('/src/i18n/userMessage.js');
    const cases = JSON.parse(await readFile(new URL('./fixtures/audio-level-labels.json', import.meta.url), 'utf8'));
    for (const language of ['fr', 'en', 'it']) {
      const engine = initializeI18n(language);
      for (const { source, expected } of cases) {
        const label = generationLevelLabel(source, engine.t.bind(engine), 'repli');
        assert.equal(label, expected[language], JSON.stringify({ source, language }));
        const silentReport = presentUserMessage({ code: 'AUDIO_SILENT_KEPT', params: { label } }, { t: engine.t.bind(engine), language }).message;
        assert.equal(audioLevelMessage({ code: 'silent' }, label, engine.t.bind(engine)), silentReport);
        for (const code of ['AUDIO_STRONG_LIMITING', 'AUDIO_NEAR_MUTE_BOOST']) {
          const report = presentUserMessage({ code, params: { label: expected[language] } }, { t: engine.t.bind(engine), language }).message;
          const mark = audioLevelMessage({ code, harmonizeOff: false }, label, engine.t.bind(engine));
          assert.ok(mark.includes(label), 'même libellé dans le texte prospectif');
          assert.ok(report.includes(label), 'même libellé dans le rapport');
          assert.notEqual(mark, report, 'la pastille annonce la génération, le rapport la décrit au passé');
        }
      }
    }
    const engine = initializeI18n('fr');
    assert.equal(generationLevelLabel(null, engine.t.bind(engine), 'repli'), 'repli');
  } finally { await server.close(); }
});
