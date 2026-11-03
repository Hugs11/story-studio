import { createElement } from 'react';
import { Trans } from 'react-i18next';
import i18next from 'i18next';
import { checkerEngine, translateChecker } from './checkerPresentation.js';
import { useMessageLanguage } from './useMessageLanguage.js';

// Composants du vérificateur et des rapports : suivre la langue active sans
// dépendre d'un Provider monté (bancs, popovers chargés à part).
export function useCheckerTranslation() {
  useMessageLanguage();
  return { t: translateChecker, language: i18next.resolvedLanguage ?? 'fr' };
}

// Libellé vivant confié à un dialogue commun qui le garde après son ouverture.
export function CheckerText({ messageKey, params }) {
  useMessageLanguage();
  return translateChecker(messageKey, params);
}

export function checkerText(messageKey, params) {
  return createElement(CheckerText, { messageKey, params });
}

// Texte riche : composants nommés seulement (strong, code, et composants de
// données auto-fermants comme <expected/>), jamais d'indice positionnel.
export function CheckerTrans({ i18nKey, count, values, components }) {
  useMessageLanguage();
  return createElement(Trans, { i18n: checkerEngine(), i18nKey, count, values, components });
}
