import { HelpHint } from '../common/HelpHint';
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
export const LANDING_HELP = 'La liste garde l’ordre que vous lui avez donné. Ce réglage dit seulement sur quel choix on tombe en arrivant par ce chemin ; en tournant la molette, on retrouve ensuite l’ordre de la liste.';

export function ActionSelectionFields({
  id, options, index, selection, onChange, disabled,
}) {
  if (options.length <= 1) return null;

  const random = selection === 'random';
  const selectId = `${id}-fixed-choice`;

  return (
    <fieldset className="advanced-selection-mode">
      <legend>Point de départ dans la liste <HelpHint text={LANDING_HELP} /></legend>
      <label className={`advanced-selection-mode__option${!random ? ' is-selected' : ''}`}>
        <input
          type="radio"
          name={`${id}-mode`}
          value="fixed"
          checked={!random}
          disabled={disabled}
          onChange={() => onChange('0')}
        />
        <span>Toujours le même choix</span>
      </label>
      {!random && (
        <label className="advanced-selection-mode__fixed" htmlFor={selectId}>
          <span>Commence sur</span>
          <select
            id={selectId}
            value={selection}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map((option, rank) => (
              <option key={option.optionId} value={String(rank)}>
                {positionText(rank, options.length)} · {option.target.stagePath
                  ? index.byPath.get(option.target.stagePath)?.label.label ?? option.target.stageUuid
                  : 'Écran à choisir'}
              </option>
            ))}
          </select>
        </label>
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
        <span>Un choix au hasard, à chaque fois</span>
      </label>
    </fieldset>
  );
}
