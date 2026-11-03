import { exampleBuilder, opening } from './exampleBuilder.js';
import { exampleContentLanguage, exampleTranslator } from '../../i18n/examplesPresentation.js';

// Tables de **clés**, résolues à la création dans la langue capturée au choix.
const STATIONS = [
  {
    label: 'examples:train.stars.label',
    title: 'examples:train.stars.title',
    scene: 'examples:train.stars.scene',
    choices: ['examples:train.stars.choiceA', 'examples:train.stars.choiceB'],
    outcomes: ['examples:train.stars.outcomeA', 'examples:train.stars.outcomeB'],
    quiz: true,
  },
  {
    label: 'examples:train.clouds.label',
    title: 'examples:train.clouds.title',
    scene: 'examples:train.clouds.scene',
    choices: ['examples:train.clouds.choiceA', 'examples:train.clouds.choiceB'],
    outcomes: ['examples:train.clouds.outcomeA', 'examples:train.clouds.outcomeB'],
  },
  {
    label: 'examples:train.bees.label',
    title: 'examples:train.bees.title',
    scene: 'examples:train.bees.scene',
    choices: ['examples:train.bees.choiceA', 'examples:train.bees.choiceB'],
    outcomes: ['examples:train.bees.outcomeA', 'examples:train.bees.outcomeB'],
    quiz: true, correct: 1,
  },
  {
    label: 'examples:train.river.label',
    title: 'examples:train.river.title',
    scene: 'examples:train.river.scene',
    choices: ['examples:train.river.choiceA', 'examples:train.river.choiceB'],
    outcomes: ['examples:train.river.outcomeA', 'examples:train.river.outcomeB'],
  },
  {
    label: 'examples:train.numbers.label',
    title: 'examples:train.numbers.title',
    scene: 'examples:train.numbers.scene',
    choices: ['examples:train.numbers.choiceA', 'examples:train.numbers.choiceB'],
    outcomes: ['examples:train.numbers.outcomeA', 'examples:train.numbers.outcomeB'],
    quiz: true,
  },
  {
    label: 'examples:train.mill.label',
    title: 'examples:train.mill.title',
    scene: 'examples:train.mill.scene',
    choices: ['examples:train.mill.choiceA', 'examples:train.mill.choiceB'],
    outcomes: ['examples:train.mill.outcomeA', 'examples:train.mill.outcomeB'],
  },
  {
    label: 'examples:train.seasons.label',
    title: 'examples:train.seasons.title',
    scene: 'examples:train.seasons.scene',
    choices: ['examples:train.seasons.choiceA', 'examples:train.seasons.choiceB'],
    outcomes: ['examples:train.seasons.outcomeA', 'examples:train.seasons.outcomeB'],
    quiz: true, correct: 1,
  },
  {
    label: 'examples:train.lanterns.label',
    title: 'examples:train.lanterns.title',
    scene: 'examples:train.lanterns.scene',
    choices: ['examples:train.lanterns.choiceA', 'examples:train.lanterns.choiceB'],
    outcomes: ['examples:train.lanterns.outcomeA', 'examples:train.lanterns.outcomeB'],
  },
  {
    label: 'examples:train.sounds.label',
    title: 'examples:train.sounds.title',
    scene: 'examples:train.sounds.scene',
    choices: ['examples:train.sounds.choiceA', 'examples:train.sounds.choiceB'],
    outcomes: ['examples:train.sounds.outcomeA', 'examples:train.sounds.outcomeB'],
    quiz: true,
  },
  {
    label: 'examples:train.orchard.label',
    title: 'examples:train.orchard.title',
    scene: 'examples:train.orchard.scene',
    choices: ['examples:train.orchard.choiceA', 'examples:train.orchard.choiceB'],
    outcomes: ['examples:train.orchard.outcomeA', 'examples:train.orchard.outcomeB'],
  },
];

export function explorerTrain(language = 'fr') {
  const tx = exampleTranslator(language);
  const b = exampleBuilder('explorer-train', tx('examples:train.example.title'), tx('examples:train.example.description'), {
    tx, language: exampleContentLanguage(language),
    titleKey: 'examples:train.example.title', descriptionKey: 'examples:train.example.description',
  });
  const { hub, returnAction } = opening(b, tx('examples:train.opening.entry'), tx('examples:train.opening.menu'), 8400, {
    introText: tx('examples:train.opening.intro'),
  });
  const stops = [];
  const completed = [];
  STATIONS.forEach((station, index) => {
    // Les défis et les aventures alternent, dans l'ordre de la roue.
    // Chaque station garde sa bande et ses deux voies de décision.
    const y = 450 + index * 780;
    const label = tx(station.label);
    const stop = b.stage(tx(station.title), 1280, y, { role: 'choice', image: true });
    const scene = b.stage(tx(station.scene), 1920, y);
    stops.push(stop);
    b.link(stop, scene, tx('examples:train.station.discover', { label }), 1600, y);
    const choices = [];
    const outcomes = [];
    station.choices.forEach((key, rank) => {
      const lane = y + (rank === 0 ? -200 : 200);
      const name = tx(key);
      const choice = b.stage(name, 3200, lane, { role: 'choice', image: true });
      const outcome = b.stage(tx(station.outcomes[rank]), 3840, lane);
      choices.push(choice);
      outcomes.push(outcome);
      b.link(choice, outcome, tx('examples:train.station.choice', { label, choice: name }), 3520, lane);
    });
    const choose = b.action(station.quiz ? tx('examples:train.station.answers', { label }) : tx('examples:train.station.adventures', { label }), choices, 2560, y);
    b.transition(scene, choose);
    if (station.quiz) {
      const correct = station.correct ?? 0;
      completed.push(outcomes[correct]);
      b.link(outcomes[1 - correct], scene, tx('examples:train.station.replay', { label }), 4160, y + (correct === 0 ? 200 : -200));
    } else completed.push(...outcomes);
  });
  const exit = b.stage(tx('examples:train.exit.stage'), 1280, 8250, { role: 'choice', image: true });
  const farewell = b.stage(tx('examples:train.exit.farewell'),
    1920, 8250, { image: true, controls: { autoplay: false } });
  b.link(exit, farewell, tx('examples:train.exit.action'), 1600, 8250);
  b.transition(farewell, returnAction);
  const wheel = b.action(tx('examples:train.wheel.choose'), [...stops, exit], 960, 0);
  b.transition(hub, wheel);
  completed.forEach((outcome) => b.transition(outcome, wheel));
  return b.finish(hub, returnAction);
}
