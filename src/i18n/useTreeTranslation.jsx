import i18next from 'i18next';
import { useMessageLanguage } from './useMessageLanguage.js';
import { presentTree, translateTree } from './treePresentation.js';
export function useTreeTranslation() {
  useMessageLanguage();
  return { t: translateTree, present: presentTree, language: i18next.resolvedLanguage ?? 'fr' };
}
export function TreeText({ messageKey, params }) {
  useMessageLanguage();
  return translateTree(messageKey, params);
}
