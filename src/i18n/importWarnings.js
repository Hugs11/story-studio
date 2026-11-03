import { presentUserMessage, rustMessageEnvelope } from './userMessage.js';

const FIELD_LABELS = {
  returnAfterPlay: 'IMPORT_LABEL_AFTER_PLAY',
  returnOnHome: 'IMPORT_LABEL_HOME_BUTTON',
  titleReturnOnHome: 'IMPORT_LABEL_TITLE_HOME',
  afterPlaybackPromptOkTarget: 'IMPORT_LABEL_PROMPT_OK',
  afterPlaybackPromptHomeTarget: 'IMPORT_LABEL_PROMPT_HOME',
  'afterPlaybackSequence.okTarget': 'IMPORT_LABEL_STEP_OK',
  'afterPlaybackSequence.homeTarget': 'IMPORT_LABEL_STEP_HOME',
  'afterPlaybackHomeStep.homeTarget': 'IMPORT_LABEL_STEP_HOME_LEGACY',
};

// The persisted warning remains byte-for-byte historical. The optional IPC
// envelope is transient; old projects are presented from their stable fields.
// Reading a step label from legacy prose affects presentation only.
export function presentImportWarning(warning, options) {
  if (warning?.userMessage) return presentUserMessage(warning.userMessage, options).message;
  if (rustMessageEnvelope(warning?.message)?.code) return presentUserMessage(warning.message, options).message;
  let detailCode = FIELD_LABELS[warning?.field];
  if (warning?.field === 'returnOnHome' && warning.message?.includes('destination Accueil du menu')) detailCode = 'IMPORT_LABEL_MENU_HOME';
  if (!detailCode) return presentUserMessage(warning?.message || { code: 'IMPORT_TRANSITION_UNMODELED_LEGACY', params: {} }, options).message;
  const label = warning.entryName || (warning.message?.startsWith('Entree importee —') || warning.entryName == null
    ? { code: 'IMPORT_LABEL_ENTRY', params: {} } : '');
  const target = warning.targetStageName?.trim() ? warning.targetStageName : warning.targetStageId;
  const hasTarget = target != null;
  const params = {};
  if (detailCode.startsWith('IMPORT_LABEL_STEP_')) {
    const prefix = `${warning.entryName || (typeof label === 'object' ? 'Entree importee' : '')} — `;
    const suffix = `${hasTarget ? ` vers « ${target} »` : ''} non modelisee.`;
    const legacyDetail = warning.message?.slice(prefix.length, -suffix.length) ?? '';
    params.stepName = legacyDetail.match(/l'etape (?:Â)?« ([\s\S]*) (?:Â)?»$/)?.[1] ?? '?';
  }
  return presentUserMessage({
    code: hasTarget ? 'IMPORT_TRANSITION_UNMODELED_WITH_TARGET' : 'IMPORT_TRANSITION_UNMODELED',
    params: {
      label,
      detail: { code: detailCode, params },
      ...(hasTarget ? { target } : {}),
    },
  }, options).message;
}
