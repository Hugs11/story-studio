// Le banc d'export : l'espace de travail avancé sur la **vraie**
// chaîne, du pack importé jusqu'à l'archive relue.
//
// Ce n'est ni une maquette ni un double. Il monte `AdvancedWorkspace` avec le
// vrai `useProjectStore`, la vraie session d'édition, la vraie session
// d'export, et il appelle les fonctions de production pour tout le reste :
// `acquire_advanced_pack_document` pour l'import, `saveProject` et
// `loadProjectFromPath` pour le fichier `.mbah`, `export_advanced_pack` pour
// l'archive, `load_pack_zip` pour la relire.
//
// ```text
// node scripts/advanced-export-fixtures.mjs
// VITE_BENCH=export VITE_BENCH_RUN=parcours npm run tauri:dev
// ```
//
// Ce qu'il prouve : les parcours d'acceptation du plan, dans WebKitGTK, sur des
// fichiers réels. Ce qu'il ne prouve pas : l'ergonomie, le clavier, le focus,
// le contraste, ni le comportement d'un firmware physique.

import React from 'react';
import ReactDOM from 'react-dom/client';

import { AdvancedWorkspace } from '../../src/components/AdvancedWorkspace/AdvancedWorkspace.jsx';
import { useAdvancedAuthoring } from '../../src/hooks/useAdvancedAuthoring.js';
import { useAdvancedExport } from '../../src/hooks/useAdvancedExport.js';
import { useProjectStore } from '../../src/store/projectStore.js';
import { readAuthoringPayload } from '../../src/store/projectModel/authoring.js';
import { KEYS, write as writeSetting } from '../../src/store/persistentSettings.js';
import { runExportParcours } from './exportParcours.js';

function Banc({ context, initialProject }) {
  const store = useProjectStore();
  const authoring = useAdvancedAuthoring({ store });
  const workspaceDirRef = React.useRef(context.workspaceDir);
  const advancedExport = useAdvancedExport({ store, authoring, workspaceDirRef });
  const [installed, setInstalled] = React.useState(false);

  // Le pilote lit par **ref écrite pendant le rendu**, jamais par une valeur
  // capturée dans un effet : sous WebKitGTK, un rappel `requestAnimationFrame`
  // peut s'exécuter avant que React n'ait validé le rendu suivant. C'est la
  // correction déjà nécessaire dans l'atelier natif, et elle vaut ici à l'identique.
  const latest = React.useRef(null);
  latest.current = { store, authoring, advancedExport };

  const installedFor = React.useRef(null);
  React.useEffect(() => {
    const key = readAuthoringPayload(initialProject)?.length ?? 0;
    if (installedFor.current === key) return;
    installedFor.current = key;
    store.loadProject(initialProject);
    setInstalled(true);
  }, [initialProject, store]);

  React.useEffect(() => {
    window.__exportBench = {
      context,
      project: () => latest.current.store.project,
      payload: () => readAuthoringPayload(latest.current.store.project),
      savePath: () => latest.current.store.savePath,
      setSavePath: (path) => latest.current.store.setSavePath(path),
      loadProject: (project) => latest.current.store.loadProject(project),
      runGesture: (gesture) => latest.current.authoring.runGesture(gesture),
      authoringBusy: () => latest.current.authoring.busy,
      authoringLocked: () => latest.current.authoring.locked,
      undo: () => latest.current.store.undo(),
      redo: () => latest.current.store.redo(),
      canUndo: () => latest.current.store.canUndo,
      // L'export est appelé par **la même** fonction que le bouton du tiroir,
      // avec le dossier déjà choisi : le sélecteur natif est le seul geste que
      // le banc contourne, et il ne fait pas partie du contrat d'export.
      startExport: (options) => latest.current.advancedExport.start(options),
      cancelExport: () => latest.current.advancedExport.cancel(),
      dismissExport: () => latest.current.advancedExport.dismiss(),
      exportState: () => {
        const { start, cancel, dismiss, chooseFolder, openReview, closeReview, clearBlocked, ...state } = latest.current.advancedExport;
        return state;
      },
      openReview: (result) => latest.current.advancedExport.openReview(result),
      closeReview: () => latest.current.advancedExport.closeReview(),
    };
    return () => { delete window.__exportBench; };
  }, [context]);

  if (!installed) return <p style={{ color: '#e8eaed', font: '13px system-ui' }}>Installation…</p>;

  return (
    <AdvancedWorkspace
      project={store.project}
      payload={readAuthoringPayload(store.project)}
      projectDescriptor={{
        packIdentity: null,
        savePath: store.savePath,
        sessionDir: null,
      }}
      projectEpoch={store.workEpochRef.current}
      authoring={authoring}
      exportState={advancedExport}
      dirty={store.canUndo}
      savePath={store.savePath}
      canUndo={store.canUndo}
      canRedo={store.canRedo}
      onUndo={store.undo}
      onRedo={store.redo}
      onSave={() => {}}
      onSaveAs={() => {}}
      onNewProject={() => {}}
      onOpenProject={() => {}}
    />
  );
}

export async function mountExportBench() {
  document.title = 'Banc export avancé';
  document.body.style.cssText = 'margin:0;background:#15181c';
  const root = document.createElement('div');
  root.style.cssText = 'height:100vh';
  document.body.append(root);

  const context = await (await fetch('/__bench/export-context')).json();
  if (!context.fixturesReady) {
    document.body.textContent = 'Fixtures absentes : lancer `node scripts/advanced-export-fixtures.mjs`.';
    return;
  }

  // Le workspace du banc est posé dans les réglages persistés, parce que c'est
  // là que `saveProject` et `loadProjectFromPath` vont le chercher. Le banc
  // exerce donc la vraie résolution de chemins, pas une variante.
  writeSetting(KEYS.WORKSPACE_DIR, context.workspaceDir);

  const profile = import.meta.env.VITE_BENCH_PROFILE || 'export-mvp';
  const { acquireImportedAdvancedProject } = await import('../../src/store/projectModel/authoring.js');
  let initialProject;
  try {
    initialProject = await acquireImportedAdvancedProject({
      packPath: `${context.fixtureDir}${context.separator}${profile}.zip`,
      assetsDir: profile,
      workspaceDir: context.workspaceDir,
      projectName: `banc-${profile}`,
    });
  } catch (error) {
    document.body.textContent = `Acquisition impossible : ${String(error?.message ?? JSON.stringify(error))}`;
    return;
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Banc context={context} initialProject={initialProject} />
    </React.StrictMode>,
  );

  if (import.meta.env.VITE_BENCH_RUN === 'parcours') {
    await runExportParcours({ profile, context });
  }
}
