import { presentTechnicalMessage, presentUserMessage, rustMessageEnvelope } from './userMessage.js';
import { isCheckerRef, presentChecker } from './checkerPresentation.js';

// Les codes de classement et les données d'auteur restent intacts. Seules les
// enveloppes de présentation produites par Rust sont résolues dans la langue UI.
export function presentCheckerReport(value, options) {
  // Lignes ajoutées côté interface (journal de correction) : clés résolues à l'export.
  if (isCheckerRef(value)) return presentChecker(value);
  if (typeof value?.code === 'string' && value.params) return presentUserMessage(value, options).message;
  if (typeof value === 'string') return presentTechnicalMessage(value, options);
  if (Array.isArray(value)) return value.map((item) => presentCheckerReport(item, options));
  if (!value || typeof value !== 'object') return value;
  const presented = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, presentCheckerReport(item, options)]));
  // Certains constats de structure n'ont pas de champ code distinct : conserver
  // celui de l'enveloppe avant que son message ne devienne du texte traduit.
  if (value.category) {
    const envelope = rustMessageEnvelope(value.message);
    if (!value.code && envelope?.code) presented.code = envelope.code;
    if (envelope?.code === 'CHECKER_STORY_FIELD_MISSING') presented.messageParams = envelope.params;
  }
  return presented;
}
