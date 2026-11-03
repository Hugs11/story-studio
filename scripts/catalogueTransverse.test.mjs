import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18next from 'i18next';
import { durationCell, NOT_PROVIDED, detailsRow, exemplarRow } from '../src/store/catalogue/detailsRow.js';
import { matchCard, searchWords } from '../src/store/catalogue/search.js';
import { sortEntries } from '../src/store/catalogue/sort.js';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { descriptionText, decodeHtmlEntities } from '../src/store/catalogue/descriptionText.js';

test('missing catalogue values share the same dash in every locale', async () => {
  for (const language of ['fr', 'en', 'it']) {
    const resource = JSON.parse(readFileSync(new URL(`../src/locales/${language}/catalogue.json`, import.meta.url)));
    assert.equal(resource[NOT_PROVIDED.key.split(':')[1]], '—');
    for (const value of Object.values(detailsRow({})).filter(value => value?.kind === 'missing')) assert.equal(value, NOT_PROVIDED);
    assert.equal(exemplarRow({}).name, NOT_PROVIDED);
  }
});

test('duration rounding and hours in FR/EN/IT, including selection totals', async () => {
  for (const lng of ['fr', 'en', 'it']) {
    const instance = i18next.createInstance();
    await instance.init({ lng, resources: { [lng]: { catalogue: JSON.parse(readFileSync(new URL(`../src/locales/${lng}/catalogue.json`, import.meta.url))) } } });
    for (const [seconds, expected] of [[59*60, '59 min'], [59*60+30, '1 h'], [3600, '1 h'], [6000, '1 h 40'], [7200, '2 h'], [3900, '1 h 05']]) {
      const cell = durationCell(seconds);
      assert.equal(instance.t(cell.key, cell.params), expected);
    }
    assert.equal(durationCell(null), NOT_PROVIDED);
    assert.deepEqual(durationCell(3000 + 3000), durationCell(6000));
  }
});

test('common normalized title removes only identical halves', () => {
  for (const title of ['Aladin - Aladin', ' Aladin  -  aladin ']) assert.equal(normalizeEntry({ values: { title } }).displayTitle, 'Aladin');
  assert.equal(normalizeEntry({ values: { title: 'Aladin - Voyage' } }).displayTitle, 'Aladin - Voyage');
  assert.equal(normalizeEntry({ displayTitle: 'Aladin - aladin' }).displayTitle, 'Aladin');
  const card = normalizeEntry({ id: 'a', values: { title: 'Aladin - Aladin' }, subtitle: 'Aladin' });
  assert.deepEqual(matchCard(card, searchWords('aladin')), []);
  assert.equal(matchCard(card, searchWords('-')), null);
  const other = normalizeEntry({ id: 'b', values: { title: 'Aladin' } });
  assert.deepEqual(sortEntries([{ card: other }, { card }]).map(entry => entry.card.id), ['a', 'b']);
});

test('mixed named and numeric entities, markup and invalid entities', () => {
  const source = 'A&nbsp;&amp; &#39;&eacute; &#x1F600;<br><b>B</b> &unknown;';
  const expected = "A\u00a0& 'é 😀\nB &unknown;";
  assert.equal(descriptionText(source), expected);
  assert.equal(detailsRow({ description: source }).summary.value, expected);
  assert.equal(decodeHtmlEntities('&#0; &#xD800; &#x110000; &amp;nbsp;'), '&#0; &#xD800; &#x110000; &nbsp;');
});
