import { useMessageLanguage } from './useMessageLanguage.js';
import { translateHome } from './homePresentation.js';

export function useHomeTranslation() {
  useMessageLanguage();
  return { t: translateHome };
}

// Un titre React reste vivant quand un dialogue conserve l'objet d'erreur.
export function HomeText({ messageKey, params }) {
  useMessageLanguage();
  return translateHome(messageKey, params);
}
