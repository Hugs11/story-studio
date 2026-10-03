// Choisir un nœud, explicitement.
//
// Aucune cible n'est jamais préremplie par défaut : ni le premier Écran venu,
// ni `Fixed(0)`. Le glisser de liaison peut préremplir le formulaire mais ne
// choisit pas un `Fixed(0)` implicite, et la même règle vaut pour tout choix de
// destination.
//
// Le sélecteur travaille sur l'index de lecture, jamais sur ce que le moteur a
// dessiné : un nœud détaché, hors viewport ou invisible au zoom courant reste
// choisissable, au clavier comme à la souris.

import { useMemo, useState } from 'react';

import { searchGraph } from '../../store/advancedGraphView/graphSearch.js';
import { isEntryStage } from '../../store/advancedGraphView/graphViewModel.js';

const PLACEHOLDER = '— choisir —';

export function NodePicker({
  index,
  kind,
  value,
  onChange,
  id,
  disabled = false,
  emptyLabel = PLACEHOLDER,
  excludePaths = [],
  // Le sélecteur choisit le **choix d'une liste** : l'Écran d'entrée n'y
  // figure pas, il n'est jamais une destination.
  forChoice = false,
}) {
  const [query, setQuery] = useState('');
  const excluded = useMemo(() => new Set(excludePaths), [excludePaths]);

  const results = useMemo(() => {
    if (!index) return [];
    const found = searchGraph(index, { query, scope: kind, limit: 60 });
    return found.results.filter((entry) => !excluded.has(entry.path) && !(forChoice && isEntryStage(entry)));
  }, [index, query, kind, excluded, forChoice]);

  // La valeur courante reste dans la liste même si la recherche l'exclut :
  // sinon un filtre effacerait silencieusement le choix déjà fait.
  const selected = value ? index?.byPath.get(value) ?? null : null;
  const options = selected && !results.some((entry) => entry.path === value)
    ? [selected, ...results]
    : results;

  return (
    <div className="advanced-picker">
      <input
        type="search"
        className="advanced-picker__query"
        value={query}
        placeholder="Filtrer par nom ou identifiant"
        aria-label="Filtrer les nœuds proposés"
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        id={id}
        className="advanced-picker__select"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{emptyLabel}</option>
        {options.map((entry) => (
          <option key={entry.path} value={entry.path}>
            {entry.label.label}
            {entry.label.isFallback ? ' (sans nom)' : ''}
            {entry.node.uniqueId === false ? ' — identifiant dupliqué' : ''}
          </option>
        ))}
      </select>
      {selected?.node.uniqueId === false && (
        // Le refus est expliqué **avant** le geste : un identifiant dupliqué
        // n'est pas adressable, et le dire après coup serait l'essuyer.
        <p className="advanced-field__warning">
          Ce nœud porte un identifiant dupliqué : le geste le refusera tant que le doublon
          n'est pas résolu.
        </p>
      )}
    </div>
  );
}
