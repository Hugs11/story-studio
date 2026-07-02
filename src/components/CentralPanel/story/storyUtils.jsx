import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  NAV_TARGET_NEXT_STORY,
  decodeNavigationMenuId,
  encodeMenuNavigationTarget,
  encodeStoryHomeStepNavigationTarget,
  encodeStoryNavigationTarget,
  encodeStoryPlayNavigationTarget,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryNavigationTarget,
  normalizeNavigationTarget,
} from '../../../store/navigationTargets';
import { CircleX, FolderOpen, Link2, Music, Play } from '../../icons/LucideLocal';

export { NAV_TARGET_NEXT_STORY };

export const NAV_ROOT_LABEL = 'Menu racine';

export function generatedTargetIdToSelectValue(targetId) {
  if (!targetId || isRootNavigationTarget(targetId)) return '';
  if (isStoryNavigationTarget(targetId) || isNextStoryNavigationTarget(targetId)) return targetId;
  return encodeMenuNavigationTarget(targetId);
}

const NAV_ICON_BY_KIND = {
  default: Link2,
  none: CircleX,
  root: FolderOpen,
  menu: FolderOpen,
  story: Music,
  story_play: Play,
  story_home_step: Music,
};

function iconForKind(kind) {
  return NAV_ICON_BY_KIND[kind] ?? null;
}

function buildNavigationTargetOptions({
  value,
  allMenus = [],
  allStories = [],
  currentStoryId = null,
  allowCurrentStory = false,
  includeNone = false,
  noneLabel = 'Aucune transition',
  emptyLabel = 'Choisir une destination',
  includeDefault = true,
  includeNextStory = true,
  includeStoryPlay = true,
}) {
  const options = [];
  if (value === '__mixed__') {
    options.push({
      value: '__mixed__',
      label: 'Valeurs mixtes — ne pas modifier',
      kind: 'default',
      disabled: true,
    });
  }
  if (includeDefault) {
    options.push({ value: '', label: emptyLabel, kind: 'default' });
  }
  if (includeNone) options.push({ value: '__none__', label: noneLabel, kind: 'none' });
  if (includeNextStory) {
    options.push({ value: NAV_TARGET_NEXT_STORY, label: 'Histoire suivante', kind: 'story' });
  }
  for (const menu of allMenus) {
    options.push({
      value: encodeMenuNavigationTarget(menu.id),
      label: menu.name || '(sans nom)',
      kind: 'menu',
    });
  }
  const selectableStories = allStories.filter((s) => allowCurrentStory || s.id !== currentStoryId);
  for (const story of selectableStories) {
    options.push({
      value: encodeStoryNavigationTarget(story.id),
      label: story.name || '(sans nom)',
      kind: 'story',
    });
  }
  if (includeStoryPlay) {
    for (const story of selectableStories) {
      options.push({
        value: encodeStoryPlayNavigationTarget(story.id),
        label: `Lecture directe - ${story.name || '(sans nom)'}`,
        kind: 'story_play',
      });
    }
  }
  for (const story of allStories.filter((s) => s.id !== currentStoryId && s.hasAfterPlaybackHomeStep)) {
    options.push({
      value: encodeStoryHomeStepNavigationTarget(story.id),
      label: `Retour de fin - ${story.name || '(sans nom)'}`,
      kind: 'story_home_step',
    });
  }
  return options;
}

export const CONTROL_DEFS = [
  { key: 'autoplay', label: 'Lecture automatique', def: true },
  { key: 'ok',       label: 'Bouton OK',            def: true },
  { key: 'home',     label: 'Bouton Accueil',        def: true },
  { key: 'pause',    label: 'Bouton pause',          def: false },
  { key: 'wheel',    label: 'Molette',               def: false },
];

export const SEQUENCE_CONTROL_DEFAULTS = {
  autoplay: true,
  ok: false,
  home: true,
  pause: false,
  wheel: false,
};

export function normalizeSequenceStep(step = {}, index = 0) {
  const controls = step.controlSettings ?? {};
  return {
    id: step.id || crypto.randomUUID(),
    name: step.name || `Étape ${index + 1}`,
    audio: step.audio ?? null,
    image: step.image ?? null,
    controlSettings: { ...SEQUENCE_CONTROL_DEFAULTS, ...controls },
    okTarget: normalizeNavigationTarget(step.okTarget),
    okChoiceTargets: Array.isArray(step.okChoiceTargets)
      ? step.okChoiceTargets.map(normalizeNavigationTarget).filter(Boolean)
      : [],
    homeTarget: normalizeNavigationTarget(step.homeTarget),
    homeFollowsOk: !!step.homeFollowsOk,
    homeNone: !!step.homeNone,
  };
}

export function resolveNavigationTargetId(target, currentMenuId = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isCurrentMenuNavigationTarget(normalized)) return currentMenuId ?? null;
  if (isNextStoryNavigationTarget(normalized)) return NAV_TARGET_NEXT_STORY;
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

// Calcule le texte de destination effective pour les résumés de parcours.
// - Pour un value vide ou "root" → renvoie le défaut résolu (ex: "Quelle histoire...").
// - Pour "next_story" → renvoie soit le nom de l'histoire suivante si entry est fourni, soit la mention contextuelle.
// - Pour un menu/story explicite → null (pas de hint nécessaire).
//
// Le caller passe `emptyResolvedLabel` qui décrit ce que "vide" signifie dans son contexte
// (héritage parent vs premier élément du pack vs etc).
export function getNavigationSelectHint({
  value,
  emptyResolvedLabel = null,
  entry = null,
  parentMenu = null,
  project = null,
}) {
  const normalized = normalizeNavigationTarget(value);
  if (!normalized) return emptyResolvedLabel;
  if (isRootNavigationTarget(normalized)) {
    const def = project?.rootEntries?.[0];
    if (!def) return 'Aucune entrée dans le pack';
    return `${def.name || '(sans nom)'} (premier élément du pack)`;
  }
  if (isNextStoryNavigationTarget(normalized)) {
    if (!entry) return 'Histoire suivante selon l\'histoire source';
    const siblings = parentMenu ? (parentMenu.children ?? []) : (project?.rootEntries ?? []);
    const idx = siblings.findIndex((s) => s.id === entry.id);
    const next = idx >= 0 ? siblings.slice(idx + 1).find((s) => s.type === 'story') : null;
    if (next) return next.name || '(sans nom)';
    // Fallback Rust : si pas d'histoire suivante, retour vers le parent
    return parentMenu ? `${parentMenu.name || '(sans nom)'} (parent)` : NAV_ROOT_LABEL;
  }
  // Explicite — la valeur affichée dans le select est déjà la destination
  return null;
}

export function NavigationTargetSelect({
  value,
  onChange,
  allMenus,
  allStories,
  currentStoryId,
  allowCurrentStory = false,
  includeNone = false,
  noneLabel = 'Aucune transition',
  emptyLabel = 'Choisir une destination',
  includeDefault = true,
  resolvedDefaultValue = null,
  resolvedDefaultLabel = null,
  resolvedDefaultKind = 'default',
  hideDefaultWhenResolved = false,
  style,
  includeNextStory = true,
  includeStoryPlay = true,
  size = 'default',
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const listboxId = useId();
  const rawSelectedValue = value ?? '';
  const normalizedResolvedValue = resolvedDefaultValue
    ? normalizeNavigationTarget(resolvedDefaultValue)
    : null;
  const baseOptions = useMemo(
    () => buildNavigationTargetOptions({
      value: rawSelectedValue,
      allMenus,
      allStories,
      currentStoryId,
      allowCurrentStory,
      includeNone,
      noneLabel,
      emptyLabel,
      includeDefault,
      includeNextStory,
      includeStoryPlay,
    }),
    [
      rawSelectedValue,
      allMenus,
      allStories,
      currentStoryId,
      allowCurrentStory,
      includeNone,
      noneLabel,
      emptyLabel,
      includeDefault,
      includeNextStory,
      includeStoryPlay,
    ],
  );
  // Un « vrai » choix correspond à une ligne concrète de la liste (menu, histoire,
  // « Histoire suivante »…). Les cibles virtuelles (racine, dossier courant) et la
  // valeur vide n'ont pas de ligne dédiée : on les résout vers leur destination réelle
  // pour ne jamais afficher un libellé abstrait dans le déclencheur.
  const rawMatchesConcreteOption = !!rawSelectedValue
    && baseOptions.some((option) => option.value === rawSelectedValue && option.value !== '');
  const useResolvedValue = !!(normalizedResolvedValue && !rawMatchesConcreteOption);
  const selectedValue = useResolvedValue ? normalizedResolvedValue : rawSelectedValue;
  const hideResolvedDefault = !!(includeDefault && hideDefaultWhenResolved && useResolvedValue);
  const options = useMemo(
    () => (hideResolvedDefault
      ? baseOptions.filter((option) => option.value !== '')
      : baseOptions),
    [baseOptions, hideResolvedDefault],
  );
  const resolvedSelectedOption = useResolvedValue
    ? {
      value: normalizedResolvedValue,
      label: resolvedDefaultLabel || emptyLabel,
      kind: resolvedDefaultKind || 'default',
    }
    : null;
  const selectableOptions = useMemo(
    () => options.filter((option) => !option.disabled),
    [options],
  );
  const selectedOption = options.find((option) => option.value === selectedValue)
    ?? resolvedSelectedOption
    ?? options.find((option) => option.value === '')
    ?? options[0];
  const SelectedIcon = iconForKind(selectedOption?.kind);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = selectableOptions.findIndex((option) => option.value === selectedValue);
    setActiveIndex(Math.max(0, selectedIndex));
  }, [open, selectableOptions, selectedValue]);

  useEffect(() => {
    if (!open) return;
    const activeOption = rootRef.current?.querySelector(`[data-option-index="${activeIndex}"]`);
    activeOption?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const selectOption = (option) => {
    if (!option || option.disabled) return;
    onChange(option.value || null);
    setOpen(false);
  };

  const moveActive = (delta) => {
    if (selectableOptions.length === 0) return;
    setActiveIndex((current) => (current + delta + selectableOptions.length) % selectableOptions.length);
  };

  const handleKeyDown = (event) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, selectableOptions.length - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectOption(selectableOptions[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const activeOptionId = open && selectableOptions[activeIndex]
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className="navigation-target-select" style={style}>
      <div
        ref={rootRef}
        className={`navigation-listbox ${open ? 'is-open' : ''} ${size === 'compact' ? 'is-compact' : ''}`}
      >
        <button
          type="button"
          className="navigation-listbox-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={handleKeyDown}
        >
          {SelectedIcon ? <SelectedIcon className="navigation-listbox-icon" strokeWidth={2} /> : null}
          <span className="navigation-listbox-label">{selectedOption?.label ?? emptyLabel}</span>
          <span className="navigation-listbox-chevron" aria-hidden="true">⌄</span>
        </button>
        {open ? (
          <div id={listboxId} className="navigation-listbox-popover" role="listbox" tabIndex={-1}>
            {options.map((option) => {
              const optionIndex = selectableOptions.findIndex((candidate) => candidate.value === option.value);
              const isActive = optionIndex === activeIndex;
              const isSelected = option.value === selectedValue;
              const Icon = iconForKind(option.kind);
              return (
                <div key={`${option.value || 'empty'}:${option.label}`}>
                  <button
                    type="button"
                    role="option"
                    id={optionIndex >= 0 ? `${listboxId}-option-${optionIndex}` : undefined}
                    data-option-index={optionIndex >= 0 ? optionIndex : undefined}
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    className={`navigation-listbox-option ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}`}
                    onMouseEnter={() => {
                      if (optionIndex >= 0) setActiveIndex(optionIndex);
                    }}
                    onClick={() => selectOption(option)}
                  >
                    {Icon ? <Icon className="navigation-listbox-icon" strokeWidth={2} /> : null}
                    <span className="navigation-listbox-label">{option.label}</span>
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
