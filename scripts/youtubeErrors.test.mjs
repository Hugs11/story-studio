// Erreurs typées de l'import YouTube. Un blocage de YouTube vise la connexion
// entière : il doit être reconnu pour interrompre le lot, et le message final
// doit distinguer les vidéos non tentées des vidéos en erreur.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMessage,
  isYoutubeBlocked,
  youtubeBlockedNotice,
  youtubeErrorCode,
  youtubeImportFailure,
} from '../src/utils/youtubeErrors.js';

test('reconnaît le code des erreurs typées et ignore les chaînes brutes', () => {
  const blocked = { code: 'blocked', message: 'YouTube demande une vérification anti-robot…' };
  assert.equal(youtubeErrorCode(blocked), 'blocked');
  assert.equal(isYoutubeBlocked(blocked), true);
  assert.equal(isYoutubeBlocked({ code: 'private', message: 'Cette vidéo est privée.' }), false);
  assert.equal(isYoutubeBlocked('Sign in to confirm you’re not a bot'), false);
  assert.equal(youtubeErrorCode(new Error('x')), null);
  assert.equal(errorMessage(blocked), blocked.message);
  assert.equal(errorMessage('brut'), 'brut');
});

test('un échec total expose la cause reconnue telle quelle, la cause brute en citation', () => {
  const fallback = "Aucune vidéo n'a pu être importée.";
  assert.equal(youtubeImportFailure({ firstError: null }, fallback), fallback);
  assert.equal(
    youtubeImportFailure({ firstError: 'Cette vidéo est privée.', firstErrorCode: 'private' }, fallback),
    `${fallback} Cette vidéo est privée.`,
  );
  assert.equal(
    youtubeImportFailure({ firstError: 'Téléchargement impossible : ERROR: x', firstErrorCode: 'other' }, fallback),
    `${fallback} Cause : Téléchargement impossible : ERROR: x`,
  );
  assert.equal(
    youtubeImportFailure({ firstError: 'erreur héritée' }, fallback),
    `${fallback} Cause : erreur héritée`,
  );
});

test('un lot interrompu par un blocage annonce les vidéos non tentées', () => {
  assert.equal(
    youtubeBlockedNotice({ total: 10, imported: 3, failures: 7, skipped: 6, blocked: true }),
    '3 vidéos importées sur 10. YouTube a ensuite bloqué cette connexion : '
      + '6 vidéos restantes n’ont pas été tentées. Réessaie dans quelques heures.',
  );
  assert.match(
    youtubeBlockedNotice({ total: 2, imported: 0, failures: 2, skipped: 1, blocked: true }),
    /1 vidéo restante n’a pas été tentée/,
  );
  assert.equal(youtubeBlockedNotice({ total: 5, imported: 3, failures: 2, skipped: 0, blocked: false }), null);
  // Blocage sur la dernière vidéo : rien n'a été sauté, le message habituel suffit.
  assert.equal(youtubeBlockedNotice({ total: 5, imported: 4, failures: 1, skipped: 0, blocked: true }), null);
});
