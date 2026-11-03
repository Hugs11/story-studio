import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCatalogues, checkSource, checkProject, checkPublicLanguageCoverage, sourceHash } from './check-i18n.mjs';

function fixture() {
  const resources = Object.fromEntries(['fr', 'en', 'it'].map((language) => [language, { common: {
    'message.label': '<strong>Bonjour {{name}}</strong>',
    'items.count_one': '{{count}} élément',
    'items.count_other': '{{count}} éléments',
    ...(language !== 'en' ? { 'items.count_many': '{{count}} éléments' } : {}),
  } }]));
  const metadata = { common: Object.fromEntries(Object.entries(resources.fr.common).map(([key, text]) => [key, {
    context: 'Test de contrat',
    ...Object.fromEntries(['en', 'it'].filter((language) => key in resources[language].common).map((language) => [language, { status: 'ai', sourceHash: sourceHash(text) }])),
  }])) };
  return { resources, metadata };
}

test('catalogues valides avec parité des familles plurielles, EN sans many', () => {
  const { resources, metadata } = fixture();
  assert.deepEqual(checkCatalogues(resources, metadata), { errors: [], warnings: [] });
});

for (const [name, mutate, pattern] of [
  ['catalogue imbriqué incompatible avec le runtime', (r) => { r.en.common.message = { label: r.en.common['message.label'] }; delete r.en.common['message.label']; }, /en\/common:message catalogue imbriqué incompatible avec keySeparator:false/],
  ['clé absente', (r) => delete r.en.common['message.label'], /clé absente/],
  ['clé cible orpheline', (r) => r.en.common.extra = 'extra', /sans source/],
  ['valeur vide', (r) => r.it.common['message.label'] = ' ', /valeur vide/],
  ['valeur non textuelle', (r) => r.it.common['message.label'] = 42, /non textuelle/],
  ['paramètre différent', (r) => r.it.common['message.label'] = '<strong>{{other}}</strong>', /paramètres différents/],
  ['balise différente', (r) => r.en.common['message.label'] = '<kbd>Bonjour {{name}}</kbd>', /balises Trans différentes/],
  ['balise positionnelle', (r) => r.en.common['message.label'] = '<0>Bonjour {{name}}</0>', /positionnelle interdite/],
  ['many français absent', (r) => delete r.fr.common['items.count_many'], /pluriel absent/],
  ['many italien absent', (r) => delete r.it.common['items.count_many'], /pluriel absent/],
  ['contexte absent', (_r, m) => delete m.common['message.label'].context, /contexte/],
  ['statut invalide', (_r, m) => m.common['message.label'].en.status = 'done', /métadonnées invalides/],
  ['hash périmé', (_r, m) => m.common['message.label'].en.sourceHash = '000000000000', /stale/],
  ['statut stale', (_r, m) => m.common['message.label'].it.status = 'stale', /stale/],
  ['méta orpheline', (_r, m) => m.common.extra = { context: 'extra' }, /_meta orpheline/],
  ['cible meta orpheline', (_r, m) => m.common['items.count_many'].en = { status: 'ai', sourceHash: '000000000000' }, /_meta cible orpheline/],
  ['longueur invalide', (_r, m) => m.common['message.label'].maxLength = 0, /maxLength invalide/],
]) {
  test(`détection : ${name}`, () => {
    const { resources, metadata } = fixture();
    mutate(resources, metadata);
    assert.match(checkCatalogues(resources, metadata).errors.join('\n'), pattern);
  });
}

test('hash : Unicode NFC et fins de ligne LF', () => {
  assert.equal(sourceHash('é\n'), sourceHash('e\u0301\r\n'));
  assert.match(sourceHash('source'), /^[0-9a-f]{12}$/);
});

test('maxLength avertit en graphèmes sans compter les paramètres', () => {
  const resources = { fr: { common: { label: 'é {{name}}' } }, en: { common: { label: 'e\u0301 {{name}}' } }, it: { common: { label: 'é {{name}}' } } };
  const metadata = { common: { label: { context: 'Longueur', maxLength: 2, en: { sourceHash: sourceHash('é {{name}}'), status: 'ai' }, it: { sourceHash: sourceHash('é {{name}}'), status: 'ai' } } } };
  assert.equal(checkCatalogues(resources, metadata).warnings.length, 0);
  metadata.common.label.maxLength = 1;
  assert.equal(checkCatalogues(resources, metadata).warnings.length, 2);
});

test('scan AST : t, i18next.t, i18nKey, namespace par défaut et pluriels', () => {
  const { resources } = fixture();
  const result = checkSource(`
    // t('common:commentaire.ignore')
    const prose = "t('common:chaine.ignore')";
    t('message.label'); i18next.t('common:items.count', { count: 2 });
    const element = <Trans i18nKey="common:message.label" />;
  `, 'src/Test.jsx', resources);
  assert.deepEqual(result.errors, []);
  assert.ok(result.used.has('common:items.count'));
  assert.match(checkSource("t('common:absent')", 'src/Test.jsx', resources).errors[0], /clé FR absente/);
  assert.match(checkSource('t(key)', 'src/Test.jsx', resources).errors[0], /dynamique non déclarée/);
  assert.match(checkSource('t(`common:other.${type}`)', 'src/Test.jsx', resources).errors[0], /dynamique non déclarée/);
  resources.fr.settings = { label: 'Réglages' };
  assert.deepEqual(checkSource(`t('label', { ns: 'settings' }); const x = <Trans ns="settings" i18nKey="label" />;`, 'src/Test.jsx', resources).errors, []);
  assert.deepEqual(checkSource(`const { t } = useTranslation(['settings', 'common']); t('label');`, 'src/Test.jsx', resources).errors, []);
  assert.match(checkSource('<Trans i18nKey={key} />', 'src/Test.jsx', resources).errors[0], /dynamique non déclarée/);
});

test('famille dynamique déclarée : toutes les valeurs fermées doivent exister', () => {
  const resources = { fr: { tree: Object.fromEntries(['root', 'menu', 'story', 'zip'].map((type) => [`nodeType.${type}`, type])) } };
  assert.deepEqual(checkSource('t(`tree:nodeType.${type}`)', 'src/Test.jsx', resources).errors, []);
  delete resources.fr.tree['nodeType.story'];
  assert.match(checkSource('t(`tree:nodeType.${type}`)', 'src/Test.jsx', resources).errors.join('\n'), /nodeType.story/);
});

test('contrat Rust : clés et paramètres vérifiés dans les trois langues', () => {
  const { resources, metadata } = fixture();
  const messages = [{ code: 'MESSAGE', params: ['name'] }];
  assert.match(checkCatalogues(resources, metadata, messages).errors.join('\n'), /code absent/);
  for (const language of ['fr', 'en', 'it']) resources[language].rust = { MESSAGE: 'Bonjour {{name}}' };
  metadata.rust = { MESSAGE: { context: 'Rust', en: { status: 'ai', sourceHash: sourceHash('Bonjour {{name}}') }, it: { status: 'ai', sourceHash: sourceHash('Bonjour {{name}}') } } };
  assert.deepEqual(checkCatalogues(resources, metadata, messages).errors, []);
  messages[0].params = [];
  assert.match(checkCatalogues(resources, metadata, messages).errors.join('\n'), /contrat différents/);
});

test('catalogues et sources du dépôt cohérents', async () => {
  const result = await checkProject();
  assert.deepEqual(result.errors, []);
});

test('le registre Rust est obligatoire pour le contrôle du dépôt', async () => {
  const { mkdtemp, mkdir, cp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'rust-i18n-contract-'));
  try {
    await mkdir(join(root, 'src'));
    for (const directory of ['fr', 'en', 'it', '_meta']) {
      await cp(`src/locales/${directory}`, join(root, 'src/locales', directory), { recursive: true });
    }
    assert.match((await checkProject(root)).errors.join('\n'), /fichier obligatoire absent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('une clé rust orpheline dans une langue et un code dupliqué sont refusés', () => {
  const { resources, metadata } = fixture();
  for (const language of ['fr', 'en', 'it']) resources[language].rust = { MESSAGE: 'Bonjour {{name}}' };
  metadata.rust = { MESSAGE: { context: 'Rust', en: { status: 'ai', sourceHash: sourceHash('Bonjour {{name}}') }, it: { status: 'ai', sourceHash: sourceHash('Bonjour {{name}}') } } };
  resources.it.rust.ORPHAN = 'Orphan';
  const messages = [{ code: 'MESSAGE', params: ['name'] }];
  assert.match(checkCatalogues(resources, metadata, messages).errors.join('\n'), /rust:ORPHAN code orphelin/);
  assert.match(checkCatalogues(resources, metadata, [...messages, ...messages]).errors.join('\n'), /code dupliqué/);
});

test('les références de libellés imbriquées exigent un code et ses paramètres enregistrés', () => {
  const { resources, metadata } = fixture();
  for (const language of ['fr', 'en', 'it']) resources[language].rust = { MESSAGE: '{{label}}', LABEL: '{{name}}' };
  metadata.rust = Object.fromEntries(Object.entries(resources.fr.rust).map(([code, text]) => [code, { context: 'Libellé de test', en: { status: 'ai', sourceHash: sourceHash(text) }, it: { status: 'ai', sourceHash: sourceHash(text) } }]));
  const registry = [{ code: 'MESSAGE', params: ['label'] }, { code: 'LABEL', params: ['name'], label: true }];
  const message = { code: 'MESSAGE', params: { label: { code: 'LABEL', params: { name: 'Donnée française de l’auteur' } } } };
  assert.deepEqual(checkCatalogues(resources, metadata, registry, [message]).errors, []);
  delete message.params.label.params.name;
  assert.match(checkCatalogues(resources, metadata, registry, [message]).errors.join('\n'), /référence LABEL paramètre name absent/);
  message.params.label.code = 'UNKNOWN_LABEL';
  assert.match(checkCatalogues(resources, metadata, registry, [message]).errors.join('\n'), /référence imbriquée inconnue UNKNOWN_LABEL/);
  registry[1].label = 'yes';
  assert.match(checkCatalogues(resources, metadata, registry).errors.join('\n'), /libellé invalide LABEL/);
  delete resources.it.rust.LABEL;
  assert.match(checkCatalogues(resources, metadata, registry).errors.join('\n'), /it\/rust:LABEL code absent/);
});


for (const namespace of ['common', 'rust']) {
  for (const publicLanguage of [false, true]) {
    test(`couverture ${namespace} : clé ai ${publicLanguage ? 'publique en erreur' : 'non publique en avertissement'}`, () => {
      const resources = Object.fromEntries(['fr', 'en', 'it'].map((language) => [language, { [namespace]: { LABEL: 'Source' } }]));
      const metadata = { [namespace]: { LABEL: { context: 'Coverage',
        en: { status: 'ai-reviewed', sourceHash: sourceHash('Source') },
        it: { status: 'human', sourceHash: sourceHash('Source') },
      } } };
      const publicLanguages = publicLanguage ? ['fr', 'en'] : ['fr'];
      const clean = checkPublicLanguageCoverage(resources, metadata, publicLanguages);
      assert.deepEqual(clean.errors, []);
      assert.deepEqual(clean.warnings, []);
      metadata[namespace].LABEL.en.status = 'ai';
      const mutation = checkPublicLanguageCoverage(resources, metadata, publicLanguages);
      assert.deepEqual(mutation.errors, publicLanguage ? [`en/${namespace}:LABEL couverture publique : ai`] : []);
      assert.deepEqual(mutation.warnings, publicLanguage ? [] : [`en/${namespace}:LABEL couverture publique : ai`]);
      assert.equal(mutation.counts.en.ai, 1);
      assert.equal(mutation.counts.en['ai-reviewed'], 0);
      assert.equal(mutation.counts.it.human, 1);
      const checked = checkCatalogues(resources, metadata, undefined, [], { publicLanguages });
      assert.deepEqual(checked.errors, mutation.errors);
      assert.deepEqual(checked.warnings, mutation.warnings);
    });
  }
}

for (const publicLanguage of [false, true]) {
  for (const status of ['ai-reviewed', 'human', 'stale']) {
    test(`couverture ${publicLanguage ? 'publique' : 'non publique'} : ${status} et empreinte source`, () => {
      const { resources, metadata } = fixture();
      for (const entry of Object.values(metadata.common)) {
        for (const language of ['en', 'it']) if (entry[language]) entry[language].status = 'human';
      }
      metadata.common['message.label'].it.status = status;
      const publicLanguages = publicLanguage ? ['fr', 'it'] : ['fr'];
      if (status !== 'stale') {
        assert.deepEqual(checkCatalogues(resources, metadata, undefined, [], { publicLanguages }), { errors: [], warnings: [] });
        // Mutation du FR seulement : une traduction revue devient périmée.
        resources.fr.common['message.label'] = '<strong>Salut {{name}}</strong>';
      }
      const checked = checkCatalogues(resources, metadata, undefined, [], { publicLanguages });
      const message = 'it/common:message.label couverture publique : stale';
      assert.equal(checked.errors.includes(message), publicLanguage);
      assert.equal(checked.warnings.includes(message), !publicLanguage);
    });
  }
}

test('le contrôle de projet utilise la liste publique injectée et compte tous les statuts', async () => {
  const before = await checkProject();
  const result = await checkProject(undefined, { publicLanguages: ['fr', 'en', 'it'] });
  assert.deepEqual(result.errors, before.warnings.filter((message) => message.includes('couverture publique')));
  assert.equal(result.warnings.some((message) => message.includes('couverture publique')), false);
  assert.deepEqual(result.statusCounts, before.statusCounts);
  for (const language of ['en', 'it']) {
    for (const count of Object.values(result.statusCounts[language])) assert.ok(Number.isInteger(count) && count >= 0);
    assert.ok(Object.values(result.statusCounts[language]).reduce((total, count) => total + count, 0) > 0);
  }
});
