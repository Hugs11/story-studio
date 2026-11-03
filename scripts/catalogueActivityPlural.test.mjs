import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import i18next from 'i18next';

test('catalogue activity announcements use CLDR plurals in all public languages', async () => {
  const expected = {
    fr: ['Activité du catalogue (0 élément)', 'Activité du catalogue (1 élément)', 'Activité du catalogue (2 éléments)'],
    en: ['Catalogue activity (0 items)', 'Catalogue activity (1 item)', 'Catalogue activity (2 items)'],
    it: ['Attività del catalogo (0 elementi)', 'Attività del catalogo (1 elemento)', 'Attività del catalogo (2 elementi)'],
  };
  for (const language of Object.keys(expected)) {
    const catalogue = JSON.parse(await readFile(new URL(`../src/locales/${language}/catalogue.json`, import.meta.url), 'utf8'));
    const instance = i18next.createInstance();
    await instance.init({ lng: language, resources: { [language]: { catalogue } } });
    for (const count of [0, 1, 2]) assert.equal(instance.t('catalogue:header.activity', { count }), expected[language][count]);
    assert.equal(Object.hasOwn(catalogue, 'header.activity_zero'), false);
  }
  const component = await readFile(new URL('../src/components/Catalogue/activity/CatalogueActivity.jsx', import.meta.url), 'utf8');
  assert.match(component, /t\('catalogue:header.activity', \{ count: items.length \}\)/);
});
