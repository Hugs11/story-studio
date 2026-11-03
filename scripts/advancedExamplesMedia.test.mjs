import { presentStoredError } from '../src/i18n/userMessage.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { exampleMediaPlan, generateExampleMedia } from '../src/store/advancedExamples/media.js';

const example = { stages: [
  { name: 'Je pars retrouver le lapin gris', mediaIntent: { image: true, audio: true } },
  { name: 'Le vent emporte la clochette', mediaIntent: { image: false, audio: true } },
  { name: 'Je montre la carte du jardin', mediaIntent: { image: true, audio: false } },
  { name: 'Je passe au chapitre suivant', mediaIntent: { image: false, audio: false } },
  { name: '', mediaIntent: { image: false, audio: false } },
] };

test('les quatre présences médias restent distinctes, aucun repli sur nom vide ou UUID', () => {
  const plan = exampleMediaPlan(example, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(plan.images.map((target) => target.stageUuid), ['a', 'c']);
  assert.deepEqual(plan.audios.map((target) => target.stageUuid), ['a', 'b']);
  assert.equal(plan.withoutImage, 3);
  assert.equal(plan.withoutAudio, 3);
  assert.throws(() => exampleMediaPlan({ stages: [{ name: '  ', mediaIntent: { audio: true } }] }), /texte/);
});

test('génération respecte le masque, prononce le nom exact et ne touche pas les emplacements sans médias', async () => {
  const images = [];
  const assignments = [];
  const audios = [];
  const result = await generateExampleMedia({
    plan: exampleMediaPlan(example, ['a', 'b', 'c', 'd', 'e']), images: true, audios: true,
    isCurrent: () => true,
    generateImage: async (text) => { images.push(text); return `image-${images.length}`; },
    assignImage: async (uuid, path) => { assignments.push([uuid, path]); return { status: 'applied' }; },
    queueAudio: async (target) => { audios.push(target); },
  });
  assert.deepEqual(images, [example.stages[0].name, example.stages[2].name]);
  assert.deepEqual(assignments.map(([uuid]) => uuid), ['a', 'c']);
  assert.deepEqual(audios.map((target) => [target.stageUuid, target.text]), [['a', example.stages[0].name], ['b', example.stages[1].name]]);
  assert.deepEqual(result, { stale: false, errors: [], imageCount: 2, audioCount: 2 });
});

test('changer de projet pendant la création de l’image empêche toute affectation ou mise en file ultérieure', async () => {
  let current = true;
  let assigned = false;
  let queued = false;
  const result = await generateExampleMedia({
    plan: exampleMediaPlan(example, ['a', 'b', 'c', 'd', 'e']), images: true, audios: true,
    isCurrent: () => current,
    generateImage: async () => { current = false; return 'image'; },
    assignImage: async () => { assigned = true; },
    queueAudio: async () => { queued = true; },
  });
  assert.equal(result.stale, true);
  assert.equal(assigned, false);
  assert.equal(queued, false);
});

test('une erreur image laisse les autres médias se générer et le refus d’affectation est signalé', async () => {
  let count = 0;
  let queued = 0;
  const result = await generateExampleMedia({
    plan: exampleMediaPlan(example, ['a', 'b', 'c', 'd', 'e']), images: true, audios: true,
    isCurrent: () => true,
    generateImage: async () => { if (++count === 1) throw new Error('Disque indisponible'); return 'image'; },
    assignImage: async () => ({ status: 'refused' }),
    queueAudio: async () => { queued++; },
  });
  assert.equal(result.errors.length, 2);
  assert.match(presentStoredError(result.errors[0]), /Disque indisponible/);
  assert.equal(result.imageCount, 0);
  assert.equal(queued, 2);
});

test('créer la structure seule ne produit aucun média', async () => {
  const unexpected = () => { throw new Error('Génération inattendue'); };
  const result = await generateExampleMedia({
    plan: exampleMediaPlan(example), images: false, audios: false,
    isCurrent: () => true, generateImage: unexpected, assignImage: unexpected, queueAudio: unexpected,
  });
  assert.deepEqual(result, { stale: false, errors: [], imageCount: 0, audioCount: 0 });
});

test('une image non affectée est jetée : refus, projet changé ou arrêt pendant la fabrication', async () => {
  const plan = exampleMediaPlan(example, ['a', 'b', 'c', 'd', 'e']);
  // Refus du geste : le fichier écrit n'a plus d'Écran, il est supprimé.
  const discarded = [];
  const refused = await generateExampleMedia({
    plan, images: true, audios: false, isCurrent: () => true,
    generateImage: async (text, target) => `exemple-${target.stageUuid}.png`,
    assignImage: async (uuid) => ({ status: uuid === 'a' ? 'applied' : 'refused' }),
    discardImage: async (path) => { discarded.push(path); },
    queueAudio: async () => {},
  });
  assert.equal(refused.imageCount, 1);
  assert.deepEqual(discarded, ['exemple-c.png'], 'seule l’image refusée est supprimée, une seule fois');

  // Arrêt demandé pendant la fabrication : rien n'est affecté, l'image est jetée,
  // aucun audio n'est mis en file, et un échec du nettoyage ne masque rien.
  let current = true;
  const stopped = [];
  let assigned = 0;
  let queued = 0;
  const result = await generateExampleMedia({
    plan, images: true, audios: true, isCurrent: () => current,
    generateImage: async () => { current = false; return 'exemple-arret.png'; },
    assignImage: async () => { assigned += 1; return { status: 'applied' }; },
    discardImage: async (path) => { stopped.push(path); throw new Error('Fichier verrouillé'); },
    queueAudio: async () => { queued += 1; },
  });
  assert.equal(result.stale, true);
  assert.deepEqual(stopped, ['exemple-arret.png']);
  assert.equal(assigned, 0);
  assert.equal(queued, 0);
});

test('une image affectée juste avant l’arrêt est conservée et la boucle s’interrompt', async () => {
  let current = true;
  const discarded = [];
  const generated = [];
  const result = await generateExampleMedia({
    plan: exampleMediaPlan(example, ['a', 'b', 'c', 'd', 'e']), images: true, audios: true,
    isCurrent: () => current,
    generateImage: async (text) => { generated.push(text); return `image-${generated.length}`; },
    assignImage: async () => { current = false; return { status: 'applied' }; },
    discardImage: async (path) => { discarded.push(path); },
    queueAudio: async () => { throw new Error('Aucun audio après l’arrêt'); },
  });
  assert.deepEqual(result, { stale: true, errors: [], imageCount: 1, audioCount: 0 });
  assert.equal(generated.length, 1);
  assert.deepEqual(discarded, []);
});
