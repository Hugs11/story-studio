// Montage de la **vraie** surface avancée sur une fixture, pour la voir et la
// capturer.
//
// Ce n'est pas une maquette : c'est `AdvancedGraphCanvas` tel que l'application
// le monte, branché sur la vraie commande `read_advanced_graph_view` et sur le
// vrai cache de vue Rust. Ce qui est capturé est donc ce qui tourne, avec ses
// présences, ses diagnostics et ses refus.
//
// ```text
// VITE_BENCH=surface VITE_BENCH_PROFILE=p90-795 npm run tauri:dev
// VITE_BENCH=recette VITE_BENCH_PROFILE=max-9121 npm run tauri:dev
// ```
//
// Le mode `recette` ajoute deux choses à la surface, et rien de plus : des
// vignettes fabriquées — les fixtures portent des références d'image mais aucun
// fichier, et sans elles la charge se mesurerait à zéro vignette chargée — et le
// parcours de recette de la surface, qui mesure puis dépose son
// relevé. La surface, elle, reste exactement celle de production.

import React from 'react';
import ReactDOM from 'react-dom/client';

import AdvancedGraphCanvas from '../../src/components/AdvancedGraphCanvas/AdvancedGraphCanvas.jsx';
import { ENGINE_IDS, createBenchEngine } from './engines/index.js';
import { createAdvancedProject } from '../../src/store/projectModel/authoring.js';
import { runSurfaceRecette } from './surfaceRecette.js';

const DEFAULT_PROFILE = 'p90-795';
const RECETTE_PROFILE = 'max-9121';

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

function Harness({ payload, profile, project, surfaceRef }) {
  const [engineId, setEngineId] = React.useState(ENGINE_IDS.CYTOSCAPE);

  // Le descripteur est celui d'un projet enregistré : identité **et** chemin,
  // jamais l'identité seule. Le cache de vue Rust est donc
  // réellement exercé, y compris son élagage et sa cadence.
  const projectDescriptor = React.useMemo(() => ({
    packIdentity: `banc-${profile}`,
    savePath: `/tmp/story-studio-banc/${profile}.mbah`,
    sessionDir: null,
  }), [profile]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', padding: '6px 12px',
        background: '#0f1216', borderBottom: '1px solid #2a2f35', font: '12px system-ui',
        color: '#e8eaed',
      }}>
        <strong>Éditeur avancé — surface de lecture</strong>
        <span>profil {profile}</span>
        {[ENGINE_IDS.CYTOSCAPE, ENGINE_IDS.G6].map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setEngineId(id)}
            style={{
              padding: '3px 10px',
              background: engineId === id ? '#22303c' : 'transparent',
              color: '#e8eaed', border: '1px solid #3a4753', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {id}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AdvancedGraphCanvas
          payload={payload}
          project={project}
          projectDescriptor={projectDescriptor}
          projectEpoch={1}
          engineId={engineId}
          createEngine={createBenchEngine}
          surfaceRef={surfaceRef}
        />
      </div>
    </div>
  );
}

// Ce que la recette attend du document, lu **dans le DTO** et non supposé de la
// fixture. Une recette qui code en dur « une entrée, 3 752 diagnostics » finit
// par prouver la fixture plutôt que la surface.
function expectationsFrom(view) {
  const stages = view.stages ?? [];
  const actions = view.actions ?? [];
  const diagnosed = new Set(
    (view.diagnostics ?? []).map((one) => one.nodePath).filter(Boolean),
  );
  const groups = new Set(
    [...stages, ...actions]
      .map((node) => (node.groupId?.presence === 'value' ? node.groupId.value : null))
      .filter(Boolean),
  );
  const withImage = stages.filter((stage) => stage.image?.presence === 'value');
  return {
    nodes: stages.length + actions.length,
    stages: stages.length,
    stagesAvecImage: withImage.length,
    actions: actions.length,
    edges: (view.edges ?? []).length,
    entries: stages.filter((stage) => stage.squareOne?.value === true).length,
    diagnosed: diagnosed.size,
    groups: groups.size,
    imageRefs: new Set(withImage.map((stage) => stage.image.assetRef)).size,
  };
}

// Les vignettes de la recette. Les fixtures portent des références d'image mais
// aucun fichier : sans ce détour, la surface se mesurerait avec zéro vignette
// chargée, et le critère de charge ne serait pas exercé. Les références sont
// celles du DTO ; le banc n'en invente aucune.
async function fabricateThumbnails(view) {
  const assetRefs = [...new Set(
    (view.stages ?? [])
      .filter((stage) => stage.image?.presence === 'value')
      .map((stage) => stage.image.assetRef)
      .filter(Boolean),
  )];
  if (assetRefs.length === 0) {
    return { bindings: [], report: { bindings: 0, files: 0, size: null } };
  }
  const response = await fetch('/__bench/media-sandbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetRefs, size: 96 }),
  });
  if (!response.ok) {
    return { bindings: [], report: { bindings: 0, files: 0, size: null, refus: response.status } };
  }
  const { bindings, directory, size } = await response.json();
  return {
    bindings,
    report: { bindings: bindings.length, files: bindings.length, size, directory },
  };
}

export async function mountSurface() {
  const recette = import.meta.env.VITE_BENCH === 'recette';
  const profile = import.meta.env.VITE_BENCH_PROFILE
    || (recette ? RECETTE_PROFILE : DEFAULT_PROFILE);
  document.title = `${recette ? 'Recette' : 'Éditeur avancé'} — ${profile}`;
  const response = await fetch(`/__bench/fixture/${profile}.payload.json`);
  if (!response.ok) {
    document.body.textContent = `Fixture ${profile} absente : lancer scripts/advanced-graph-fixtures.mjs`;
    return;
  }
  // Le payload est transmis **comme une chaîne opaque** : JavaScript ne
  // l'ouvre pas, et c'est Rust qui en dérive la vue.
  const payload = await response.text();

  let project = null;
  let expected = null;
  let mediaReport = { bindings: 0, files: 0, size: null };
  if (recette) {
    // La lecture sert à deux choses, et à rien d'autre : nommer les références
    // d'image à fabriquer, et dire ce que la recette doit retrouver. La surface
    // fait sa propre lecture par la session de vue, comme en production.
    const view = await invokeTauri('read_advanced_graph_view', { payload });
    expected = expectationsFrom(view);
    const thumbnails = await fabricateThumbnails(view);
    mediaReport = {
      ...thumbnails.report,
      // Toutes les fixtures ne donnent une image qu'à une partie des Écrans :
      // sans cette part, un placeholder passerait pour une vignette manquante.
      documentRatio: expected.stages > 0
        ? Math.round((expected.stagesAvecImage / expected.stages) * 1000) / 1000
        : null,
    };
    project = createAdvancedProject({
      payload,
      projectName: `recette-${profile}`,
      mediaBindings: thumbnails.bindings,
    });
  }

  const root = document.createElement('div');
  root.style.cssText = 'height:100vh';
  document.body.style.cssText = 'margin:0;background:#15181c';
  document.body.append(root);

  const surfaceRef = { current: null };
  window.__recette = { profile, surface: surfaceRef };

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <Harness payload={payload} profile={profile} project={project} surfaceRef={surfaceRef} />
    </React.StrictMode>,
  );

  if (!recette) return;

  // Le journal reste **à côté** de la surface, jamais au-dessus : une
  // surimpression du banc entrerait dans les captures et dans les mesures de
  // chevauchement.
  const log = document.createElement('pre');
  log.id = 'recette-log';
  log.style.cssText = 'position:fixed;right:0;bottom:0;max-height:38vh;width:32vw;overflow:auto;'
    + 'margin:0;padding:8px;background:rgba(8,10,13,.94);color:#cfd4da;'
    + 'font:11px/1.45 ui-monospace,monospace;z-index:9999;pointer-events:none;'
    + 'border-left:1px solid #2a2f35;border-top:1px solid #2a2f35';
  log.textContent = `recette « Graphe à plat » — profil ${profile}\n`
    + `${expected.nodes} nœuds, ${expected.edges} arêtes, ${expected.entries} entrée(s), `
    + `${expected.diagnosed} nœud(s) diagnostiqué(s), ${expected.groups} groupe(s)\n`
    + `${mediaReport.bindings} vignette(s) ${mediaReport.size}×${mediaReport.size} fabriquées\n`;
  document.body.append(log);

  // La surface doit avoir monté son moteur : la poignée n'apparaît qu'une fois
  // le graphe posé et la caméra installée.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !surfaceRef.current?.engine()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!surfaceRef.current?.engine()) {
    log.textContent += '\n■ arrêt : la surface n’a jamais posé son moteur.\n';
    return;
  }
  // Les vignettes partent par une file bornée à six lectures simultanées :
  // laisser le temps aux premières d'arriver avant de mesurer la charge.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await runSurfaceRecette({ profile, expected, mediaReport });
}
