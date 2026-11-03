import { exampleBuilder, opening } from './exampleBuilder.js';
import { exampleContentLanguage, exampleTranslator } from '../../i18n/examplesPresentation.js';

// Tables de **clés**, résolues à la création dans la langue capturée au choix.
// Le libellé `label` est le fragment que les gabarits d'Actions intègrent
// (« la piste du potager ») : chaque langue l'accorde à ses propres gabarits.
const RABBIT_TRAILS = [
  {
    label: 'examples:rabbit.garden.label', title: 'examples:rabbit.garden.title',
    scene: 'examples:rabbit.garden.scene',
    choices: ['examples:rabbit.garden.choiceA', 'examples:rabbit.garden.choiceB'],
    outcomes: ['examples:rabbit.garden.outcomeA', 'examples:rabbit.garden.outcomeB'],
    clue: 'examples:rabbit.garden.clue',
  },
  {
    label: 'examples:rabbit.magpie.label', title: 'examples:rabbit.magpie.title',
    scene: 'examples:rabbit.magpie.scene',
    choices: ['examples:rabbit.magpie.choiceA', 'examples:rabbit.magpie.choiceB'],
    outcomes: ['examples:rabbit.magpie.outcomeA', 'examples:rabbit.magpie.outcomeB'],
    clue: 'examples:rabbit.magpie.clue',
  },
  {
    label: 'examples:rabbit.bridge.label', title: 'examples:rabbit.bridge.title',
    scene: 'examples:rabbit.bridge.scene',
    choices: ['examples:rabbit.bridge.choiceA', 'examples:rabbit.bridge.choiceB'],
    outcomes: ['examples:rabbit.bridge.outcomeA', 'examples:rabbit.bridge.outcomeB'],
    clue: 'examples:rabbit.bridge.clue',
    correct: 1,
  },
];

export function greyRabbitStory(language = 'fr') {
  const tx = exampleTranslator(language);
  const b = exampleBuilder('grey-rabbit', tx('examples:rabbit.example.title'), tx('examples:rabbit.example.description'), {
    tx, language: exampleContentLanguage(language),
    titleKey: 'examples:rabbit.example.title', descriptionKey: 'examples:rabbit.example.description',
  });
  const { hub, returnAction } = opening(b, tx('examples:rabbit.opening.entry'),
    tx('examples:rabbit.opening.menu'), 3500, {
      introText: tx('examples:rabbit.opening.intro'),
    });
  const trails = [];
  const clues = [];
  RABBIT_TRAILS.forEach((trail, index) => {
    const y = 500 + index * 980;
    const label = tx(trail.label);
    const start = b.stage(tx(trail.title), 1280, y, { role: 'choice', image: true });
    const scene = b.stage(tx(trail.scene), 1920, y);
    trails.push(start);
    b.link(start, scene, tx('examples:rabbit.trail.start', { label }), 1600, y);
    const choices = [];
    const outcomes = [];
    trail.choices.forEach((key, rank) => {
      const lane = y + (rank === 0 ? -200 : 200);
      const name = tx(key);
      const choice = b.stage(name, 3200, lane, { role: 'choice', image: true });
      const outcome = b.stage(tx(trail.outcomes[rank]), 3840, lane);
      choices.push(choice);
      outcomes.push(outcome);
      b.link(choice, outcome, tx('examples:rabbit.trail.explore', { label, choice: name }), 3520, lane);
    });
    const choose = b.action(tx('examples:rabbit.trail.choose', { label }), choices, 2560, y);
    b.transition(scene, choose);
    const clue = b.stage(tx(trail.clue), 4480, y);
    const good = trail.correct ?? 0;
    b.link(outcomes[good], clue, tx('examples:rabbit.trail.followClue', { label }), 4160, y + (good === 0 ? -200 : 200));
    b.transition(outcomes[1 - good], choose);
    clues.push(clue);
  });
  const menu = b.action(tx('examples:rabbit.menu.choose'), trails, 960, 0);
  b.transition(hub, menu);
  const meeting = b.stage(tx('examples:rabbit.mill.meeting'), 5120, 1480);
  const meet = b.action(tx('examples:rabbit.mill.gather'), [meeting], 4800, 1480);
  clues.forEach((clue) => b.transition(clue, meet));
  const inspect = b.stage(tx('examples:rabbit.mill.inspect'), 5760, 1480, { image: true });
  b.link(meeting, inspect, tx('examples:rabbit.mill.spot'), 5440, 1480);
  const prompt = b.stage(tx('examples:rabbit.mill.prompt'), 6400, 1480);
  b.link(inspect, prompt, tx('examples:rabbit.mill.seekWay'), 6080, 1480);
  const names = [
    tx('examples:rabbit.rescue.callChoice'), tx('examples:rabbit.rescue.branchChoice'), tx('examples:rabbit.rescue.doorChoice'),
  ];
  const results = [
    tx('examples:rabbit.rescue.callResult'),
    tx('examples:rabbit.rescue.branchResult'),
    tx('examples:rabbit.rescue.doorResult'),
  ];
  const choices = [];
  const outcomes = [];
  names.forEach((name, index) => {
    const y = 1480 + (index - 1) * 360;
    const choice = b.stage(name, 7680, y, { role: 'choice', image: true });
    const outcome = b.stage(results[index], 8320, y);
    choices.push(choice);
    outcomes.push(outcome);
    b.link(choice, outcome, tx('examples:rabbit.rescue.recover', { choice: name }), 8000, y);
  });
  const rescue = b.action(tx('examples:rabbit.rescue.choose'), choices, 7040, 1480);
  b.transition(prompt, rescue);
  b.transition(outcomes[2], rescue);
  const endings = [
    b.stage(tx('examples:rabbit.ending.nino'), 8960, 1120, { image: true, controls: { autoplay: false } }),
    b.stage(tx('examples:rabbit.ending.friends'), 8960, 1480, { image: true, controls: { autoplay: false } }),
  ];
  endings.forEach((ending, index) => {
    b.link(outcomes[index], ending, index === 0 ? tx('examples:rabbit.ending.inviteNino') : tx('examples:rabbit.ending.openParty'), 8640, 1120 + index * 360);
    b.transition(ending, returnAction);
  });
  return b.finish(hub, returnAction);
}

const LIGHTHOUSE_ROUTES = [
  {
    label: 'examples:lighthouse.beach.label', title: 'examples:lighthouse.beach.title',
    scene: 'examples:lighthouse.beach.scene',
    choices: ['examples:lighthouse.beach.choiceA', 'examples:lighthouse.beach.choiceB'],
    results: ['examples:lighthouse.beach.resultA', 'examples:lighthouse.beach.resultB'],
    problem: 'examples:lighthouse.beach.problem',
    withoutRope: 'examples:lighthouse.beach.withoutRope',
    solutions: ['examples:lighthouse.beach.solutionA', 'examples:lighthouse.beach.solutionB'],
    consequences: ['examples:lighthouse.beach.consequenceA', 'examples:lighthouse.beach.consequenceB'],
  },
  {
    label: 'examples:lighthouse.forest.label', title: 'examples:lighthouse.forest.title',
    scene: 'examples:lighthouse.forest.scene',
    choices: ['examples:lighthouse.forest.choiceA', 'examples:lighthouse.forest.choiceB'],
    results: ['examples:lighthouse.forest.resultA', 'examples:lighthouse.forest.resultB'],
    problem: 'examples:lighthouse.forest.problem',
    solutions: ['examples:lighthouse.forest.solutionA', 'examples:lighthouse.forest.solutionB'],
    consequences: ['examples:lighthouse.forest.consequenceA', 'examples:lighthouse.forest.consequenceB'],
  },
  {
    label: 'examples:lighthouse.port.label', title: 'examples:lighthouse.port.title',
    scene: 'examples:lighthouse.port.scene',
    choices: ['examples:lighthouse.port.choiceA', 'examples:lighthouse.port.choiceB'],
    results: ['examples:lighthouse.port.resultA', 'examples:lighthouse.port.resultB'],
    problem: 'examples:lighthouse.port.problem',
    solutions: ['examples:lighthouse.port.solutionA', 'examples:lighthouse.port.solutionB'],
    consequences: ['examples:lighthouse.port.consequenceA', 'examples:lighthouse.port.consequenceB'],
  },
];

export function lighthouseStory(language = 'fr') {
  const tx = exampleTranslator(language);
  const b = exampleBuilder('lighthouse', tx('examples:lighthouse.example.title'), tx('examples:lighthouse.example.description'), {
    tx, language: exampleContentLanguage(language),
    titleKey: 'examples:lighthouse.example.title', descriptionKey: 'examples:lighthouse.example.description',
  });
  const { hub, returnAction } = opening(b, tx('examples:lighthouse.opening.entry'),
    tx('examples:lighthouse.opening.menu'), 4300, {
      introText: tx('examples:lighthouse.opening.intro'),
    });
  const paths = [];
  const rescued = [];
  LIGHTHOUSE_ROUTES.forEach((route, index) => {
    const y = 600 + index * 1300;
    const label = tx(route.label);
    const path = b.stage(tx(route.title), 1280, y, { role: 'choice', image: true });
    const scene = b.stage(tx(route.scene), 1920, y);
    paths.push(path);
    b.link(path, scene, tx('examples:lighthouse.route.start', { label }), 1600, y);
    const choices = [];
    const results = [];
    route.choices.forEach((key, rank) => {
      const lane = y + (rank === 0 ? -230 : 230);
      const name = tx(key);
      const choice = b.stage(name, 3200, lane, { role: 'choice', image: true });
      const result = b.stage(tx(route.results[rank]), 3840, lane);
      choices.push(choice);
      results.push(result);
      b.link(choice, result, tx('examples:lighthouse.route.continue', { label, choice: name }), 3520, lane);
    });
    const choose = b.action(tx('examples:lighthouse.route.choose', { label }), choices, 2560, y);
    b.transition(scene, choose);
    // La corde reste attachée au chemin qui la ramasse : le trajet sans corde
    // possède sa propre scène et n'offre jamais une solution qui l'utiliserait.
    const problems = index === 0 ? results.map((_, rank) => b.stage(tx(rank === 0 ? route.problem : route.withoutRope), 4480, y + (rank === 0 ? -230 : 230)))
      : [b.stage(tx(route.problem), 4480, y)];
    if (index === 0) results.forEach((result, rank) => b.link(result, problems[rank], rank === 0 ? tx('examples:lighthouse.trapdoor.withRope') : tx('examples:lighthouse.trapdoor.withoutRope'), 4160, y + (rank === 0 ? -230 : 230)));
    else {
      const arrival = b.action(tx('examples:lighthouse.route.arrive', { label }), problems, 4160, y);
      results.forEach((result) => b.transition(result, arrival));
    }
    const solutions = [];
    route.solutions.forEach((key, rank) => {
      const lane = y + (rank === 0 ? -230 : 230);
      const name = tx(key);
      const solution = b.stage(name, 5760, lane, { role: 'choice', image: true });
      const consequence = b.stage(tx(route.consequences[rank]), 6400, lane);
      solutions.push(solution);
      rescued.push(consequence);
      b.link(solution, consequence, tx('examples:lighthouse.route.help', { label, choice: name }), 6080, lane);
    });
    const solve = b.action(tx('examples:lighthouse.route.chooseHelp', { label }), solutions, 5120, y - (index === 0 ? 230 : 0));
    b.transition(problems[0], solve);
    if (index === 0) {
      const withoutRope = b.action(tx('examples:lighthouse.trapdoor.liftTogether'), [solutions[1]], 5120, y + 230);
      b.transition(problems[1], withoutRope);
    }
  });
  const menu = b.action(tx('examples:lighthouse.menu.choose'), paths, 960, 0);
  b.transition(hub, menu);
  const light = b.stage(tx('examples:lighthouse.finale.light'), 7040, 1900, { image: true });
  const meet = b.action(tx('examples:lighthouse.finale.gather'), [light], 6720, 1900);
  rescued.forEach((stage) => b.transition(stage, meet));
  const boats = b.stage(tx('examples:lighthouse.finale.boats'), 7680, 1900, { image: true });
  b.link(light, boats, tx('examples:lighthouse.finale.guide'), 7360, 1900);
  const thanks = b.stage(tx('examples:lighthouse.finale.thanks'), 8320, 1900, { controls: { autoplay: false } });
  b.link(boats, thanks, tx('examples:lighthouse.finale.reunite'), 8000, 1900);
  b.transition(thanks, returnAction);
  return b.finish(hub, returnAction);
}
