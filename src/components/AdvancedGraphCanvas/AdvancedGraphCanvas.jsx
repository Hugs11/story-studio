// La surface avancée du banc d'essai : canvas au centre, recherche à gauche,
// inspecteur en lecture à droite.
//
// Elle ne monte **aucun** composant hiérarchique Libre, et le diagramme Libre
// ne monte rien d'ici : les deux surfaces ne partagent ni caméra, ni gestes, ni
// primitives de viewport. La caméra de cette surface appartient au moteur
// d'affichage, et c'est pourquoi les gestes WebKitGTK doivent y être revérifiés.
//
// Le moteur est choisi par propriété et chargé dynamiquement. Le verdict
// sur le moteur à retenir appartient à Windows et macOS : ce composant ne le
// prononce pas, il porte seulement la valeur par défaut de l'espace de travail.
//
// Le rendu vit dans `GraphCanvasStage`, partagé avec
// l'espace de travail intégré. Ce composant reste le banc : une session de vue,
// trois panneaux, aucun geste d'auteur.

import { useCallback, useRef, useState } from 'react';

import { ENGINE_IDS } from './engines/index.js';
import { DEFAULT_EDGE_VISIBILITY } from './engines/engineContract.js';
import GraphCanvasStage from './GraphCanvasStage.jsx';
import { useAdvancedGraphView } from './useAdvancedGraphView.js';
import { useRevealHistory } from './useRevealHistory.js';
import GraphInspector from './GraphInspector.jsx';
import GraphSearchPanel from './GraphSearchPanel.jsx';
import './AdvancedGraphCanvas.css';

export default function AdvancedGraphCanvas({
  payload,
  project = null,
  projectDescriptor,
  projectEpoch,
  engineId = ENGINE_IDS.CYTOSCAPE,
  createEngine = undefined,
  bridge = null,
  onAuthoredPositionsChange = null,
  // Transmise telle quelle à l'étage de canvas : voir `GraphCanvasStage`.
  // L'application ne la pose pas ; seule la recette du banc s'en sert.
  surfaceRef = null,
}) {
  const view = useAdvancedGraphView({ payload, projectDescriptor, projectEpoch, bridge });
  const [edgeVisibility, setEdgeVisibility] = useState(() => ({ ...DEFAULT_EDGE_VISIBILITY }));
  const focusRef = useRef(null);
  const focusPath = useCallback(
    (path, options) => focusRef.current?.(path, options),
    [],
  );
  // Le même historique que l'atelier, par le même hook. La recette exerce donc
  // ici, dans WebKitGTK, le code que l'application exécute — un adaptateur
  // propre au banc n'aurait prouvé que le banc.
  const { revealPath, history } = useRevealHistory({
    index: view.index,
    viewport: view.viewport,
    focusPath,
  });

  if (view.status === 'failed') {
    return (
      <div className="advanced-canvas advanced-canvas--error" role="alert">
        <h2>Lecture impossible</h2>
        {/* Les refus du codec ressortent tels quels, avec leur code et leur
            chemin : ils ne sont pas réécrits en codes de vue. */}
        <p><code>{view.error?.code ?? 'ERREUR'}</code> {view.error?.path}</p>
        <p>{view.error?.message ?? String(view.error)}</p>
      </div>
    );
  }

  return (
    <div className="advanced-canvas">
      <GraphSearchPanel
        project={project}
        search={view.search}
        focus={view.focus}
        onFocusPath={revealPath}
        counts={view.view?.counts}
        roles={view.roles}
      />

      <GraphCanvasStage
        view={view}
        project={project}
        engineId={engineId}
        createEngine={createEngine}
        onAuthoredPositionsChange={onAuthoredPositionsChange}
        focusRef={focusRef}
        onRevealPath={revealPath}
        history={history}
        edgeVisibility={edgeVisibility}
        onEdgeVisibilityChange={setEdgeVisibility}
        surfaceRef={surfaceRef}
      />

      <GraphInspector inspected={view.inspected} onFocusPath={revealPath} />
    </div>
  );
}
