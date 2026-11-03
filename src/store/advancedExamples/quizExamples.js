import { exampleBuilder, opening } from './exampleBuilder.js';
import { exampleContentLanguage, exampleTranslator } from '../../i18n/examplesPresentation.js';

// Tables de **clés** : le texte est résolu à la création de l'exemple, dans la
// langue capturée au choix. Ordre, bonnes réponses et topologie sont communs
// à toutes les langues.
const GARDEN_QUESTIONS = [
  {
    subject: 'examples:garden.tunnels.subject',
    topic: 'examples:garden.tunnels.topic',
    question: 'examples:garden.tunnels.question',
    answers: ['examples:garden.tunnels.answerA', 'examples:garden.tunnels.answerB', 'examples:garden.tunnels.answerC'],
    feedback: ['examples:garden.tunnels.feedbackA', 'examples:garden.tunnels.feedbackB', 'examples:garden.tunnels.feedbackC'],
  },
  {
    subject: 'examples:garden.hedgehog.subject',
    topic: 'examples:garden.hedgehog.topic',
    question: 'examples:garden.hedgehog.question',
    answers: ['examples:garden.hedgehog.answerA', 'examples:garden.hedgehog.answerB', 'examples:garden.hedgehog.answerC'],
    feedback: ['examples:garden.hedgehog.feedbackA', 'examples:garden.hedgehog.feedbackB', 'examples:garden.hedgehog.feedbackC'],
    correct: 1,
  },
  {
    subject: 'examples:garden.snail.subject',
    topic: 'examples:garden.snail.topic',
    question: 'examples:garden.snail.question',
    answers: ['examples:garden.snail.answerA', 'examples:garden.snail.answerB', 'examples:garden.snail.answerC'],
    feedback: ['examples:garden.snail.feedbackA', 'examples:garden.snail.feedbackB', 'examples:garden.snail.feedbackC'],
    correct: 2,
  },
  {
    subject: 'examples:garden.pollen.subject',
    topic: 'examples:garden.pollen.topic',
    question: 'examples:garden.pollen.question',
    answers: ['examples:garden.pollen.answerA', 'examples:garden.pollen.answerB', 'examples:garden.pollen.answerC'],
    feedback: ['examples:garden.pollen.feedbackA', 'examples:garden.pollen.feedbackB', 'examples:garden.pollen.feedbackC'],
  },
];

const CASTLE_QUESTIONS = [
  {
    subject: 'examples:castle.forge.subject',
    topic: 'examples:castle.forge.topic',
    question: 'examples:castle.forge.question',
    answers: ['examples:castle.forge.answerA', 'examples:castle.forge.answerB', 'examples:castle.forge.answerC'],
    feedback: ['examples:castle.forge.feedbackA', 'examples:castle.forge.feedbackB', 'examples:castle.forge.feedbackC'],
  },
  {
    subject: 'examples:castle.bread.subject',
    topic: 'examples:castle.bread.topic',
    question: 'examples:castle.bread.question',
    answers: ['examples:castle.bread.answerA', 'examples:castle.bread.answerB', 'examples:castle.bread.answerC'],
    feedback: ['examples:castle.bread.feedbackA', 'examples:castle.bread.feedbackB', 'examples:castle.bread.feedbackC'],
    correct: 1,
  },
  {
    subject: 'examples:castle.seeds.subject',
    topic: 'examples:castle.seeds.topic',
    question: 'examples:castle.seeds.question',
    answers: ['examples:castle.seeds.answerA', 'examples:castle.seeds.answerB', 'examples:castle.seeds.answerC'],
    feedback: ['examples:castle.seeds.feedbackA', 'examples:castle.seeds.feedbackB', 'examples:castle.seeds.feedbackC'],
    correct: 2,
  },
  {
    subject: 'examples:castle.mail.subject',
    topic: 'examples:castle.mail.topic',
    question: 'examples:castle.mail.question',
    answers: ['examples:castle.mail.answerA', 'examples:castle.mail.answerB', 'examples:castle.mail.answerC'],
    feedback: ['examples:castle.mail.feedbackA', 'examples:castle.mail.feedbackB', 'examples:castle.mail.feedbackC'],
  },
  {
    subject: 'examples:castle.frame.subject',
    topic: 'examples:castle.frame.topic',
    question: 'examples:castle.frame.question',
    answers: ['examples:castle.frame.answerA', 'examples:castle.frame.answerB', 'examples:castle.frame.answerC'],
    feedback: ['examples:castle.frame.feedbackA', 'examples:castle.frame.feedbackB', 'examples:castle.frame.feedbackC'],
    correct: 1,
  },
  {
    subject: 'examples:castle.vase.subject',
    topic: 'examples:castle.vase.topic',
    question: 'examples:castle.vase.question',
    answers: ['examples:castle.vase.answerA', 'examples:castle.vase.answerB', 'examples:castle.vase.answerC'],
    feedback: ['examples:castle.vase.feedbackA', 'examples:castle.vase.feedbackB', 'examples:castle.vase.feedbackC'],
    correct: 2,
  },
];

function quiz(id, keys, questions, language) {
  const tx = exampleTranslator(language);
  const b = exampleBuilder(id, tx(keys.title), tx(keys.description), {
    tx, language: exampleContentLanguage(language), titleKey: keys.title, descriptionKey: keys.description,
  });
  const bottom = questions.length * 1100 + 360;
  const { hub, returnAction } = opening(b, tx(keys.entry), tx(keys.menu), bottom, { introText: tx(keys.intro) });
  const topics = [];
  const completed = [];
  questions.forEach((q, index) => {
    const y = 360 + index * 1100;
    const subject = tx(q.subject);
    const topic = b.stage(tx(q.topic), 1280, y, { role: 'choice', image: true });
    const prompt = b.stage(tx(q.question), 1920, y);
    topics.push(topic);
    b.link(topic, prompt, tx('examples:quiz.question.listen', { subject }), 1600, y);
    const choices = [];
    const results = [];
    for (let answer = 0; answer < q.answers.length; answer += 1) {
      const lane = y + (answer - 1) * 280;
      const answerText = tx(q.answers[answer]);
      const choice = b.stage(answerText, 3200, lane, { role: 'choice', image: true });
      const result = b.stage(tx(q.feedback[answer]), 3840, lane);
      choices.push(choice);
      results.push(result);
      b.link(choice, result, tx('examples:quiz.answer.check', { answer: answerText, subject }), 3520, lane);
    }
    const choose = b.action(tx('examples:quiz.answers.list', { subject }), choices, 2560, y);
    const retry = b.action(tx('examples:quiz.question.replay', { subject }), [prompt], 4160, y);
    b.transition(prompt, choose);
    results.forEach((result, rank) => {
      if (rank === (q.correct ?? 0)) completed.push(result);
      else b.transition(result, retry);
    });
  });
  const exit = b.stage(tx('examples:quiz.exit.stage'), 1280, bottom - 280, { role: 'choice', image: true });
  const farewell = b.stage(tx(keys.farewell), 1920, bottom - 280, { image: true, controls: { autoplay: false } });
  b.link(exit, farewell, tx('examples:quiz.exit.action'), 1600, bottom - 280);
  const menu = b.action(tx('examples:quiz.menu.action'), [...topics, exit], 960, 0);
  b.transition(hub, menu);
  completed.forEach((result) => b.transition(result, menu));
  b.transition(farewell, returnAction);
  return b.finish(hub, returnAction);
}

export function gardenQuiz(language = 'fr') {
  return quiz('garden-quiz', {
    title: 'examples:garden.example.title',
    description: 'examples:garden.example.description',
    entry: 'examples:garden.opening.entry',
    menu: 'examples:garden.opening.menu',
    intro: 'examples:garden.opening.intro',
    farewell: 'examples:garden.opening.farewell',
  }, GARDEN_QUESTIONS, language);
}

export function castleQuiz(language = 'fr') {
  return quiz('castle-quiz', {
    title: 'examples:castle.example.title',
    description: 'examples:castle.example.description',
    entry: 'examples:castle.opening.entry',
    menu: 'examples:castle.opening.menu',
    intro: 'examples:castle.opening.intro',
    farewell: 'examples:castle.opening.farewell',
  }, CASTLE_QUESTIONS, language);
}
