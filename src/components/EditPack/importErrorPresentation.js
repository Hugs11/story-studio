import { translateImport as t } from '../../i18n/importPresentation.js';
import { presentUserMessage, rustMessageEnvelope } from '../../i18n/userMessage.js';

export function isFreeEditorRefusal(error) {
  return rustMessageEnvelope(error)?.code === 'PACK_NOT_EDITABLE';
}

const FALLBACK_MESSAGES = {
  open: 'import:error.open.fallback',
  simulate: 'import:error.simulate.fallback',
  graph: 'import:error.graph.fallback',
  readOnly: 'import:error.readOnly.fallback',
  unsupported: 'import:error.unsupported.fallback',
};

const IMPORT_CODES = new Set([
  'PACK_NOT_EDITABLE', 'IMPORT_UNSUPPORTED_COMPRESSION', 'IMPORT_UNSUPPORTED_VARIANT',
  'IMPORT_PASSWORD_REQUIRED', 'IMPORT_INVALID_ARCHIVE', 'IMPORT_MISSING_MEDIA',
  'IMPORT_INCOMPLETE_CONTROLS',
]);

export function presentImportError(error, context = 'open') {
  // Ces refus frontend restent des références jusqu’au rendu du funnel.
  if (error?.key?.startsWith('import:') || error?.presentationRef || ['home:project.landing.noStories', 'home:project.landing.depthLimit'].includes(error?.key)) {
    return {
      get message() { return presentUserMessage(error).message; },
      get technicalDetail() { return presentUserMessage(error).technicalDetail; },
    };
  }
  const envelope = rustMessageEnvelope(error);
  const presented = presentUserMessage(error);
  const detailEnvelope = rustMessageEnvelope(presented.technicalDetail);
  return {
    get message() { return IMPORT_CODES.has(envelope?.code)
      ? presentUserMessage(error).message
      : t(FALLBACK_MESSAGES[context] ?? FALLBACK_MESSAGES.open); },
    get technicalDetail() { return (detailEnvelope?.code ? presentUserMessage(detailEnvelope).message : presented.technicalDetail).trim(); },
  };
}
