import assert from 'node:assert/strict';
import { originalEditingSegments } from './i18nGraphEditingSourceFixture.mjs';
import { GRAPH_NEUTRAL_KEYS } from './check-i18n.mjs';
import { collapseSegments } from './selectMigrationGraphLists.mjs';

function decode(value) {
  return value.replace(/&#x([a-f0-9]+);|&#([0-9]+);|&(amp|quot|apos|lt|gt|nbsp);/gi, (_, hex, number, entity) => hex ? String.fromCodePoint(parseInt(hex, 16)) : number ? String.fromCodePoint(Number(number)) : ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[entity.toLowerCase()]);
}
const schemaProof = "<projet> — /authoring/payload : trouvé absent, attendu un projet avancé porteur d'un payload d'auteur (ADVANCED_CODEC_REQUIRED)";
const clean = value => decode(value).replace(/\s+/g, ' ').trim();
export function surfaceSegments(html) {
  return {
    text: [...html.matchAll(/>([^<]+)</g)].map(match => clean(match[1])).filter(Boolean),
    attributes: [...html.matchAll(/\b(title|aria-label|alt|placeholder)="([^"]*)"/g)].map(match => [match[1], clean(match[2])]),
  };
}
// Valeurs bornées des fixtures, pas un filtre linguistique : noms/IDs auteur, codes, couleurs,
// raccourci effectif et ponctuation technique. Aucun mot de prose française n’est exempté.
const technical = new Set(['+', '−', '×', '▶', '⏸', '■', '?', '—', '·', '.', ',', '/', 'OK', 'Ctrl+Z', 'Ctrl + Z', 'entry', 'choix', 'cible', 'okTransition', 'homeTransition', 'ENTRY_STAGE_AS_OPTION', 'no-stage', 'unsupported-kind', 'no-path', 'ADVANCED_CODEC_REQUIRED', '_UNKNOWN_', 'RAW_DETAIL_TRACE', '_PATH_', 'TTS', 'XTTS', 'Piper', '/authoring/payload']);
function isData(value) {
  return technical.has(value) || /^_AUTHOR_[A-Z0-9_]*$/.test(value) || /^\d+(?:[ /,]+\d+)*$/.test(value) || /^#[a-f0-9]{6}$/i.test(value) || /^\d+\/\d+ · _AUTHOR_[A-Z0-9_]*$/.test(value);
}
export function assertTranslatedSurface(harness, name, expected = collapseSegments('editing', name, originalEditingSegments[name])) {
  const { html, translations } = harness.renderDetailed(name);
  const language = harness.engine.resolvedLanguage;
  const allowed = new Set();
  for (const { key, options, value } of translations) {
    if (typeof value !== 'string') continue;
    const fullKey = typeof key === 'string' && key.includes(':') ? key : `${options?.ns ?? 'common'}:${key}`;
    if (['en', 'it'].includes(language) && fullKey.startsWith('graph:')) {
      const french = harness.engine.t(key, { ...options, lng: 'fr' });
      if (!GRAPH_NEUTRAL_KEYS.has(fullKey.slice(6))) assert.notEqual(value, french, `${language}:${name}:${fullKey} fuite FR du catalogue`);
    }
    allowed.add(clean(value));
    for (const piece of value.split(/<[^>]*>/)) if (clean(piece)) allowed.add(clean(piece));
  }
  const segments = surfaceSegments(html);
  const rawDetails = new Set([...html.matchAll(/<pre[^>]*>([^]*?)<\/pre>/g)].map(match => clean(match[1])));
  assert.ok(segments.text.length + segments.attributes.length > 0, `${name}: surface vide`);
  // Le wrapper pseudo crée un nœud de fermeture après une balise Trans ; sa prose
  // reste contrôlée ci-dessous. Seuls ces marqueurs produits par pseudoText sont ignorés au comptage.
  const prose = language === 'pseudo' ? segments.text.filter(text => !/^[~[\]]+$/.test(text)) : segments.text;
  assert.equal(prose.length, expected.text.length, `${language}:${name}: segment supprimé ou ajouté`);
  assert.deepEqual(segments.attributes.map(([attribute]) => attribute), expected.attributes.map(([attribute]) => attribute), `${language}:${name}: attribut accessible supprimé ou ajouté`);
  for (const text of segments.text) {
    assert.doesNotMatch(text, /graph:|\[object Object\]/, `${name}: texte brut`);
    const choice = text.match(/^\d+\/\d+ · (.+)$/);
    assert.ok(allowed.has(text) || isData(text) || (name === 'RefusalPayload' && text === schemaProof && rawDetails.has(text) && prose.indexOf(text) === expected.text.indexOf(text)) || choice && (allowed.has(choice[1]) || isData(choice[1])), `${language}:${name}: segment hors catalogue ${JSON.stringify(text)}`);
  }
  for (const [attribute, value] of segments.attributes) {
    assert.doesNotMatch(value, /graph:|\[object Object\]/, `${name}:${attribute}`);
    assert.ok(!value || allowed.has(value) || isData(value), `${language}:${name}:${attribute} hors catalogue ${JSON.stringify(value)}`);
  }
  return segments;
}
