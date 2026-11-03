import { exampleSpeechLanguage } from '../../i18n/examplesPresentation.js';
import { PIPER_DEFAULT_VOICE, batchTitleVoice, isTtsAvailable } from '../xttsSettings.js';

// Voix Piper proposées **pour l'exemple seulement** quand la voix choisie ne
// parle pas sa langue. Le défaut FR est celui du catalogue Rust ; ces trois
// identifiants existent dans `services/piper/catalog.rs`.
export const EXAMPLE_PIPER_VOICES = Object.freeze({
  fr: PIPER_DEFAULT_VOICE,
  en: 'en_US-kristin-medium',
  it: 'it_IT-serena-medium',
});

function voiceLanguage(voices, voice) {
  const listed = Array.isArray(voices) ? voices.find((candidate) => candidate.id === voice)?.language : null;
  const code = listed || /^([a-z]{2,3})_[A-Z]{2}-/.exec(String(voice ?? ''))?.[1] || '';
  return String(code).split(/[_-]/)[0].toLowerCase();
}

// Voix et langue des audios d'un exemple, sans rien écrire dans les
// Préférences. `voices` est le catalogue `piper_list_voices` :
// - `undefined` : lecture en cours ;
// - `null` : aucun moteur natif (hors Tauri), rien ne peut être installé ;
// - `false` : lecture en échec, l'installation reste à demander explicitement ;
// - tableau : état d'installation réel de chaque voix.
// Statuts : `ready`, `checking`, `missing` (choix explicite requis avant tout
// téléchargement) ou `unavailable` (aucune voix TTS utilisable).
export function exampleVoicePlan({ settings, language, voices }) {
  const speech = exampleSpeechLanguage(language);
  const backend = (settings?.backend || 'piper') === 'piper' ? 'piper' : 'xtts';
  const selected = batchTitleVoice(settings);
  if (!isTtsAvailable(settings) || !selected) {
    return { backend, language: speech, voice: selected || null, adapted: false, status: 'unavailable' };
  }
  // XTTS clone la référence choisie et reçoit la langue de l'exemple.
  if (backend === 'xtts') return { backend, language: speech, voice: selected, adapted: false, status: 'ready' };
  const adapted = voiceLanguage(voices, selected) !== speech;
  const voice = adapted ? EXAMPLE_PIPER_VOICES[speech] : selected;
  let status = 'ready';
  if (voices === undefined) status = 'checking';
  else if (voices === false) status = 'missing';
  else if (Array.isArray(voices)) status = voices.find((candidate) => candidate.id === voice)?.installed ? 'ready' : 'missing';
  return { backend, language: speech, voice, adapted, status };
}

// Les noms sont le contenu des exemples ; les intentions de médias sont
// distinctes des emplacements vides du document avant génération.
export function exampleMediaPlan(example, stageUuids = []) {
  const images = [];
  const audios = [];
  for (const [rank, stage] of example.stages.entries()) {
    const image = stage.mediaIntent?.image === true;
    const audio = stage.mediaIntent?.audio === true;
    if (!image && !audio) continue;
    const text = typeof stage.name === 'string' ? stage.name.trim() : '';
    // Ne jamais laisser le générateur d'image retomber sur « Sans titre »,
    // ni substituer l'identifiant technique au texte à prononcer.
    // eslint-disable-next-line i18next/no-literal-string -- Invariant de développement du catalogue, jamais atteint à l'exécution.
    if (!text) throw new TypeError('Un Écran avec média doit avoir un texte.');
    const target = { rank, text, stageUuid: stageUuids[rank] ?? null };
    if (image) images.push(target);
    if (audio) audios.push(target);
  }
  return {
    images, audios,
    withoutImage: example.stages.length - images.length,
    withoutAudio: example.stages.length - audios.length,
  };
}

// Génération injectée, éprouvée sans navigateur ni TTS. Les erreurs partielles
// gardent la structure créée et les fichiers déjà affectés ; une seule erreur
// n'empêche pas les autres Écrans de recevoir leur média.
//
// `isCurrent` devient faux au changement de projet comme à l'arrêt demandé par
// l'auteur : la boucle s'interrompt au prochain point de contrôle, sans rien
// affecter ni mettre en file de plus. Une image écrite mais non affectée —
// projet changé, arrêt, refus du geste — est rendue à `discardImage` : aucun
// fichier orphelin ne reste dans l'espace de travail.
export async function generateExampleMedia({
  plan, images, audios, generateImage, assignImage, queueAudio,
  isCurrent, onProgress = () => {}, discardImage = async () => {},
}) {
  const errors = [];
  let imageCount = 0;
  let audioCount = 0;
  const total = (images ? plan.images.length : 0) + (audios ? plan.audios.length : 0);
  let completed = 0;
  // Libellés gardés en descripteurs : la présentation suit la langue courante.
  const progress = (label) => onProgress({ completed, total, label });
  const failure = (key) => Object.assign(new Error(key), { presentationRef: { key } });
  const failed = (target, error) => ({ key: 'examples:error.media.item', params: { name: target.text, error: { userMessage: error } } });
  const active = () => isCurrent();
  for (const target of images ? plan.images : []) {
    if (!active()) return { stale: true, errors, imageCount, audioCount };
    progress({ key: 'examples:progress.image.item', params: { name: target.text } });
    let path = null;
    // Tant que l'image n'est pas affectée, elle reste à jeter.
    const discard = async () => {
      const pending = path;
      path = null;
      if (!pending) return;
      try {
        await discardImage(pending);
      } catch {
        // Le nettoyage est au mieux : son échec ne masque pas l'issue réelle.
      }
    };
    try {
      path = await generateImage(target.text, target);
      if (!active()) {
        await discard();
        return { stale: true, errors, imageCount, audioCount };
      }
      if (!path) throw failure('examples:error.image.missing');
      const outcome = await assignImage(target.stageUuid, path);
      if (outcome?.status === 'applied') {
        path = null;
        imageCount += 1;
      } else await discard();
      if (!active()) return { stale: true, errors, imageCount, audioCount };
      if (outcome?.status !== 'applied') throw failure('examples:error.image.refused');
    } catch (error) {
      await discard();
      errors.push(failed(target, error));
    }
    completed += 1;
    progress(null);
  }
  for (const target of audios ? plan.audios : []) {
    if (!active()) return { stale: true, errors, imageCount, audioCount };
    progress({ key: 'examples:progress.audio.item', params: { name: target.text } });
    try {
      await queueAudio(target);
      audioCount += 1;
    } catch (error) {
      errors.push(failed(target, error));
    }
    completed += 1;
    progress(null);
  }
  return { stale: !active(), errors, imageCount, audioCount };
}
