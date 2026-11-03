import { graphTranslationEngine } from '../../i18n/graphPresentation.js';
import { useTranslation } from 'react-i18next';
import { HelpHint } from '../common/HelpHint';
import { Select } from '../common/Select';
import { Dices } from '../icons/LucideLocal.jsx';
import { positionText } from './connectionRows.jsx';

// Une transition vers une Liste de choix ne réordonne jamais la liste : elle
// dit seulement sur quel choix on y **commence** — une occurrence précise, ou
// un tirage neuf à chaque déclenchement. La liste fixe l'ordre, l'Écran de
// départ choisit où l'on tombe. Les deux modes sont volontairement séparés pour ne pas faire
// passer « aléatoire » pour un choix supplémentaire de la liste.
// Pourquoi on choisit un point de départ alors que la liste a déjà son ordre :
// la question que se pose l'auteur, au même mot près partout où ce choix se
// fait.
export const LANDING_HELP = 'graph:landing.order.help';

export function ActionSelectionFields({
  id, options, index, selection, onChange, disabled,
}) {
  const { t } = useTranslation('graph', { i18n: graphTranslationEngine() });
  if (options.length <= 1) return null;

  const random = selection === 'random';
  const selectId = `${id}-fixed-choice`;

  return (
    <fieldset className="advanced-selection-mode">
      <legend>{t("graph:landing.start.legend")}{' '}<HelpHint text={t(LANDING_HELP)} /></legend>
      <label className={`advanced-selection-mode__option${!random ? ' is-selected' : ''}`}>
        <input
          type="radio"
          name={`${id}-mode`}
          value="fixed"
          checked={!random}
          disabled={disabled}
          onChange={() => onChange('0')}
        />
        <span>{t("graph:landing.fixed.label")}</span>
      </label>
      {!random && (
        <div className="advanced-selection-mode__fixed">
          <span id={`${selectId}-label`}>{t("graph:landing.fixed.start")}</span>
          <Select
            id={selectId}
            aria-labelledby={`${selectId}-label`}
            value={selection}
            disabled={disabled}
            onChange={onChange}
            options={options.map((option, rank) => ({
              value: String(rank),
              label: `${positionText(rank, options.length)} · ${option.target.stagePath
                ? index.byPath.get(option.target.stagePath)?.label.label ?? option.target.stageUuid
                : t("graph:landing.target.fallback")}`,
            }))}
          />
        </div>
      )}
      <label className={`advanced-selection-mode__option${random ? ' is-selected' : ''}`}>
        <input
          type="radio"
          name={`${id}-mode`}
          value="random"
          checked={random}
          disabled={disabled}
          onChange={() => onChange('random')}
        />
        <Dices aria-hidden="true" />
        <span>{t("graph:landing.random.label")}</span>
      </label>
    </fieldset>
  );
}
