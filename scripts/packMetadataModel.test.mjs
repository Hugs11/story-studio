// Les métadonnées communes aux deux éditeurs.
//
// Ce que ces tests tiennent est une règle : un identifiant affiché ou modifié
// dans la fiche ne doit pas diverger de l'identité utilisée par la production.
// Avec deux corollaires — ce que la production réécrit n'est pas offert à
// l'édition, et ce qu'une structure ne porte pas n'est jamais affiché avec un
// repli.
//
// Tout est pur : aucun React, aucun Tauri, aucun accès au payload.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advancedCoverImage,
  advancedEntryImageRef,
  advancedFieldGovernance,
  advancedMetadataGesture,
  advancedMetadataMembers,
  advancedPackMetadataCounters,
  advancedPackMetadataDraft,
  advancedPackRecap,
  advancedProducedIdentity,
  freePackRecap,
  suggestedPackTitle,
  METADATA_SAVE_CLOSED,
  METADATA_SAVE_KEPT,
  metadataSaveDecision,
  NAMING_ONLY_FIELDS,
  SHARED_METADATA_FIELDS,
} from '../src/store/packMetadataModel.js';

const value = (v) => ({ presence: 'value', value: v });
const absent = { presence: 'absent', value: null };
const nulled = { presence: 'null', value: null };

test('le titre proposé reprend la racine puis le projet sans écraser un titre renseigné', () => {
  for (const projectType of ['pack', 'simple']) {
    assert.equal(suggestedPackTitle({ projectType, rootName: 'La forêt', projectName: 'Mon histoire', packMetadata: { title: 'Nouveau pack' } }), projectType === 'pack' ? 'La forêt' : 'Mon histoire');
    assert.equal(suggestedPackTitle({ projectType, rootName: 'La forêt', packMetadata: { title: 'Titre choisi' } }), 'Titre choisi');
  }
  const project = { authoringMode: 'advanced', projectName: 'Projet enregistré' };
  const view = { metadata: { title: value('Nouveau pack') }, entryTitle: 'La forêt' };
  assert.equal(advancedPackMetadataDraft(view, project).title, 'La forêt');
  assert.equal(advancedPackMetadataDraft({ ...view, entryTitle: '' }, project).title, 'Projet enregistré');
  assert.equal(advancedPackMetadataDraft({ ...view, metadata: { title: value('Titre importé') } }, project).title, 'Titre importé');
  assert.equal(suggestedPackTitle({ projectType: 'pack', rootName: 'Menu racine', projectName: 'Nouveau pack' }), '');
});

// Un pack repris : la production laisse sa version et sa racine `uuid`.
const imported = {
  documentOrigin: 'imported-studio',
  packIdentity: { origin: 'square-one-stage', value: '22222222-3333-4444-8555-666677778888' },
  metadata: {
    title: value('Le renard'),
    version: value(2),
    description: absent,
    uuid: value('11111111-2222-4333-8444-555566667777'),
  },
  counts: { stages: 12, actions: 5, options: 9, edges: 21 },
};

// Un document créé dans l'éditeur graphe : la production lui impose la version 1
// et écrit son identité de pack comme racine `uuid`.
const created = {
  documentOrigin: 'created',
  packIdentity: { origin: 'generated', value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000' },
  metadata: {
    title: value('Brouillon'),
    version: absent,
    description: absent,
    uuid: absent,
  },
  counts: { stages: 1, actions: 0, options: 0, edges: 0 },
};

// ── L'inventaire, en deux colonnes ──────────────────────────────────────────

test('la fiche distingue ce que les deux structures portent de ce qui nomme le fichier', () => {
  // Colonne commune : ces quatre champs existent des deux côtés et entrent dans
  // le pack produit.
  assert.deepEqual(SHARED_METADATA_FIELDS, ['title', 'version', 'description', 'uuid']);
  // Colonne propre au Libre : ces quatre-là ne composent que le nom du fichier
  // exporté. Le document de graphe ne les porte pas, et la fiche ne les invente
  // pas de son côté.
  assert.deepEqual(NAMING_ONLY_FIELDS, ['author', 'minAge', 'producer', 'bonus']);
  for (const field of NAMING_ONLY_FIELDS) {
    assert.equal(SHARED_METADATA_FIELDS.includes(field), false, field);
    // Aucun de ces champs ne peut partir dans un geste : Rust les refuserait à
    // la frontière, et le modèle ne les nomme jamais. Le brouillon part complet,
    // comme la fiche l'envoie — un brouillon partiel dirait « vidé » pour les
    // champs qu'il omet, ce qui est une autre demande.
    const members = advancedMetadataMembers(imported, {
      ...advancedPackMetadataDraft(imported),
      [field]: 'valeur',
    });
    assert.equal(members, null, field);
  }
});

// ── L'identité : une seule, celle que la production écrit ────────────────────

test('l’identifiant affiché est celui que la production écrira, et pas un autre', () => {
  // Document créé : la production écrit la `packIdentity`. Afficher la racine
  // `uuid` — absente ici — laisserait croire que le pack n'a pas d'identité.
  assert.equal(advancedProducedIdentity(created), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000');
  assert.equal(advancedPackMetadataDraft(created).uuid, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000');

  // Sur un import, la racine documentaire peut différer de l'identité du pack.
  assert.equal(advancedProducedIdentity(imported), imported.packIdentity.value);
  assert.equal(advancedPackMetadataDraft(imported).uuid, '22222222-3333-4444-8555-666677778888');
});

test('les champs communs sont éditables dans les deux origines', () => {
  const onCreated = advancedFieldGovernance('created');
  assert.equal(onCreated.title.editable, true);
  assert.equal(onCreated.description.editable, true);
  // L'identité acquise reste stable tant que l'auteur ne la change pas.
  assert.equal(onCreated.uuid.editable, true);
  assert.equal(onCreated.uuid.reason, null);
  // La version n'est pas dans cette liste : la production retient
  // celle de l'auteur et n'écrit `1` que s'il n'en a posé aucune.
  assert.equal(onCreated.version.editable, true);
  assert.equal(onCreated.version.reason, null);

  const onImported = advancedFieldGovernance('imported-studio');
  for (const field of ['title', 'description', 'version', 'uuid']) {
    assert.equal(onImported[field].editable, true, field);
    assert.equal(onImported[field].reason, null, field);
  }
});

test('un nouvel UUID modifie dans le même geste l’identité livrée et la racine du document', () => {
  const members = advancedMetadataMembers(created, {
    title: 'Brouillon revu',
    version: '7',
    uuid: 'ffffffff-0000-4000-8000-000000000000',
  });
  assert.deepEqual(members, {
    title: { form: 'set', value: 'Brouillon revu' },
    version: { form: 'set', value: 7 },
    packIdentity: 'ffffffff-0000-4000-8000-000000000000',
    uuid: { form: 'set', value: 'ffffffff-0000-4000-8000-000000000000' },
  });
});

// ── Seuls les champs réellement changés partent ──────────────────────────────

test('un champ inchangé ne produit pas de geste, et rien ne produit rien', () => {
  const unchanged = advancedMetadataMembers(imported, advancedPackMetadataDraft(imported));
  assert.equal(unchanged, null);
  assert.equal(advancedMetadataGesture(imported, advancedPackMetadataDraft(imported)), null);
});

test('une identité vidée est transmise au moteur pour refus explicite', () => {
  const members = advancedMetadataMembers(imported, {
    ...advancedPackMetadataDraft(imported),
    uuid: '   ',
  });
  assert.deepEqual(members, { packIdentity: '' });
});

test('le geste complet porte le nom que Rust accepte et les seuls champs visés', () => {
  const gesture = advancedMetadataGesture(imported, {
    ...advancedPackMetadataDraft(imported),
    title: 'Le renard et la grue',
    description: 'Deuxième révision.',
  });
  assert.deepEqual(gesture, {
    gesture: 'set-document-metadata',
    update: {
      title: { form: 'set', value: 'Le renard et la grue' },
      description: { form: 'set', value: 'Deuxième révision.' },
    },
  });
});

test('une version modifiée part en entier, jamais en chaîne', () => {
  const members = advancedMetadataMembers(imported, {
    ...advancedPackMetadataDraft(imported),
    version: '3',
  });
  assert.deepEqual(members, { version: { form: 'set', value: 3 } });
});

// ── Aucun repli inventé ──────────────────────────────────────────────────────

test('une version absente reste absente, jamais repliée sur 1', () => {
  assert.equal(advancedPackMetadataDraft(created).version, '');
  // `null` est une présence réelle : il n'est pas non plus replié sur une valeur.
  const emptied = { ...imported, metadata: { ...imported.metadata, description: nulled } };
  assert.equal(advancedPackMetadataDraft(emptied).description, '');
});

test('les compteurs comptent la structure réelle, pas des histoires absentes', () => {
  // Le piège : un projet graphe n'a pas d'arbre, et compter ses histoires
  // afficherait zéro pour la mauvaise raison.
  assert.deepEqual(
    advancedPackMetadataCounters(imported, [{ assetRef: 'a.mp3' }, { assetRef: 'b.png' }]),
    { stages: 12, actions: 5, options: 9, media: 2 },
  );
  assert.equal(advancedPackMetadataCounters(null), null);
});

// ── Le récapitulatif du bandeau ──────────────────────────────────────────────

test('le bandeau ne compose pas un âge minimum que le graphe n’a pas', () => {
  assert.deepEqual(advancedPackRecap(imported), { title: 'Le renard', line: 'v2' });
  // Un document créé sans version en recevra une à la production — `1`, le
  // défaut. La ligne le dit, au lieu d'afficher « v1 » comme si l'auteur
  // l'avait posée.
  assert.deepEqual(advancedPackRecap(created), { title: 'Brouillon', line: 'v1 par défaut à la production' });
  assert.equal(advancedPackRecap(null), null);
});

test('le bandeau libre garde exactement la ligne qu’il affichait', () => {
  assert.deepEqual(
    freePackRecap({ packMetadata: { title: 'Contes', minAge: '6', version: 3 } }, 'pack'),
    { title: 'Contes', line: '6+ · v3' },
  );
  // Les replis Libre sont conservés : ils viennent de la convention de nom, qui
  // les exige. C'est côté graphe qu'ils seraient inventés, pas ici.
  assert.deepEqual(
    freePackRecap({ packMetadata: {} }, 'pack'),
    { title: '', line: '3+ · v1' },
  );
  // Un projet 'simple' sans titre de pack retombe sur le nom du projet.
  assert.deepEqual(
    freePackRecap({ projectName: 'Mon projet', packMetadata: {} }, 'simple'),
    { title: 'Mon projet', line: '3+ · v1' },
  );
  assert.equal(freePackRecap({}, null), null);
});

// ── Valider sans changer ne retouche rien ────────────────────────────────────
// Contre-exemple : la saisie était nettoyée **avant** d'être comparée à la
// valeur d'origine, qui ne l'est pas. Un titre importé « ␣Mon titre␣ »
// paraissait donc modifié dès qu'on validait la fiche, et perdait ses
// extrémités — contraire à la conservation des champs non visés.

const withWhitespace = {
  documentOrigin: 'imported-studio',
  packIdentity: { origin: 'square-one-stage', value: 'stage-entree' },
  metadata: {
    title: value('  Mon titre  '),
    version: value(2),
    description: value('\nUn conte.\n'),
    uuid: value('11111111-2222-4333-8444-555566667777'),
  },
  counts: { stages: 3, actions: 1, options: 2, edges: 4 },
};

test('valider sans rien changer ne touche pas un texte importé à extrémités', () => {
  const draft = advancedPackMetadataDraft(withWhitespace);
  assert.equal(draft.title, '  Mon titre  ', 'la fiche montre la valeur d’auteur telle quelle');
  // Le défaut observé était un geste qui réécrivait le titre nettoyé.
  assert.equal(advancedMetadataGesture(withWhitespace, draft), null);
});

test('modifier la seule description laisse le titre à extrémités intact', () => {
  const members = advancedMetadataMembers(withWhitespace, {
    ...advancedPackMetadataDraft(withWhitespace),
    description: 'Deuxième révision.',
  });
  assert.deepEqual(members, { description: { form: 'set', value: 'Deuxième révision.' } });
});

test('une saisie qui ne diffère que par ses extrémités ne produit pas de pas d’annulation', () => {
  // Le titre courant est déjà « Le renard » : y ajouter une espace de fin ne
  // change pas la valeur d'auteur, et ne doit pas fabriquer une étape d'undo.
  const members = advancedMetadataMembers(imported, {
    ...advancedPackMetadataDraft(imported),
    title: 'Le renard   ',
  });
  assert.equal(members, null);
});

test('vider un champ reste possible, et une vraie modification passe nettoyée', () => {
  assert.deepEqual(
    advancedMetadataMembers(withWhitespace, { ...advancedPackMetadataDraft(withWhitespace), description: '' }),
    { description: { form: 'absent' } },
  );
  assert.deepEqual(
    advancedMetadataMembers(withWhitespace, { ...advancedPackMetadataDraft(withWhitespace), title: '  Autre titre  ' }),
    { title: { form: 'set', value: 'Autre titre' } },
  );
});

// ── Appliquer ne ferme pas la fiche par principe ─────────────────────────────
// Contre-exemple : pendant un export, la session rend `held` sans
// écrire ni lever d'exception, et la fiche se fermait quand même. Le texte
// saisi était perdu sans qu'aucun message ne le dise.

test('la fiche ne se ferme que si la demande a abouti, ou s’il n’y avait rien à demander', () => {
  assert.deepEqual(metadataSaveDecision(null), { result: METADATA_SAVE_CLOSED, notice: null });
  assert.deepEqual(
    metadataSaveDecision({ status: 'applied' }),
    { result: METADATA_SAVE_CLOSED, notice: null },
  );
});

test('un geste tenu par un export conserve la saisie et dit pourquoi', () => {
  const decision = metadataSaveDecision({ status: 'held', reason: 'export' });
  assert.equal(decision.result, METADATA_SAVE_KEPT);
  assert.match(decision.notice, /export/i);
  assert.match(decision.notice, /conservée/);
});

test('refus, occupation et péremption conservent aussi la saisie, chacun avec sa raison', () => {
  const notices = new Set();
  for (const status of ['refused', 'busy', 'queued', 'stale']) {
    const decision = metadataSaveDecision({ status });
    assert.equal(decision.result, METADATA_SAVE_KEPT, status);
    assert.ok(decision.notice, status);
    notices.add(decision.notice);
  }
  // Un refus et une péremption ne se disent pas pareil : l'un dit que rien n'a
  // été écrit, l'autre que le projet a changé sous la fiche.
  assert.ok(notices.size >= 3);
});

test('une issue inconnue conserve la saisie plutôt que de fermer en silence', () => {
  // La règle de repli va dans le sens sûr : on ne ferme jamais sur un état
  // qu'on ne sait pas interpréter.
  const decision = metadataSaveDecision({ status: 'quelque-chose-de-neuf' });
  assert.equal(decision.result, METADATA_SAVE_KEPT);
  assert.ok(decision.notice);
});

test('the graph draft carries the imported identity only while it is unchanged', () => {
  assert.equal(advancedPackMetadataDraft(imported).originalUuid, '22222222-3333-4444-8555-666677778888');
  assert.equal(advancedPackMetadataDraft(created).originalUuid, '');
  const fs = { ...imported, packIdentity: { origin: 'fs-entry-stage', value: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' } };
  assert.equal(advancedPackMetadataDraft(fs).originalUuid, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
  const renewed = { ...imported, packIdentity: { origin: 'generated', value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000' } };
  assert.equal(advancedPackMetadataDraft(renewed).originalUuid, '');
});

test('the original identity never becomes a metadata gesture', () => {
  assert.equal(advancedMetadataGesture(imported, advancedPackMetadataDraft(imported)), null);
});

test('the graph cover is the envelope thumbnail, else the entry stage image the export takes', () => {
  const index = {
    entries: [
      { kind: 'stage', path: 'a', node: { squareOne: value(true), image: { presence: 'value', assetRef: 'entry.png' } } },
      { kind: 'stage', path: 'b', node: { squareOne: value(false), image: { presence: 'value', assetRef: 'other.png' } } },
    ],
  };
  assert.equal(advancedEntryImageRef(index), 'entry.png');
  assert.equal(advancedEntryImageRef({ entries: [] }), null);

  const bound = (status) => ({
    authoring: { mediaBindings: [{ assetRef: 'entry.png', path: '/assets/entry.png', status }] },
  });
  assert.equal(advancedCoverImage(bound('resolved'), 'entry.png'), '/assets/entry.png');
  assert.equal(advancedCoverImage({ ...bound('resolved'), thumbnailImage: '/thumb.png' }, 'entry.png'), '/thumb.png');
  assert.equal(advancedCoverImage(bound('missing'), 'entry.png'), null);
  assert.equal(advancedCoverImage(bound('resolved'), null), null);
});
