import { graphTranslationEngine } from '../../i18n/graphPresentation.js';
import { useTranslation } from 'react-i18next';
// Simuler depuis une Action : choisir d'abord où l'on part.
//
// Une Action n'est pas un point de départ. Le simulateur part d'un **Écran**, et
// une Action mène à plusieurs — une par occurrence d'option, dans leur ordre.
// Il faut proposer le choix d'une destination exploitable avant
// la simulation, respecter les occurrences et leur ordre, et **ne pas inventer un
// départ implicite**. Prendre la première occurrence en silence serait
// exactement l'invention interdite.
//
// Ce qui est offert n'est donc pas un sélecteur de nœud libre : c'est la liste
// des occurrences **de cette Action**, chacune avec sa destination réelle, et
// celles qui ne mènent nulle part sont dites au lieu d'être cachées.

import { useMemo, useState } from 'react';

import { AdvancedDialog } from './AdvancedDialog.jsx';

// Les occurrences d'une Action, dans leur ordre, avec l'état de leur
// destination. Pure : éprouvable sans monter d'interface.
//
// L'ordre est celui du rang d'occurrence, pas celui du tableau d'arêtes : c'est
// le rang qui fait l'identité d'une occurrence dans le dialecte, et deux
// occurrences vers le même Écran restent **deux** entrées distinctes.
export function actionDestinations(index, path) {
  const edges = index?.outgoing.get(path) ?? [];
  return [...edges]
    .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))
    .map((edge) => {
      const target = edge.to ? index?.byPath.get(edge.to) ?? null : null;
      // Trois états distincts, et ils ne se confondent pas : une destination
      // absente du document (`null`), une destination désignée mais introuvable
      // (pendante), et une destination exploitable.
      const state = edge.to === null || edge.to === undefined
        ? 'null'
        : (edge.dangling === true || target === null) ? 'dangling' : 'ready';
      return {
        ordinal: edge.ordinal ?? 0,
        edgeId: edge.edgeId,
        optionId: edge.optionId ?? null,
        targetPath: state === 'ready' ? edge.to : null,
        label: target?.label?.label ?? null,
        isFallback: target?.label?.isFallback === true,
        random: edge.selection?.kind === 'random',
        state,
      };
    });
}

const STATE_TEXT = {
  null: 'graph:listen.choice.empty',
  dangling: 'graph:listen.choice.missing',
};

export function ListenFromActionDialog({ inspected, index, onCancel, onListen }) {
  const { t } = useTranslation('graph', { i18n: graphTranslationEngine() });
  const destinations = useMemo(() => actionDestinations(index, inspected.path), [index, inspected.path]);
  const ready = destinations.filter((one) => one.state === 'ready');
  // Aucune présélection, même quand une seule destination est exploitable :
  // c'est l'auteur qui désigne son point de départ.
  const [chosen, setChosen] = useState(null);

  return (
    <AdvancedDialog
      title={t('graph:listen.dialog.title', { name: inspected.label.label })}
      description={
        ready.length === 0
          ? t("graph:listen.dialog.empty")
          : t("graph:listen.dialog.description")
      }
      onCancel={onCancel}
      onConfirm={chosen ? () => onListen(chosen) : null}
      confirmLabel={t("graph:listen.dialog.confirm")}
      confirmDisabled={!chosen}
    >
      <ol className="advanced-listen-choices">
        {destinations.map((one) => (
          <li key={one.edgeId} className={`advanced-listen-choice is-${one.state}`}>
            {one.state === 'ready' ? (
              <label>
                <input
                  type="radio"
                  name="listen-from-action"
                  value={one.targetPath}
                  checked={chosen === one.targetPath}
                  onChange={() => setChosen(one.targetPath)}
                />
                <span className="advanced-listen-choice__rank">{t('graph:listen.choice.occurrence', { ordinal: one.ordinal + 1 })}</span>
                <span className="advanced-listen-choice__target">
                  {one.label}
                  {one.isFallback && <em>{t("graph:picker.name.fallback")}</em>}
                </span>
              </label>
            ) : (
              <>
                <span className="advanced-listen-choice__rank">{t('graph:listen.choice.occurrence', { ordinal: one.ordinal + 1 })}</span>
                <span className="advanced-listen-choice__reason">{t(STATE_TEXT[one.state])}</span>
              </>
            )}
          </li>
        ))}
        {destinations.length === 0 && (
          <li className="advanced-listen-choice is-null">
            <span className="advanced-listen-choice__reason">{t("graph:listen.list.empty")}</span>
          </li>
        )}
      </ol>
    </AdvancedDialog>
  );
}
