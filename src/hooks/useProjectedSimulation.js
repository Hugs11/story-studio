// L'écoute d'un projet du mode Libre, projetée par le générateur.
//
// # Pourquoi elle passe par Rust
//
// Le simulateur de graphe à plat joue des Écrans et des Actions. Un projet du
// mode Libre est un arbre. Le générateur sait transformer l'un en l'autre —
// c'est son métier, en 1 900 lignes — et `project_pack_for_simulation` le fait
// **sans produire d'archive** : aucun média n'est converti, rien n'est écrit.
//
// Refaire cette transformation en JavaScript aurait produit un second
// générateur à tenir synchronisé. Ici, ce que l'auteur entend est exactement ce
// que la production fabriquera.
//
// # Pourquoi le graphe est figé le temps d'une écoute
//
// Le générateur **tire de nouveaux identifiants à chaque projection**
// (`Uuid::new_v4`). Reprojeter pendant l'écoute ne déplacerait donc pas l'auteur
// d'un Écran à l'autre : cela le téléporterait, parce qu'aucun identifiant ne
// survivrait. Le graphe est donc un instantané, et l'appelant dit à l'auteur
// quand il n'est plus à jour.
//
// C'est un changement par rapport au lecteur d'arbre, qui suivait le projet en
// direct. Relancer l'écoute suffit, et c'est la contrepartie d'entendre ce que
// la production fabrique réellement.

import { useEffect, useRef, useState } from 'react';

import { projectToRustExport } from '../store/projectModel/schema.js';
import { projectedFlatGraph } from '../tabs/EmulatorTab/flatGraph.js';

const IDLE = { status: 'idle', graph: null, error: null };

async function invokeProjection(project) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('project_pack_for_simulation', { projectJson: JSON.stringify(project) });
}

export function useProjectedSimulation({ project, projectEpoch = null, launch, projectStory = invokeProjection }) {
  const [state, setState] = useState(IDLE);
  // Le projet est lu **au lancement**, par ref : le mettre en dépendance
  // reprojetterait à chaque frappe, et chaque projection rend des identifiants
  // neufs.
  const projectRef = useRef(project);
  projectRef.current = project;
  const launchOwnerRef = useRef(null);

  useEffect(() => {
    // Le même lancement ne peut pas migrer vers un autre travail. L'édition
    // garde son instantané ; un changement d'époque exige une nouvelle écoute.
    const previousOwner = launchOwnerRef.current;
    if (!launch || (previousOwner?.launch === launch && previousOwner.projectEpoch !== projectEpoch)) {
      setState(IDLE);
      return undefined;
    }
    launchOwnerRef.current = { launch, projectEpoch };
    const launchedProject = projectRef.current;
    let cancelled = false;
    setState({ status: 'loading', graph: null, error: null });
    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        return projectStory(projectToRustExport(launchedProject));
      })
      .then((projection) => {
        if (cancelled) return;
        setState({ status: 'ready', graph: projectedFlatGraph(projection), error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        // Les refus du générateur ressortent tels quels : un projet qu'il ne
        // sait pas projeter le dit avec ses propres mots, jamais réécrits.
        setState({ status: 'failed', graph: null, error: String(error?.message ?? error) });
      });
    return () => { cancelled = true; };
  }, [launch, projectEpoch, projectStory]);

  // Ne pas exposer l'ancien graphe pendant le rendu qui précède les effets.
  return !launch || launchOwnerRef.current?.projectEpoch !== projectEpoch ? IDLE : state;
}

/**
 * L'Écran sur lequel une écoute lancée depuis un nœud de l'arbre commence.
 *
 * Le générateur produit plusieurs Écrans par entrée — un écran de sélection,
 * un écran de lecture, parfois un message de fin. L'écoute commence sur le
 * **premier** que le document porte pour cette entrée, qui est celui que
 * l'auteur voit en arrivant dessus.
 */
export function startStageForEntry(graph, entryId) {
  if (!graph || !entryId || entryId === 'root') return null;
  for (const stage of graph.stages.values()) {
    if (graph.entryIdByStage?.get(stage.id) === entryId) return stage.id;
  }
  return null;
}
