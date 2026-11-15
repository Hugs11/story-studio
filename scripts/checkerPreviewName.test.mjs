import test from 'node:test';
import assert from 'node:assert/strict';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';

import { generateConventionName } from '../src/utils/packConvention.js';
import { formatHtmlReport } from '../src/components/CommunityPackChecker/communityPackExports.js';

test('checker keeps distinct structural errors on screen and reads the default leading age', async () => {
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'checker-internals',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/CommunityPackChecker.jsx')) return `${code}\nexport { buildProblemGroups };`;
        if (id.endsWith('/CommunityPackMetadataModal.jsx')) return `${code}\nexport { defaultDraft };`;
      },
    }, react()],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  try {
    const { buildProblemGroups } = await server.ssrLoadModule('/src/components/CommunityPackChecker/CommunityPackChecker.jsx');
    const { defaultDraft } = await server.ssrLoadModule('/src/components/CommunityPackChecker/CommunityPackMetadataModal.jsx');
    const messages = ['Destination AAAA-1111 introuvable.', 'Destination BBBB-2222 introuvable.'];
    const groups = buildProblemGroups({ issues: messages.map((message) => ({
      severity: 'error', category: 'structure', label: 'Structure du pack', message,
    })) });
    assert.deepEqual(groups.flatMap((group) => group.records.map((record) => record.issue.message)), messages);
    assert.equal(defaultDraft({ packTitle: '5+ Le prince' }).minAge, '5');
    assert.equal(defaultDraft({ packName: '6+]Le_prince[by_Auteur' }).minAge, '6');
    assert.equal(defaultDraft({ packTitle: 'Le prince' }).minAge, '');
  } finally {
    await server.close();
  }
});

// Aperçu du nom dans la fenêtre des métadonnées (champs tels que
// `normalizeDraft` les envoie). Ces deux valeurs sont l'oracle des tests Rust
// `fixed_zip_stem_matches_the_preview_*`.
test('preview name: title with a leading age', () => {
  assert.equal(
    generateConventionName({ title: '5+ Le prince', author: 'Auteur', producer: '', bonus: '', minAge: '3', version: 2, namingMode: 'convention' }),
    '3+]Le_prince[by_Auteur_V2',
  );
});

test('preview name: producer with an apostrophe', () => {
  assert.equal(
    generateConventionName({ title: 'Le loup', author: 'Auteur', producer: "L'école des loisirs", bonus: '', minAge: '3', version: 2, namingMode: 'convention' }),
    "3+]L'école_des_loisirs_-_Le_loup[by_Auteur_V2",
  );
});

// Deux erreurs de structure distinctes, sans fichier, même libellé
// (« Structure du pack ») : les deux doivent figurer dans le rapport.
test('html report lists every structural error, not only the first', () => {
  const structureIssue = (message) => ({
    severity: 'error',
    category: 'structure',
    label: 'Structure du pack',
    message,
    fixDisposition: 'none',
    autoFixAvailable: false,
  });
  const html = formatHtmlReport({
    packName: 'Pack.zip',
    verdict: 'needsFix',
    summary: { errors: 2, warnings: 0, infos: 0, ok: 0 },
    correctionsAvailable: 0,
    optionalCorrectionsAvailable: 0,
    audioSummary: { ok: 0, total: 0 },
    imageSummary: { ok: 0, total: 0 },
    titleSummary: { ok: 1, total: 1 },
    structureSummary: { luniiCompatible: false, storyStudioEditable: true },
    nightMode: { detected: false },
    issues: [
      structureIssue('Une destination de navigation est introuvable : AAAA-1111.'),
      structureIssue('Une destination de navigation est introuvable : BBBB-2222.'),
    ],
    audioItems: [],
    imageItems: [],
    technicalLog: [],
  });
  assert.ok(html.includes('AAAA-1111'), 'first structural error is listed');
  assert.ok(html.includes('BBBB-2222'), 'second structural error is listed');
});
