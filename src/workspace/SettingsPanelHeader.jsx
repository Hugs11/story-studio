import { useTranslation } from 'react-i18next';
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

function getHeaderData(t, { node, selectedId, selectedIds, project }) {
  if (selectedIds?.size > 1) {
    return {
      type: 'multi',
      title: t('settings:panel.multi.title', { count: selectedIds.size }),
      badge: t('settings:panel.multi.badge'),
      icon: null,
    };
  }
  if (selectedId === END_NODE_ID) {
    return {
      type: END_NODE_ID,
      title: project?.endNodeName || t('settings:panel.end.fallback'),
      badge: TYPE_LABELS[END_NODE_ID],
      icon: project?.globalOptions?.nightMode ? 'moon' : 'stop',
    };
  }
  if (!node) {
    return {
      type: 'root',
      title: t('settings:panel.title.fallback'),
      badge: t('settings:panel.selection.badge'),
      icon: null,
    };
  }
  const type = node.type === 'root' ? 'root' : node.type;
  const rootTitle = project?.projectType === 'simple'
    ? (project?.projectName || t('settings:panel.story.fallback'))
    : (project?.rootName || project?.projectName || t('settings:panel.root.fallback'));
  // Badge du root : dépend du type de projet — « Histoire simple » en `simple`
  // (le header est visible dans l'éditeur simple même sans diagramme),
  // « Pack » sinon. « Histoire » seul serait ambigu avec TYPE_LABELS.story.
  const rootBadge = project?.projectType === 'simple' ? t('settings:panel.simple.badge') : t('settings:panel.pack.badge');
  return {
    type,
    title: type === 'root' ? rootTitle : (node.name || TYPE_LABELS[type] || t('settings:panel.title.fallback')),
    badge: type === 'root' ? rootBadge : (TYPE_LABELS[type] || t('settings:panel.title.fallback')),
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
  const { t } = useTranslation('settings');
  const data = getHeaderData(t, { node, selectedId, selectedIds, project });

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
          aria-label={t('settings:panel.close.action')}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
