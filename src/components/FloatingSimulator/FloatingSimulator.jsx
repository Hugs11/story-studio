import { useCallback, useEffect, useState } from 'react';
import { ProjectSimulator, ZipSimulator } from '../../tabs/EmulatorTab';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useFloatingSimulator } from '../../hooks/useFloatingSimulator';
import './FloatingSimulator.css';

function EmbeddedSimulator({ project, initialSelectionId, onActiveNodeChange, onClose, dragHandleProps = null }) {
  const [mode, setMode] = useState('project');
  const [zipPath, setZipPath] = useState(null);

  useEffect(() => {
    setMode('project');
    setZipPath(null);
  }, [initialSelectionId]);

  return mode === 'project' ? (
    <ProjectSimulator
      project={project}
      initialSelectionId={initialSelectionId}
      onActiveNodeChange={onActiveNodeChange}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
      onOpenZip={(path) => {
        setZipPath(path);
        setMode('zip');
      }}
    />
  ) : zipPath ? (
    <ZipSimulator
      key={zipPath}
      zipPath={zipPath}
      fromProject
      onExit={() => setMode('project')}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
    />
  ) : null;
}

export function FloatingSimulator({
  project,
  anchorId,
  onActiveNodeChange,
  onClose,
  hostSelector,
  escapeEnabled = true,
}) {
  const { position, size, beginDrag, beginResize } = useFloatingSimulator(hostSelector);

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  useEscapeKey(escapeEnabled && Boolean(anchorId), handleClose);

  if (!anchorId) return null;

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
