import { useLayoutEffect, useRef, useState } from 'react';
import {
  FilePlus,
  FolderInput,
  FolderPlus,
  Mic,
  Rss,
  Speech,
  Youtube,
} from '../icons/LucideLocal';
import { LuniiIcon } from '../icons/LuniiIcon';
import { Tooltip } from '../common/Tooltip';
import { partitionStructureActions } from './structureActionLayout';
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
        aria-label={action.title}
        disabled={action.disabled}
        onClick={action.onClick}
      >
        {action.icon}
      </button>
    </Tooltip>
  );
}

export function StructureActionsBar({
  variant = 'floating',
  targetMenuId = null,
  onAddStory,
  onAddFolder,
  onImportFolder,
  onImportPodcast,
  onImportYoutube,
  onRecord,
  onGenerateStoryTts,
  onLaunchSimulator,
  canAddStory = true,
  canAddFolder = true,
  canImportFolder = true,
  canImportPodcast = true,
  canImportYoutube = true,
  canRecord = true,
  canGenerateStoryTts = true,
  canLaunchSimulator = true,
  showLabel = false,
  trailing = null,
  availableInlineSize = null,
}) {
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

  const actions = [
    {
      id: 'import-story',
      title: 'Importer audio, ZIP ou 7z',
      priority: 'primary',
      disabled: !canAddStory,
      onClick: () => onAddStory?.(targetMenuId),
      icon: <ActionIcon Icon={FilePlus} />,
    },
    {
      id: 'add-folder',
      title: 'Créer un dossier',
      priority: 'primary',
      disabled: !canAddFolder,
      onClick: () => onAddFolder?.(targetMenuId),
      icon: <ActionIcon Icon={FolderPlus} />,
    },
    {
      id: 'import-folder',
      title: 'Importer un dossier',
      priority: 'secondary',
      disabled: !canImportFolder,
      onClick: () => onImportFolder?.(targetMenuId),
      icon: <ActionIcon Icon={FolderInput} />,
    },
    {
      id: 'import-podcast',
      title: 'Ajouter un podcast',
      priority: 'secondary',
      disabled: !canImportPodcast,
      onClick: onImportPodcast,
      icon: <ActionIcon Icon={Rss} />,
    },
    ...(onImportYoutube ? [{
      id: 'import-youtube',
      title: 'Importer depuis YouTube',
      priority: 'secondary',
      disabled: !canImportYoutube,
      onClick: onImportYoutube,
      icon: <ActionIcon Icon={Youtube} />,
    }] : []),
    {
      id: 'record',
      title: 'Enregistrer une histoire avec le micro',
      priority: 'secondary',
      disabled: !canRecord,
      onClick: onRecord,
      icon: <ActionIcon Icon={Mic} />,
    },
    ...(onGenerateStoryTts ? [{
      id: 'generate-tts',
      title: 'Créer une histoire avec TTS',
      priority: 'secondary',
      disabled: !canGenerateStoryTts,
      onClick: onGenerateStoryTts,
      icon: <ActionIcon Icon={Speech} />,
    }] : []),
    ...(onLaunchSimulator ? [{
      id: 'simulator',
      title: 'Lancer le simulateur',
      priority: 'secondary',
      disabled: !canLaunchSimulator,
      onClick: onLaunchSimulator,
      icon: <LuniiIcon className="structure-actions-icon structure-actions-icon--lunii" />,
    }] : []),
  ];
  const { directActions, overflowActions } = partitionStructureActions(actions, {
    variant,
    inlineSize: hasAvailableInlineSize ? availableInlineSize : measuredInlineSize,
  });

  return (
    <div
      ref={barRef}
      className={`structure-actions-bar structure-actions-bar--${variant}`}
      aria-label="Ajouter à la structure"
    >
      {showLabel ? <span className="structure-actions-label">Ajouter</span> : null}
      {directActions.map((action) => <StructureActionButton key={action.id} action={action} />)}
      <StructureActionsOverflow actions={overflowActions} />
      {trailing ? <span className="structure-actions-trailing">{trailing}</span> : null}
    </div>
  );
}
