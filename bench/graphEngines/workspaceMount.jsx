// L'atelier natif : le **vrai** espace de travail avancé, monté
// sur une fixture, dans la WebView de `tauri dev`.
//
// Ce n'est pas une maquette et ce n'est pas un double : c'est `AdvancedWorkspace`
// tel que l'application le monte, branché sur le vrai `useProjectStore`, la
// vraie session d'édition, les vraies commandes `read_advanced_graph_view` et
// `apply_advanced_gesture`. Ce que le parcours exerce est donc ce qui tourne.
//
// ```text
// VITE_BENCH=atelier VITE_BENCH_PROFILE=mediane-124 npm run tauri:dev
// VITE_BENCH=atelier VITE_BENCH_RUN=parcours npm run tauri:dev
// ```
//
// Ce que l'atelier prouve : les gestes partent, reviennent, entrent dans
// l'historique, et les refus laissent le document intact — **dans WebKitGTK**.
// Ce qu'il ne prouve pas, et que seul un essai humain prouvera : l'ergonomie, le
// clavier, le focus, le contraste et les gestes de trackpad.

import React from 'react';
import ReactDOM from 'react-dom/client';

import { AdvancedWorkspace } from '../../src/components/AdvancedWorkspace/AdvancedWorkspace.jsx';
import { ProjectActionsContext } from '../../src/store/ProjectActionsContext.js';
import { useAdvancedAuthoring } from '../../src/hooks/useAdvancedAuthoring.js';
import { useProjectStore } from '../../src/store/projectStore.js';
import { createAdvancedProject, readAuthoringPayload } from '../../src/store/projectModel/authoring.js';
import { runWorkspaceParcours } from './workspaceParcours.js';

const DEFAULT_PROFILE = 'mediane-124';

// Les actions projet que `AppShell` monte autour des **deux** éditeurs.
//
// `ProjectActionsContext` vaut `null` par défaut, et l'atelier du banc n'a
// jamais posé de fournisseur : `AdvancedWorkspace` lisait donc
// `projectActions.onImportMediaLibrary` sur `null` et tombait au premier rendu.
// Le parcours ne pouvait plus s'exécuter du tout, et rien ne le signalait
// puisque personne ne le lançait.
//
// Les outils média sont **volontairement inertes** : le banc n'exerce ni
// import, ni enregistrement, ni synthèse vocale, et un stub qui ferait semblant
// de réussir laisserait croire qu'ils ont été éprouvés. Ce qui est éprouvé ici
// est le reste de l'atelier.
const BENCH_PROJECT_ACTIONS = Object.freeze({
  onImportMediaLibrary: null,
  onImportPodcast: null,
  onImportYoutube: null,
  onRecord: null,
  onGenerateStoryTts: null,
  canRecord: false,
  canGenerateStoryTts: false,
});

function Atelier({ payload, profile }) {
  const store = useProjectStore();
  const authoring = useAdvancedAuthoring({ store });
  const [installed, setInstalled] = React.useState(false);

  // Le pilote lit par **ref, écrite pendant le rendu**, jamais par une valeur
  // capturée dans un effet.
  //
  // Ce n'est pas une précaution de style : sous WebKitGTK, un rappel
  // `requestAnimationFrame` peut s'exécuter avant que React n'ait validé le
  // rendu suivant. Un pilote publié par un effet rendrait alors l'état d'avant
  // le geste, et le parcours accuserait le produit d'un décalage qui est le
  // sien. La ref, elle, est à jour dès la ligne qui l'écrit.
  const latest = React.useRef(null);
  latest.current = { store, authoring };

  // Une seule installation, **y compris sous StrictMode**, qui rejoue les
  // effets de montage. `loadProject` fait avancer l'époque et vide l'historique :
  // le rejouer réinstallerait la fixture par-dessus les gestes déjà appliqués,
  // et le parcours mesurerait alors sa propre course.
  const installedFor = React.useRef(null);
  React.useEffect(() => {
    const key = `${profile}:${payload.length}`;
    if (installedFor.current === key) return;
    installedFor.current = key;
    store.loadProject(createAdvancedProject({ payload, projectName: `atelier-${profile}` }));
    setInstalled(true);
  }, [payload, profile]);

  // Le pilote exposé au parcours, posé **une fois**. Il ne double aucune règle :
  // il rend les mêmes fonctions que la barre de l'espace de travail appelle.
  React.useEffect(() => {
    window.__atelier = {
      profile,
      payload: () => readAuthoringPayload(latest.current.store.project),
      project: () => latest.current.store.project,
      runGesture: (gesture) => latest.current.authoring.runGesture(gesture),
      busy: () => latest.current.authoring.busy,
      refusal: () => latest.current.authoring.refusal,
      undo: () => latest.current.store.undo(),
      redo: () => latest.current.store.redo(),
      canUndo: () => latest.current.store.canUndo,
      canRedo: () => latest.current.store.canRedo,
      // Attendre que la file de gestes se vide. Le parcours C clique un geste
      // depuis le menu contextuel, donc sans passer par `runGesture` : sans
      // cette attente il relirait le payload d'avant, et conclurait que le
      // geste n'a rien fait.
      whenIdle: () => latest.current.authoring.whenIdle(),
    };
    return () => { if (window.__atelier?.profile === profile) delete window.__atelier; };
  }, [profile]);

  if (!installed) return <p style={{ color: '#e8eaed', font: '13px system-ui' }}>Installation…</p>;

  return (
    <ProjectActionsContext.Provider value={BENCH_PROJECT_ACTIONS}>
      <AdvancedWorkspace
        project={store.project}
        payload={readAuthoringPayload(store.project)}
        projectDescriptor={{
          packIdentity: null,
          savePath: `/tmp/story-studio-atelier/${profile}.mbah`,
          sessionDir: null,
        }}
        projectEpoch={store.workEpochRef.current}
        authoring={authoring}
        dirty={authoring.lastReport !== null}
        savePath={`/tmp/story-studio-atelier/${profile}.mbah`}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        onUndo={store.undo}
        onRedo={store.redo}
        onSave={() => {}}
        onSaveAs={() => {}}
        onNewProject={() => {}}
        onOpenProject={() => {}}
      />
    </ProjectActionsContext.Provider>
  );
}

export async function mountWorkspace() {
  const profile = import.meta.env.VITE_BENCH_PROFILE || DEFAULT_PROFILE;
  document.title = `Atelier avancé — ${profile}`;
  const response = await fetch(`/__bench/fixture/${profile}.payload.json`);
  if (!response.ok) {
    document.body.textContent = `Fixture ${profile} absente : lancer scripts/advanced-graph-fixtures.mjs`;
    return;
  }
  // Le payload est transmis **comme une chaîne opaque** : JavaScript ne
  // l'ouvre pas, et c'est Rust qui en dérive la vue.
  const payload = await response.text();
  const root = document.createElement('div');
  root.style.cssText = 'height:100vh';
  document.body.style.cssText = 'margin:0;background:#15181c';
  document.body.append(root);
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Atelier payload={payload} profile={profile} />
    </React.StrictMode>,
  );

  if (import.meta.env.VITE_BENCH_RUN === 'parcours') {
    // Le parcours attend que le pilote soit posé, puis exerce A et B dans
    // l'ordre du plan, et dépose son relevé dans le dépôt documentaire privé.
    await runWorkspaceParcours({ profile });
  }
}
