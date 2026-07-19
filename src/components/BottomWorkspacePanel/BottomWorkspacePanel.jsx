import { useMemo, useRef, useState } from 'react';
import { MediaExplorer } from '../MediaExplorer/MediaExplorer';
import { RenderQueuePanel } from '../RenderQueuePanel/RenderQueuePanel';
import { SDQueuePanel } from '../SDQueuePanel/SDQueuePanel';
import { collectMediaLibrary } from '../../store/mediaLibrary';
import { KEYS, read, write } from '../../store/persistentSettings';
import './BottomWorkspacePanel.css';

const DEFAULT_HEIGHT = 270;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 600;

function loadHeight() {
  const raw = Number(read(KEYS.BOTTOM_PANEL_HEIGHT));
  return Number.isFinite(raw) && raw >= MIN_HEIGHT && raw <= MAX_HEIGHT ? raw : DEFAULT_HEIGHT;
}

export function BottomWorkspacePanel({
  activeTab,
  onActiveTabChange,
  onClose,
  project,
  pathAudit,
  sdJobs,
  xttsJobs,
  mediaLibraryPaths,
  onImportStories,
  onImportMedia,
  onImportMediaFolder,
  onRegenerateImage,
  onClearAiDone,
  onRemoveImageJob,
  onRemoveAudioJob,
  getAudioUsage,
  getImageUsage,
  onSelectNode,
  renderQueue,
  mediaTags,
  onAddMediaTag,
  onRemoveMediaTag,
  onDeleteMedia,
  onMediaCatalogChanged,
  workspaceDir = '',
  savePath,
  projectName = '',
  onMediaCreated,
}) {
  const [height, setHeight] = useState(loadHeight);
  const dragRef = useRef(null);

  const activeCount = renderQueue.jobs.filter((job) => job.status === 'pending' || job.status === 'running').length;
  const aiJobs = useMemo(() => [...sdJobs, ...xttsJobs], [sdJobs, xttsJobs]);
  const aiActiveCount = aiJobs.filter((job) => (
    job.status === 'pending' || job.status === 'submitting' || job.status === 'running'
  )).length;
  const aiDoneCount = aiJobs.filter((job) => job.status === 'done' || job.status === 'error').length;
  const mediaCount = useMemo(
    () => collectMediaLibrary({ project, statusByPath: pathAudit, sdJobs, xttsJobs, extraPaths: mediaLibraryPaths }).length,
    [project, pathAudit, sdJobs, xttsJobs, mediaLibraryPaths],
  );
  const tabClassName = (tab) => [
    'bottom-workspace-tab',
    `bottom-workspace-tab--${tab}`,
    activeTab === tab ? 'is-active' : '',
  ].filter(Boolean).join(' ');

  function handleResizeMouseDown(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;

    function onMove(ev) {
      const delta = startY - ev.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH + delta));
      setHeight(next);
      dragRef.current = next;
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragRef.current != null) {
        write(KEYS.BOTTOM_PANEL_HEIGHT, String(dragRef.current));
        dragRef.current = null;
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <section className="bottom-workspace-panel" style={{ height }}>
      <div className="bottom-workspace-resize-handle" onMouseDown={handleResizeMouseDown} />
      <div className="bottom-workspace-tabs">
        <button
          type="button"
          className={tabClassName('media')}
          onClick={() => onActiveTabChange('media')}
        >
          Médias
          <span>{mediaCount}</span>
        </button>
        <button
          type="button"
          className={tabClassName('queue')}
          onClick={() => onActiveTabChange('queue')}
        >
          File de rendu
          {activeCount > 0 && <span>{activeCount}</span>}
        </button>
        <button
          type="button"
          className={tabClassName('ai')}
          onClick={() => onActiveTabChange('ai')}
        >
          File IA
          {aiActiveCount > 0 ? <span>{aiActiveCount}</span> : aiDoneCount > 0 ? <span>✓</span> : null}
        </button>
        <div className="bottom-workspace-spacer" />
        <button type="button" className="bottom-workspace-close" onClick={onClose} title="Réduire">×</button>
      </div>
      <div className="bottom-workspace-body">
        {activeTab === 'media' ? (
          <MediaExplorer
            project={project}
            statusByPath={pathAudit}
            sdJobs={sdJobs}
            xttsJobs={xttsJobs}
            extraPaths={mediaLibraryPaths}
            onImportStories={onImportStories}
            onImportMedia={onImportMedia}
            onImportMediaFolder={onImportMediaFolder}
            onSelectNode={onSelectNode}
            mediaTags={mediaTags}
            onAddMediaTag={onAddMediaTag}
            onRemoveMediaTag={onRemoveMediaTag}
            onDeleteMedia={onDeleteMedia}
            onMediaCatalogChanged={onMediaCatalogChanged}
            workspaceDir={workspaceDir}
            savePath={savePath}
            projectName={projectName}
            onMediaCreated={onMediaCreated}
          />
        ) : activeTab === 'queue' ? (
          <RenderQueuePanel
            embedded
            jobs={renderQueue.jobs}
            onRemove={renderQueue.removeJob}
            onCancel={renderQueue.cancelJob}
            onClearDone={renderQueue.clearDone}
            onClose={onClose}
          />
        ) : (
          <SDQueuePanel
            embedded
            imageJobs={sdJobs}
            audioJobs={xttsJobs}
            onRemoveImage={onRemoveImageJob}
            onRemoveAudio={onRemoveAudioJob}
            getAudioUsage={getAudioUsage}
            getImageUsage={getImageUsage}
            onRegenerateImage={onRegenerateImage}
            onClearDone={onClearAiDone}
            onClose={onClose}
          />
        )}
      </div>
    </section>
  );
}
