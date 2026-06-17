import { useCallback, useEffect, useState } from 'react';
import { ProjectSimulator, ZipSimulator } from '../../tabs/EmulatorTab';
import { revokeUrlCache } from '../../tabs/EmulatorTab/useUrlCache';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useFloatingSimulator } from '../../hooks/useFloatingSimulator';
import './FloatingSimulator.css';

function EmbeddedSimulator({ project, initialSelectionId, initialZipPath = null, onActiveNodeChange, onClose, dragHandleProps = null }) {
  const [mode, setMode] = useState(initialZipPath ? 'zip' : 'project');
  const [zipPath, setZipPath] = useState(initialZipPath);
  // fromProject : le zip a-t-il ete atteint en naviguant dans le projet ? Si oui,
  // ZipSimulator propose un retour au projet ; un zip simule en standalone (action
  // « Simuler ce pack… ») n'a pas d'origine projet.
  const [zipFromProject, setZipFromProject] = useState(false);

  // Révoquer les blob URLs du cache simulateur quand le simulateur se ferme
  // (EmbeddedSimulator démonté), pour ne pas accumuler de blobs entre sessions.
  useEffect(() => () => revokeUrlCache(), []);

  useEffect(() => {
    if (initialZipPath) {
      setMode('zip');
      setZipPath(initialZipPath);
      setZipFromProject(false);
    } else {
      setMode('project');
      setZipPath(null);
      setZipFromProject(false);
    }
  }, [initialSelectionId, initialZipPath]);

  return mode === 'project' ? (
    <ProjectSimulator
      project={project}
      initialSelectionId={initialSelectionId}
      onActiveNodeChange={onActiveNodeChange}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      onOpenZip={(path) => {
        setZipPath(path);
        setZipFromProject(true);
        setMode('zip');
      }}
    />
  ) : zipPath ? (
    <ZipSimulator
      key={zipPath}
      zipPath={zipPath}
      fromProject={zipFromProject}
      onExit={() => setMode('project')}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
    />
  ) : null;
}

export function FloatingSimulator({
  project,
  anchorId,
  zipPath = null,
  onActiveNodeChange,
  onClose,
  hostSelector,
  escapeEnabled = true,
}) {
  const { position, size, beginDrag, beginResize } = useFloatingSimulator(hostSelector);

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const isOpen = Boolean(anchorId || zipPath);
  useEscapeKey(escapeEnabled && isOpen, handleClose);

  if (!isOpen) return null;

  return (
    <div
      className="floating-simulator"
      style={{
        ...(size ? { width: size.width, height: size.height } : {}),
        ...(position ? { left: position.x, top: position.y, transform: 'none' } : {}),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <EmbeddedSimulator
        project={project}
        initialSelectionId={anchorId}
        initialZipPath={zipPath}
        dragHandleProps={{ onPointerDown: beginDrag }}
        onActiveNodeChange={onActiveNodeChange}
        onClose={handleClose}
      />
      <button
        type="button"
        className="floating-simulator-resize"
        aria-label="Redimensionner le simulateur"
        onPointerDown={beginResize}
      />
    </div>
  );
}
