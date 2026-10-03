import { useCallback, useEffect } from 'react';
import { FlatSimulator } from '../../tabs/EmulatorTab';
import { revokeUrlCache } from '../../tabs/EmulatorTab/useUrlCache';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useFloatingSimulator } from '../../hooks/useFloatingSimulator';
import { editorLayoutKeys } from '../../store/persistentSettings';
import { Button } from '../common/Button';
import './FloatingSimulator.css';

// Ce que le simulateur montre quand il n'a pas encore de graphe, ou n'en aura
// pas. Un refus du générateur est une issue **normale** : un projet en cours
// d'écriture peut contenir un dossier encore vide, que la production refuse
// aussi. Son message est rendu tel quel, jamais réécrit.
function SimulatorNotice({ tone = 'muted', title = null, children, onClose }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`floating-simulator-notice${tone === 'error' ? ' floating-simulator-notice--error' : ''}`}
    >
      {title && <div className="floating-simulator-notice__title">{title}</div>}
      <div className="floating-simulator-notice__message">{children}</div>
      {onClose && (
        <Button
          variant="icon"
          size="sm"
          className="floating-simulator-notice__close"
          aria-label="Fermer le message du simulateur"
          title="Fermer le message du simulateur"
          onClick={onClose}
        >
          ×
        </Button>
      )}
    </div>
  );
}

function EmbeddedSimulator({
  initialZipPath = null,
  // L'état de la projection, quand le graphe vient d'en être demandé un.
  documentStatus = null,
  documentError = null,
  // Le graphe à jouer, **figé** par l'appelant : le document d'auteur avancé
  // pour l'éditeur graphe, ou l'arbre du mode Libre projeté par le générateur.
  documentGraph = null,
  documentStartId = null,
  onActiveNodeChange,
  onClose,
  dragHandleProps = null,
}) {
  const source = documentGraph
    ? { kind: 'document', graph: documentGraph, startId: documentStartId }
    : initialZipPath
      ? { kind: 'pack', zipPath: initialZipPath }
      : null;

  // Révoquer les blob URLs du cache simulateur quand le simulateur se ferme
  // (EmbeddedSimulator démonté), pour ne pas accumuler de blobs entre sessions.
  useEffect(() => () => revokeUrlCache(), []);

  if (!source) {
    if (documentStatus === 'loading') {
      return <SimulatorNotice onClose={onClose}>Préparation de l’écoute…</SimulatorNotice>;
    }
    if (documentStatus === 'failed') {
      return (
        <SimulatorNotice tone="error" title="Écoute impossible" onClose={onClose}>
          {documentError}
        </SimulatorNotice>
      );
    }
    return null;
  }

  return (
    <FlatSimulator
      key={source.kind === 'pack' ? source.zipPath : 'document'}
      source={source}
      // Seule l'écoute d'un graphe que l'éditeur ouvert connaît désigne des
      // nœuds sélectionnables. Une archive relue a ses propres identifiants,
      // qui ne correspondent à rien dans le projet ouvert.
      onActiveNodeChange={source.kind === 'document' ? onActiveNodeChange : null}
      onClose={onClose}
      dragHandleProps={dragHandleProps}
    />
  );
}

export function FloatingSimulator({
  anchorId = null,
  zipPath = null,
  documentGraph = null,
  documentStartId = null,
  documentStatus = null,
  documentError = null,
  onActiveNodeChange,
  onClose,
  hostSelector,
  layoutScope,
  escapeEnabled = true,
}) {
  const isOpen = Boolean(anchorId || zipPath || documentGraph);
  const geometryKey = editorLayoutKeys(layoutScope).floatingSimulatorGeometry;
  const { position, size, panelRef, beginDrag, beginResize } = useFloatingSimulator(
    hostSelector,
    { storageKey: geometryKey, active: isOpen },
  );

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const isShowingNotice = !documentGraph && !zipPath
    && (documentStatus === 'loading' || documentStatus === 'failed');
  useEscapeKey(escapeEnabled && isOpen, handleClose);

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className={`floating-simulator${isShowingNotice ? ' floating-simulator--notice' : ''}`}
      style={{
        ...(size && !isShowingNotice ? { width: size.width, height: size.height } : {}),
        ...(position ? { left: position.x, top: position.y, transform: 'none' } : {}),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <EmbeddedSimulator
        initialZipPath={zipPath}
        documentGraph={documentGraph}
        documentStartId={documentStartId}
        documentStatus={documentStatus}
        documentError={documentError}
        dragHandleProps={{ onPointerDown: beginDrag }}
        onActiveNodeChange={onActiveNodeChange}
        onClose={handleClose}
      />
      {!isShowingNotice && (
        <button
          type="button"
          className="floating-simulator-resize"
          aria-label="Redimensionner le simulateur"
          onPointerDown={beginResize}
        />
      )}
    </div>
  );
}
