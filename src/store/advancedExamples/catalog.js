import { gardenQuiz, castleQuiz } from './quizExamples.js';
import { greyRabbitStory, lighthouseStory } from './storyExamples.js';
import { explorerTrain } from './trainExample.js';
import { translateExamples } from '../../i18n/examplesPresentation.js';

const FACTORIES = Object.freeze({
  'garden-quiz': gardenQuiz,
  'castle-quiz': castleQuiz,
  'grey-rabbit': greyRabbitStory,
  lighthouse: lighthouseStory,
  'explorer-train': explorerTrain,
});

// Les factories rendent à chaque appel de nouveaux tableaux : une génération
// de médias ou un déplacement ne peut modifier l'exemple suivant.
//
// `language` est la langue capturée au choix de l'exemple (`fr` par défaut) :
// noms, récits et titre sont produits dans cette langue, puis deviennent des
// données d'auteur. Un exemple déjà créé ne change jamais de langue.
export function createAdvancedExample(id, language = 'fr') {
  // eslint-disable-next-line i18next/no-literal-string -- Invariant de développement : identifiant hors catalogue.
  if (!Object.hasOwn(FACTORIES, id)) throw new RangeError(`Exemple de graphe inconnu : ${id}`);
  const factory = FACTORIES[id];
  // eslint-disable-next-line i18next/no-literal-string -- Invariant de développement : identifiant hors catalogue.
  if (typeof factory !== 'function') throw new RangeError(`Exemple de graphe inconnu : ${id}`);
  return factory(language);
}

// Métadonnées du menu : des **clés**, résolues à l'affichage dans la langue de
// l'interface. Les comptes ne dépendent d'aucune langue.
export const ADVANCED_EXAMPLES = Object.freeze(Object.keys(FACTORIES).map((id) => {
  const example = createAdvancedExample(id);
  const entry = { id, titleKey: example.titleKey, descriptionKey: example.descriptionKey,
    stageCount: example.stages.length, actionCount: example.actions.length };
  // Compatibilité des lecteurs historiques de `title`/`description` : résolus
  // à la lecture, jamais figés au chargement du module.
  Object.defineProperty(entry, 'title', { enumerable: true, get: () => translateExamples(entry.titleKey) });
  Object.defineProperty(entry, 'description', { enumerable: true, get: () => translateExamples(entry.descriptionKey) });
  return Object.freeze(entry);
}));
