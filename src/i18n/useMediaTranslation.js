import i18next from 'i18next';
import { translateMedia } from './mediaPresentation.js';
import { useMessageLanguage } from './useMessageLanguage.js';

// Composants du domaine Médias : suivre la langue active sans dépendre d’un
// Provider monté. Séparé du présentateur pur, qui ne charge pas React.
export function useMediaTranslation() {
  useMessageLanguage();
  return { t: translateMedia, language: i18next.resolvedLanguage ?? 'fr' };
}
