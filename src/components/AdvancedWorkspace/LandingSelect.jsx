import { graphTranslationEngine } from '../../i18n/graphPresentation.js';
import { useTranslation } from 'react-i18next';
// « commence sur [choix ▾] » : le choix sur lequel un Écran ouvre une liste,
// réglable sur place, depuis le panneau de l'Écran comme depuis celui de la
// liste. La liste garde son ordre ; c'est l'Écran de départ qui dit où l'on
// tombe. Un départ illisible ou absent reste affiché tel quel, jamais remplacé
// en silence.

import { HelpHint } from '../common/HelpHint';
import { Select } from '../common/Select';
import { LANDING_HELP } from './ActionSelectionFields.jsx';
import { positionText } from './connectionRows.jsx';
import { RANDOM_OPTION_INDEX, advancedGestures } from '../../store/projectModel/advancedGestures.js';

// Le geste qui fait ouvrir la liste `actionId` sur le choix `value` (un rang,
// ou 'random') par la sortie `slot` de l'Écran `stageUuid`.
export function landingGesture(stageUuid, slot, actionId, value) {
  return advancedGestures.setStageTransition(
    stageUuid,
    slot,
    advancedGestures.transitionTo(actionId, value === 'random' ? RANDOM_OPTION_INDEX : Number(value)),
  );
}

// `choices` : les choix de la liste, dans son ordre — `{ key, rank, label }`.
export function LandingSelect({ id, landing, choices, disabled, onChange }) {
  const { t } = useTranslation('graph', { i18n: graphTranslationEngine() });
  const count = choices.length;
  let value = '';
  if (landing.random) value = 'random';
  else if (Number.isInteger(landing.rank) && !landing.missing) value = String(landing.rank);
  // Un seul choix : il n'y a rien à régler, et « au hasard » tomberait
  // toujours dessus. Le menu ne reste que pour montrer une valeur importée
  // qui n'est pas ce choix (hasard, départ illisible ou absent).
  if (count === 1 && value === '0') return null;
  const offersRandom = count > 1 || value === 'random';
  return (
    <div className="advanced-exit__landing">
      {/* Le « ? » avant le libellé : entre « commence sur » et le choix, il
          couperait la lecture du réglage. */}
      <span className="advanced-exit__landing-label">
        <HelpHint text={t(LANDING_HELP)} />
        <label htmlFor={id} className="advanced-options__verb">{t("graph:landing.select.start")}</label>
      </span>
      <Select
        id={id}
        className="advanced-exit__landing-select"
        value={value}
        disabled={disabled}
        onChange={onChange}
        placeholder={value === '' ? (landing.unknown ? t("graph:landing.select.unknown") : t('graph:landing.select.missing', { position: positionText(landing.rank, count) })) : ''}
        options={[
          ...choices.map((choice) => ({
            value: String(choice.rank),
            label: `${positionText(choice.rank, count)} · ${choice.label ?? t('graph:landing.target.fallback')}`,
          })),
          ...(offersRandom ? [{ value: 'random', label: t("graph:landing.select.random") }] : []),
        ]}
      />
    </div>
  );
}
