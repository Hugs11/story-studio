import { translateGraph as t } from '../../i18n/graphPresentation.js';
// Les constructions sont des demandes atomiques ; aucun payload n'est édité ici.
import { advancedGestures } from '../projectModel/advancedGestures.js';

// La disponibilité de la création ne modifie pas la lecture ni l'édition
// des constructions déjà présentes dans un document.
export const DERIVED_CONSTRUCTION_CREATION_ENABLED = false;

export const CONSTRUCTION_LABELS = Object.freeze({
  scene: "graph:construction.scene.label", choice: 'graph:construction.kind.choice', sequence: "graph:construction.sequence.label", random: 'graph:construction.kind.random',
});
// Les réglages de départ d'une construction, par rôle d'Écran. HOME est
// allumé dans les deux, comme sur la quasi-totalité des Écrans d'un pack réel :
// sans lui, l'enfant ne peut plus revenir en arrière.
export const NARRATIVE_CONTROLS = Object.freeze({
  wheel: false, ok: false, home: true, pause: true, autoplay: true,
});
export const CHOICE_CONTROLS = Object.freeze({
  wheel: true, ok: true, home: true, pause: false, autoplay: false,
});

function stageUuid(index, path) {
  if (!path) return null;
  const entry = index?.byPath.get(path);
  if (!entry || entry.kind !== 'stage' || entry.node.uniqueId === false) {
    throw new TypeError(t("graph:construction.chooseAnExistingStageWithAUniqueIdentifier.label"));
  }
  return entry.node.uuid;
}

export function buildConstructionGesture(index, draft) {
  const { kind, name, items, controls, optionControls, question, sourcePath, trigger, destinationPath } = draft;
  if (!Object.hasOwn(CONSTRUCTION_LABELS, kind)) throw new TypeError(t('graph:construction.error.unknown'));
  if (kind !== 'sequence' && !name.trim()) throw new TypeError(t("graph:construction.nameTheConstruction.label"));
  const rows = kind === 'scene' ? [] : items;
  const minimum = kind === 'sequence' ? 1 : 2;
  if (kind !== 'scene' && rows.length < minimum) throw new TypeError(t("graph:construction.addAtLeastItems.label", { minimum: minimum }));
  for (const row of rows) {
    if (!row.name.trim() && !(kind === 'random' && row.targetPath)) {
      throw new TypeError(t('graph:construction.error.itemName'));
    }
  }
  if (kind === 'random' && !sourcePath) throw new TypeError(t("graph:construction.chooseTheStageFromWhichToDrawARandom.label"));
  if (!['autoplay', 'ok', 'home'].includes(trigger)) throw new TypeError(t("graph:construction.unknownTrigger.label"));
  return advancedGestures.createConstruction({
    kind, name: kind === 'sequence' ? rows[0].name.trim() : name.trim(),
    items: rows.map((row) => ({ name: row.name.trim(), target: kind === 'sequence' ? null : stageUuid(index, row.targetPath) })),
    controls: { ...controls }, optionControls: { ...optionControls },
    question: kind === 'choice' && question,
    destination: stageUuid(index, destinationPath),
    source: sourcePath ? {
      stageUuid: stageUuid(index, sourcePath),
      slot: trigger === 'home' ? 'home' : 'ok',
      controls: { form: 'members', members: { [trigger]: { form: 'set', value: true } } },
    } : null,
  });
}
