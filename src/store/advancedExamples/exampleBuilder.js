import { exampleTranslator } from '../../i18n/examplesPresentation.js';

// Descriptions autonomes du catalogue : les rangs sont locaux au motif collé.
// Les intentions médias restent distinctes des références, absentes avant génération.
//
// `tx` résout le contenu dans la langue capturée au choix de l'exemple : les
// noms produits sont des données d'auteur, jamais relus dans une autre langue.
// `titleKey`/`descriptionKey` servent seulement à présenter l'exemple dans la
// langue de l'interface ; la topologie ne dépend d'aucune langue.
export function exampleBuilder(id, title, description, {
  tx = exampleTranslator('fr'), language = 'fr', titleKey = null, descriptionKey = null,
} = {}) {
  const stages = [];
  const actions = [];
  const transitions = [];
  // `role` ne fait que choisir les boutons par défaut : il n'est pas conservé
  // dans la description, que rien ne relit au-delà de ce choix.
  function stage(name, x, y, { role = 'narration', image = false, audio = true, controls = {} } = {}) {
    // eslint-disable-next-line i18next/no-literal-string -- Invariant de développement du catalogue, jamais atteint à l'exécution.
    if (role === 'choice' && !audio) throw new Error('Un choix de menu doit pouvoir être écouté.');
    const rank = stages.length;
    const spoken = audio && role === 'narration';
    stages.push({
      name, offset: { x, y }, image: null, audio: null,
      mediaIntent: { image, audio },
      controls: { wheel: role === 'choice', ok: true, home: role !== 'entry', pause: spoken, autoplay: spoken, ...controls },
    });
    return rank;
  }
  function action(name, targets, x, y) {
    const rank = actions.length;
    actions.push({ name, options: targets.map((target) => ({ target: 'stage', stage: target })), offset: { x, y } });
    return rank;
  }
  function transition(from, to, optionIndex = 0, slot = 'ok') {
    transitions.push({ stage: from, slot, action: to, optionIndex });
  }
  function link(from, target, name, x, y) {
    const rank = action(name, [target], x, y);
    transition(from, rank);
    return rank;
  }
  function finish(hub, returnAction) {
    // Le hub n'est pas l'entrée : aucun retour ne transforme squareOne en option.
    // Son Accueil reste sans destination, pour ne jamais retomber sur lui-même.
    for (let rank = 0; rank < stages.length; rank += 1) {
      if (rank !== 0 && rank !== hub) transition(rank, returnAction, 0, 'home');
    }
    return { id, title, description, entryRank: 0, stages, actions, transitions, language, titleKey, descriptionKey };
  }
  return { stage, action, transition, link, finish, stages, actions, tx };
}

export function opening(builder, title, menuText, bottom, { introText } = {}) {
  const entry = builder.stage(title, 0, 0, { role: 'entry', image: true });
  const hub = builder.stage(menuText, 640, 0);
  if (introText) {
    const intro = builder.stage(introText, 320, -360);
    builder.link(entry, intro, builder.tx('examples:content.opening.start'), 160, -180);
    builder.link(intro, hub, builder.tx('examples:content.opening.menu'), 480, -180);
  } else {
    builder.link(entry, hub, builder.tx('examples:content.opening.menu'), 320, 0);
  }
  const returnAction = builder.action(builder.tx('examples:content.opening.back'), [hub], 640, bottom);
  return { entry, hub, returnAction };
}
