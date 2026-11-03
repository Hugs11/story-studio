import { translateImport as t } from '../i18n/importPresentation.js';
import { presentUserMessage, presentStoredError, rustMessageEnvelope } from '../i18n/userMessage.js';

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
  return presentUserMessage(error).message;
}

// Échec total d'un lot. Une cause reconnue est déjà une phrase explicative ;
// une cause brute de yt-dlp reste présentée comme telle.
// Le producteur garde l'enveloppe. Les anciens appelants chaîne restent compatibles.
export function youtubeImportFailureRef(result, fallback) {
  const cause = result?.firstError;
  if (!cause) return fallback;
  const envelope = rustMessageEnvelope(cause);
  const code = envelope?.code ?? result.firstErrorCode;
  if (code && code !== 'other') return { key: 'import:youtube.failure.known', params: {
    message: fallback, reason: { userMessage: envelope ?? { code, params: {} }, codedOnly: true },
  } };
  // Une sortie outil brute n'est pas une phrase UI ; l'appelant la replie en détail.
  return fallback;
}

export function youtubeImportFailure(result, fallback) {
  if (typeof result?.firstError === 'string' && (!result.firstErrorCode || result.firstErrorCode === 'other')) {
    return t('import:youtube.failure.cause', { message: fallback, reason: result.firstError.slice(0, 400) });
  }
  return presentStoredError(youtubeImportFailureRef(result, fallback));
}

// Échec partiel dû à un blocage : les vidéos non tentées ne doivent pas passer
// pour des vidéos en erreur. `null` si le lot n'a pas été interrompu.
export function youtubeBlockedNoticeRef(result) {
  const { total, imported, skipped = 0, blocked = false } = result ?? {};
  if (!blocked || skipped <= 0) return null;
  return { key: 'import:youtube.blocked.imported', params: { count: imported, total, notice: { key: 'import:youtube.blocked.skipped', params: { count: skipped } } } };
}

export function youtubeBlockedNotice(result) {
  const ref = youtubeBlockedNoticeRef(result);
  return ref ? presentStoredError(ref) : null;
}
