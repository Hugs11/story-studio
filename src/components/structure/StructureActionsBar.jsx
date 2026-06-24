import {
  FilePlus,
  FolderInput,
  FolderPlus,
  Mic,
  Rss,
  Youtube,
} from '../icons/LucideLocal';
import { LuniiIcon } from '../icons/LuniiIcon';
import { Tooltip } from '../common/Tooltip';
import './StructureActionsBar.css';

function ActionIcon({ Icon }) {
  return <Icon className="structure-actions-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function StructureActionButton({ title, onClick, disabled, children }) {
  return (
    <Tooltip text={title} placement="below">
      <button
        type="button"
        className="structure-actions-btn"
        aria-label={title}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
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
  onLaunchSimulator,
  canAddStory = true,
  canAddFolder = true,
  canImportFolder = true,
  canImportPodcast = true,
  canImportYoutube = true,
  canRecord = true,
  canLaunchSimulator = true,
  showLabel = false,
  trailing = null,
}) {
  return (
    <div className={`structure-actions-bar structure-actions-bar--${variant}`} aria-label="Ajouter à la structure">
      {showLabel ? <span className="structure-actions-label">Ajouter</span> : null}
      <StructureActionButton
        title="Importer une histoire (fichier audio / pack zip)"
        disabled={!canAddStory}
        onClick={() => onAddStory?.(targetMenuId)}
      >
        <ActionIcon Icon={FilePlus} />
      </StructureActionButton>
      <StructureActionButton
        title="Créer un dossier"
        disabled={!canAddFolder}
        onClick={() => onAddFolder?.(targetMenuId)}
      >
        <ActionIcon Icon={FolderPlus} />
      </StructureActionButton>
      <StructureActionButton
        title="Importer un dossier"
        disabled={!canImportFolder}
        onClick={() => onImportFolder?.(targetMenuId)}
      >
        <ActionIcon Icon={FolderInput} />
      </StructureActionButton>
      <StructureActionButton
        title="Ajouter un podcast"
        disabled={!canImportPodcast}
        onClick={onImportPodcast}
      >
        <ActionIcon Icon={Rss} />
      </StructureActionButton>
      {onImportYoutube ? (
        <StructureActionButton
          title="Importer depuis YouTube"
          disabled={!canImportYoutube}
          onClick={onImportYoutube}
        >
          <ActionIcon Icon={Youtube} />
        </StructureActionButton>
      ) : null}
      <StructureActionButton
        title="Enregistrer une histoire avec le micro"
        disabled={!canRecord}
        onClick={onRecord}
      >
        <ActionIcon Icon={Mic} />
      </StructureActionButton>
      {onLaunchSimulator ? (
        <StructureActionButton
          title="Lancer le simulateur"
          disabled={!canLaunchSimulator}
          onClick={onLaunchSimulator}
        >
          <LuniiIcon className="structure-actions-icon structure-actions-icon--lunii" />
        </StructureActionButton>
      ) : null}
      {trailing ? <span className="structure-actions-trailing">{trailing}</span> : null}
    </div>
  );
}
