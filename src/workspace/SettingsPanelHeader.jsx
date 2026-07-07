import { X } from '../components/icons/LucideLocal';
import {
  IconArchive,
  IconArrowRight,
  IconFolderOpen,
  IconHouse,
  IconMoon,
  IconStop,
  IconStory,
} from '../components/TreePanel/TreeIcons';
import { END_NODE_ID, TYPE_LABELS } from '../components/CentralPanel/flowDiagramLayout';

function NodeTypeIcon({ type, icon }) {
  if (type === 'root') return <IconHouse />;
  if (type === 'menu') return <IconFolderOpen />;
  if (type === 'story') return <IconStory />;
  if (type === 'zip') return <IconArchive />;
  if (type === 'ref') return <IconArrowRight />;
  if (type === END_NODE_ID || type === 'end-node') return icon === 'moon' ? <IconMoon /> : <IconStop />;
  return <IconHouse />;
}

function getHeaderData({ node, selectedId, selectedIds, project }) {
  if (selectedIds?.size > 1) {
    return {
      type: 'multi',
      title: `${selectedIds.size} éléments sélectionnés`,
      badge: 'Modification groupée',
      icon: null,
    };
  }
  if (selectedId === END_NODE_ID) {
    return {
      type: END_NODE_ID,
      title: project?.endNodeName || 'Message de fin',
      badge: TYPE_LABELS[END_NODE_ID],
      icon: project?.globalOptions?.nightMode ? 'moon' : 'stop',
    };
  }
  if (!node) {
    return {
      type: 'root',
      title: 'Réglages',
      badge: 'Sélection',
      icon: null,
    };
  }
  const type = node.type === 'root' ? 'root' : node.type;
  const rootTitle = project?.projectType === 'simple'
    ? (project?.projectName || 'Mon histoire')
    : (project?.rootName || project?.projectName || 'Menu racine');
  // Badge du root : dépend du type de projet — « Histoire simple » en `simple`
  // (le header est visible dans l'éditeur simple sans diagramme depuis le plan G),
  // « Pack » sinon. « Histoire » seul serait ambigu avec TYPE_LABELS.story.
  const rootBadge = project?.projectType === 'simple' ? 'Histoire simple' : 'Pack';
  return {
    type,
    title: type === 'root' ? rootTitle : (node.name || TYPE_LABELS[type] || 'Réglages'),
    badge: type === 'root' ? rootBadge : (TYPE_LABELS[type] || 'Réglages'),
    icon: node.icon ?? null,
  };
}

export function SettingsPanelHeader({
  node,
  selectedId,
  selectedIds,
  project,
  onClose = null,
}) {
  const data = getHeaderData({ node, selectedId, selectedIds, project });

  return (
    <div className="settings-panel-header">
      <div className="settings-panel-header-icon" aria-hidden="true">
        {data.type === 'multi' ? <IconArrowRight /> : <NodeTypeIcon type={data.type} icon={data.icon} />}
      </div>
      <div className="settings-panel-header-main">
        <div className="settings-panel-header-title" title={data.title}>{data.title}</div>
        <div className="settings-panel-header-badge">{data.badge}</div>
      </div>
      {onClose ? (
        <button
          type="button"
          className="settings-panel-header-close"
          aria-label="Fermer les réglages"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
