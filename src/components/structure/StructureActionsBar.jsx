import { useCommonTranslation } from '../../i18n/commonPresentation.js';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  FilePlus,
  FolderInput,
  FolderPlus,
  Mic,
  Rss,
  Search,
  Speech,
  Youtube,
} from '../icons/LucideLocal';
import { LuniiIcon } from '../icons/LuniiIcon';
import { Tooltip } from '../common/Tooltip';
import { MEDIA_TOOL_ACTIONS, mediaToolActionIds } from '../../store/mediaToolSurface';
import { WORKSPACE_MODE_HIERARCHICAL } from '../../store/projectWorkState';
import {
  CANVAS_STRUCTURE_ACTION_SLOT_WIDTH,
  partitionStructureActions,
} from './structureActionLayout';
import { StructureActionsOverflow } from './StructureActionsOverflow';
import './StructureActionsBar.css';

function ActionIcon({ Icon }) {
  return <Icon className="structure-actions-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function StructureActionButton({ action }) {
  return (
    <Tooltip text={action.title} placement="below">
      <button
        type="button"
        className="structure-actions-btn"
        data-media-tool={action.id}
        aria-label={action.title}
        disabled={action.disabled}
        onClick={action.onClick}
      >
        {action.icon}
      </button>
    </Tooltip>
  );
}

// Déclencheur commun de la recherche de structure. L'arbre et la liste du
// graphe le montent dans la même barre : même dessin, même taille et même
// libellé de raccourci, sans recopier le bouton dans chaque panneau.
export function StructureSearchButton({
  onClick,
  label,
  tooltip,
}) {
  const { t } = useCommonTranslation();
  label ??= t('common:structure.search.label');
  tooltip ??= t('common:structure.search.tooltip', { label });
  return (
    <Tooltip text={tooltip} placement="below">
      <button
        type="button"
        className="tree-display-trigger tree-search-trigger"
        aria-label={label}
        onClick={onClick}
      >
        <Search className="tree-display-trigger-icon" strokeWidth={2.15} absoluteStrokeWidth />
      </button>
    </Tooltip>
  );
}

// `workspaceMode` dit quelles actions ont un objet ici : la barre ne reçoit pas
// une liste toute faite, elle la demande au modèle commun. Côté graphe, les
// trois actions d'arbre ne sont pas rendues — ni telles quelles, ni déguisées —
// et l'import de fichiers prend la forme qui a un sens : l'entrée dans la
// bibliothèque de médias (`onImportMedia`).
export function StructureActionsBar({
  variant = 'floating',
  workspaceMode = WORKSPACE_MODE_HIERARCHICAL,
  targetMenuId = null,
  onAddStory,
  onAddFolder,
  onImportFolder,
  onImportMedia,
  onImportPodcast,
  onImportYoutube,
  onRecord,
  onGenerateStoryTts,
  onLaunchSimulator,
  canAddStory = true,
  canAddFolder = true,
  canImportFolder = true,
  canImportMedia = true,
  canImportPodcast = true,
  canImportYoutube = true,
  canRecord = true,
  canGenerateStoryTts = true,
  canLaunchSimulator = true,
  label,
  ariaLabel,
  showLabel = false,
  trailing = null,
  availableInlineSize = null,
}) {
  const { t } = useCommonTranslation();
  label ??= t('common:structure.add.label');
  ariaLabel ??= t('common:structure.add.ariaLabel');
  const barRef = useRef(null);
  const [measuredInlineSize, setMeasuredInlineSize] = useState(null);
  const hasAvailableInlineSize = Number.isFinite(availableInlineSize);

  useLayoutEffect(() => {
    if (hasAvailableInlineSize) return undefined;
    const bar = barRef.current;
    if (!bar) return undefined;

    const update = () => setMeasuredInlineSize(Math.round(bar.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [hasAvailableInlineSize, variant]);

  // Le catalogue complet, dans l'ordre du modèle. Ce qui n'a pas de
  // gestionnaire n'est pas monté : c'est déjà ainsi que YouTube, la voix de
  // synthèse et le simulateur s'effacent quand l'hôte ne les tend pas.
  const catalog = {
    [MEDIA_TOOL_ACTIONS.IMPORT_STORY]: onAddStory && {
      title: t('common:structure.importStory.tooltip'),
      priority: 'primary',
      disabled: !canAddStory,
      onClick: () => onAddStory?.(targetMenuId),
      icon: <ActionIcon Icon={FilePlus} />,
    },
    [MEDIA_TOOL_ACTIONS.ADD_FOLDER]: onAddFolder && {
      title: t('common:structure.folder.create'),
      priority: 'primary',
      disabled: !canAddFolder,
      onClick: () => onAddFolder?.(targetMenuId),
      icon: <ActionIcon Icon={FolderPlus} />,
    },
    [MEDIA_TOOL_ACTIONS.IMPORT_FOLDER]: onImportFolder && {
      title: t('common:structure.folder.import'),
      priority: 'secondary',
      disabled: !canImportFolder,
      onClick: () => onImportFolder?.(targetMenuId),
      icon: <ActionIcon Icon={FolderInput} />,
    },
    [MEDIA_TOOL_ACTIONS.IMPORT_MEDIA]: onImportMedia && {
      title: t('common:structure.media.import'),
      priority: 'primary',
      disabled: !canImportMedia,
      onClick: onImportMedia,
      icon: <ActionIcon Icon={FilePlus} />,
    },
    [MEDIA_TOOL_ACTIONS.IMPORT_PODCAST]: onImportPodcast && {
      title: t('common:structure.podcast.add'),
      priority: 'secondary',
      disabled: !canImportPodcast,
      onClick: onImportPodcast,
      icon: <ActionIcon Icon={Rss} />,
    },
    [MEDIA_TOOL_ACTIONS.IMPORT_YOUTUBE]: onImportYoutube && {
      title: t('common:structure.youtube.import'),
      priority: 'secondary',
      disabled: !canImportYoutube,
      onClick: onImportYoutube,
      icon: <ActionIcon Icon={Youtube} />,
    },
    [MEDIA_TOOL_ACTIONS.RECORD]: onRecord && {
      title: t('common:structure.record.tooltip'),
      priority: 'secondary',
      disabled: !canRecord,
      onClick: onRecord,
      icon: <ActionIcon Icon={Mic} />,
    },
    [MEDIA_TOOL_ACTIONS.GENERATE_TTS]: onGenerateStoryTts && {
      title: t('common:structure.tts.create'),
      priority: 'secondary',
      disabled: !canGenerateStoryTts,
      onClick: onGenerateStoryTts,
      icon: <ActionIcon Icon={Speech} />,
    },
    [MEDIA_TOOL_ACTIONS.SIMULATOR]: onLaunchSimulator && {
      title: t('common:structure.simulator.launch'),
      priority: 'secondary',
      disabled: !canLaunchSimulator,
      onClick: onLaunchSimulator,
      icon: <LuniiIcon className="structure-actions-icon structure-actions-icon--lunii" />,
    },
  };

  const actions = mediaToolActionIds(workspaceMode)
    .map((id) => (catalog[id] ? { id, ...catalog[id] } : null))
    .filter(Boolean);
  const { directActions, overflowActions } = partitionStructureActions(actions, {
    variant,
    inlineSize: hasAvailableInlineSize ? availableInlineSize : measuredInlineSize,
    hasTrailing: Boolean(trailing),
    // Le trait entre deux cellules occupe lui aussi un pixel.
    slotWidth: variant === 'canvas' ? CANVAS_STRUCTURE_ACTION_SLOT_WIDTH : undefined,
    trailingSlots: variant === 'canvas' ? 1 : undefined,
  });

  return (
    <div
      ref={barRef}
      className={`structure-actions-bar structure-actions-bar--${variant}`}
      aria-label={ariaLabel}
    >
      {showLabel ? <span className="structure-actions-label">{label}</span> : null}
      {directActions.map((action) => <StructureActionButton key={action.id} action={action} />)}
      <StructureActionsOverflow actions={overflowActions} />
      {trailing ? <span className="structure-actions-trailing">{trailing}</span> : null}
    </div>
  );
}
