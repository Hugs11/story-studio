import { MediaExplorer } from '../components/MediaExplorer/MediaExplorer';

export function MediaTab({
  project,
  pathAudit,
  sdJobs,
  xttsJobs,
  mediaLibraryPaths,
  onImportStories,
  onImportMedia,
  onOpenAiQueue,
}) {
  return (
    <div className="screen visible">
      <MediaExplorer
        project={project}
        statusByPath={pathAudit}
        sdJobs={sdJobs}
        xttsJobs={xttsJobs}
        extraPaths={mediaLibraryPaths}
        onImportStories={onImportStories}
        onImportMedia={onImportMedia}
        onOpenAiQueue={onOpenAiQueue}
      />
    </div>
  );
}
