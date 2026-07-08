import { Suspense } from 'react';

// Enveloppe un rendu lazy (React.lazy) dans un Suspense. Partagé par AppContent
// (WorkspaceView) et AppModals (mur de modales) pour préserver le code-split
// sans dupliquer le helper.
export function renderDeferred(children, fallback = null) {
  return (
    <Suspense fallback={fallback}>
      {children}
    </Suspense>
  );
}
