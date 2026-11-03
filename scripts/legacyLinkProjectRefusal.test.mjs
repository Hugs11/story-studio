// L'ancien nœud Lien (`type: 'ref'`) a été retiré du modèle. Un fichier de
// projet qui en contient encore un est refusé à l'ouverture avec un message
// clair, quelle que soit sa profondeur ou la forme de liste qui le porte ;
// un projet sans lien s'ouvre normalement.
import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { createTestI18n } from './i18nTestSetup.mjs';
import { decodeProjectFile, readProjectFilePreview } from '../src/store/projectModel/codec.js';
import { ProjectFormatError, readProjectEnvelope } from '../src/store/projectModel/envelope.js';
import { presentUserMessage } from '../src/i18n/userMessage.js';
import { normalizeProjectData } from '../src/store/projectModel/schema.js';

const initialize = () => i18next.init(createTestI18n().options);
const LINK = { id: 'lien', type: 'ref', target: 'story:a', refKind: 'return', label: 'Revient à A' };
const story = (id) => ({ id, type: 'story', name: `Histoire ${id}` });

function freeProject(rootEntries, extra = {}) {
  return { schemaVersion: 3, projectType: 'pack', projectName: 'Ancien essai', rootEntries, ...extra };
}

async function refusal(project) {
  const error = await decodeProjectFile(JSON.stringify(project), { fileName: 'Ancien.mbah' }).catch((e) => e);
  assert.ok(error instanceof ProjectFormatError, 'un refus de format est attendu');
  return error;
}

test('un lien à la racine est refusé avec un message clair', async () => {
  initialize();
  const error = await refusal(freeProject([story('a'), LINK]));
  assert.equal(error.code, 'LEGACY_LINK_NODE');
  assert.equal(error.path, '/rootEntries/1');
  assert.equal(presentUserMessage(error).message, "Ce projet contient un ancien nœud Lien, qui n'est plus pris en charge.");
  // Le chemin et le code restent dans le détail technique.
  assert.match(presentUserMessage(error).technicalDetail, /\/rootEntries\/1/);
  assert.match(presentUserMessage(error).technicalDetail, /LEGACY_LINK_NODE/);
});

test('un lien imbriqué dans un dossier, partagé ou dans une ancienne forme de liste est refusé', async () => {
  initialize();
  const nested = freeProject([{ id: 'm', type: 'menu', name: 'Dossier', children: [
    story('a'),
    { id: 'm2', type: 'menu', name: 'Sous-dossier', children: [LINK] },
  ] }]);
  assert.equal((await refusal(nested)).path, '/rootEntries/0/children/1/children/0');

  const shared = freeProject([story('a')], { sharedEntries: [LINK] });
  assert.equal((await refusal(shared)).path, '/sharedEntries/0');

  const legacyMenus = { projectType: 'pack', menus: [{ id: 'm', name: 'Dossier', items: [story('a'), LINK] }] };
  assert.equal((await refusal(legacyMenus)).path, '/menus/0/items/1');

  // L'aperçu des listes (reprises, accueil) lit la même porte et rend le même refus.
  assert.throws(() => readProjectFilePreview(JSON.stringify(nested)), (error) => error.code === 'LEGACY_LINK_NODE');
  assert.throws(() => readProjectEnvelope(nested), (error) => error.code === 'LEGACY_LINK_NODE');
  // La normalisation passe par la même porte : un lien n'y devient jamais une histoire.
  assert.throws(() => normalizeProjectData(nested), (error) => error.code === 'LEGACY_LINK_NODE');
});

test('un projet sans lien s’ouvre, et une histoire nommée « ref » n’est pas un lien', async () => {
  initialize();
  const { project } = await decodeProjectFile(JSON.stringify(freeProject([
    { id: 'm', type: 'menu', name: 'Dossier', children: [story('a'), { id: 'ref', type: 'story', name: 'ref' }] },
  ])), { fileName: 'Valide.mbah' });
  assert.equal(project.rootEntries[0].type, 'menu');
  assert.deepEqual(project.rootEntries[0].children.map((entry) => entry.type), ['story', 'story']);
});
