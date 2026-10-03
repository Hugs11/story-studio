import { ArrowRight, X } from '../components/icons/LucideLocal';
import { NodeIcon } from '../components/icons/NodeIcon.jsx';
import { hierarchicalNatureOf } from '../store/nodeIconVocabulary.js';
import { WORKSPACE_MODE_HIERARCHICAL } from '../store/projectWorkState.js';
import { END_NODE_ID, TYPE_LABELS } from '../components/diagram/flowDiagramLayout';

function NodeTypeIcon({ type, icon }) {
  // L'en-tete nomme toujours l'entree a cote de son dessin. Le repli est
  // l'accueil.
  return (
    <NodeIcon
      workspaceMode={WORKSPACE_MODE_HIERARCHICAL}
      nature={hierarchicalNatureOf(type, { night: icon === 'moon' }) ?? 'root'}
    />
  );
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
  // (le header est visible dans l'éditeur simple même sans diagramme),
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
  dragHandleProps = {},
}) {
  const data = getHeaderData({ node, selectedId, selectedIds, project });

  return (
    <div className="settings-panel-header" {...dragHandleProps}>
      <div className="settings-panel-header-icon" aria-hidden="true">
        {data.type === 'multi' ? <ArrowRight /> : <NodeTypeIcon type={data.type} icon={data.icon} />}
      </div>
      <div className="settings-panel-header-main">
        <div className="settings-panel-header-title" title={data.title}>{data.title}</div>
        <div className="settings-panel-header-badge" title={data.badge}>{data.badge}</div>
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
