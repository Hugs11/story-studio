import { graphTranslationEngine } from '../../i18n/graphPresentation.js';
import { useTranslation } from 'react-i18next';
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

import { Select } from '../common/Select';
import { searchGraph } from '../../store/advancedGraphView/graphSearch.js';
import { isEntryStage } from '../../store/advancedGraphView/graphViewModel.js';


export function NodePicker({
  index,
  kind,
  value,
  onChange,
  id,
  disabled = false,
  emptyLabel = null,
  excludePaths = [],
  // Le sélecteur choisit le **choix d'une liste** : l'Écran d'entrée n'y
  // figure pas, il n'est jamais une destination.
  forChoice = false,
}) {
  const { t } = useTranslation('graph', { i18n: graphTranslationEngine() });
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
        placeholder={t("graph:picker.filter.placeholder")}
        aria-label={t("graph:picker.filter.aria")}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Select
        id={id}
        className="advanced-picker__select"
        value={value ?? ''}
        disabled={disabled}
        onChange={(path) => onChange(path || null)}
        options={[
          { value: '', label: emptyLabel ?? t('graph:picker.choice.placeholder') },
          ...options.map((entry) => ({
            value: entry.path,
            label: entry.label.isFallback
              ? entry.node.uniqueId === false
                ? t('graph:picker.option.unnamedDuplicate', { name: entry.label.label })
                : t('graph:picker.option.unnamed', { name: entry.label.label })
              : entry.node.uniqueId === false
                ? t('graph:picker.option.duplicate', { name: entry.label.label })
                : entry.label.label,
          })),
        ]}
      />
      {selected?.node.uniqueId === false && (
        // Le refus est expliqué **avant** le geste : un identifiant dupliqué
        // n'est pas adressable, et le dire après coup serait l'essuyer.
        <p className="advanced-field__warning">{t("graph:picker.duplicate.warning")}</p>
      )}
    </div>
  );
}
