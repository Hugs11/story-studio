import { formatFrenchCount } from './frenchText.js';

// Erreurs typées des commandes YouTube : `{ code, message }`, classées côté
// Rust (services/youtube/error.rs) à partir de la sortie de yt-dlp. Un
// blocage vise la connexion entière : chaque requête supplémentaire le
// prolonge, un lot doit donc s'arrêter à la première occurrence.
const YOUTUBE_BLOCKED = 'blocked';

export function youtubeErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : null;
}

export function isYoutubeBlocked(error) {
  return youtubeErrorCode(error) === YOUTUBE_BLOCKED;
}

export function errorMessage(error) {
  return String(error?.message ?? error);
}

// Échec total d'un lot. Une cause reconnue est déjà une phrase explicative ;
// une cause brute de yt-dlp reste présentée comme telle.
export function youtubeImportFailure(result, fallback) {
  const cause = result?.firstError?.trim();
  if (!cause) return fallback;
  const code = result.firstErrorCode;
  if (code && code !== 'other') return `${fallback} ${cause}`;
  return `${fallback} Cause : ${cause.slice(0, 400)}`;
}

// Échec partiel dû à un blocage : les vidéos non tentées ne doivent pas passer
// pour des vidéos en erreur. `null` si le lot n'a pas été interrompu.
export function youtubeBlockedNotice(result) {
  const { total, imported, skipped = 0, blocked = false } = result ?? {};
  if (!blocked || skipped <= 0) return null;
  return `${formatFrenchCount(imported, 'vidéo importée', 'vidéos importées')} sur ${total}. `
    + `YouTube a ensuite bloqué cette connexion : ${formatFrenchCount(skipped, 'vidéo restante n’a', 'vidéos restantes n’ont')} pas été ${skipped === 1 ? 'tentée' : 'tentées'}. `
    + 'Réessaie dans quelques heures.';
}
