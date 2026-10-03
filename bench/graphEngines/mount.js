// Le banc d'essai comparatif des moteurs d'affichage.
//
// Il est monté **sans React** : le banc mesure un moteur de rendu, et un arbre
// de composants entre la mesure et le canvas ajouterait un coût qui
// n'appartient à aucun des deux moteurs.
//
// Lancement, depuis la WebView native — un navigateur de développement ne
// remplace pas une mesure WebView native :
//
// ```text
// node scripts/advanced-graph-fixtures.mjs
// cargo test --lib graph_view::tests::bench -- --ignored --nocapture   (dans src-tauri/)
// VITE_BENCH=graph npm run tauri:dev
// ```

import { FINALISTS, ENGINE_IDS, ENGINE_REGISTRY } from './engines/index.js';
import { probeFrameLoop, runProfile, SUSTAINED_PAN_SECONDS } from './protocol.js';

const FIXTURE_URL = (name) => `/__bench/fixture/${name}.view.json`;
const MANIFEST_URL = '/__bench/fixture/manifest.json';

// Étape 1 — criblage éliminatoire, bref, Fedora/WebKitGTK seulement.
//
// Ce scénario est choisi parce qu'il est précisément celui que nomment les
// défauts ouverts d'AntV G6 : calcul continu et pics mémoire au glissement,
// plantage au rendu de nombreux nœuds, blocage sur les exemples à grand volume.
// Un moteur qui **plante, gèle ou fuit** est éliminé ici, avec son
// contre-exemple. Un moteur seulement *lent* ne l'est pas.
const SCREENING_PROFILES = ['max-9121', 'dense-21176'];

// Étape 2 — protocole complet, sur les survivants uniquement.
const FULL_PROFILES = [
  'mediane-124',
  'p90-795',
  'max-9121',
  'actions-2078',
  'dense-21176',
  'roues-100-101',
  'projete-376960',
  'degrade-gvi',
];

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function postResult(payload) {
  try {
    const response = await fetch('/__bench/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok ? (await response.json()).file : null;
  } catch (error) {
    return `non écrit (${error.message})`;
  }
}

export async function mount() {
  document.title = 'Banc d\'essai — moteurs de graphe';
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;font:13px system-ui,sans-serif;background:#101215;color:#e8eaed';

  const log = element('pre', {
    style: 'margin:0;padding:8px 12px;height:26vh;overflow:auto;background:#0a0c0e;'
      + 'border-bottom:1px solid #2a2f35;white-space:pre-wrap;font-size:12px',
  });
  const canvasHost = element('div', {
    id: 'bench-canvas',
    style: 'position:relative;height:74vh;width:100vw;background:#15181c',
  });
  const controls = element('div', {
    style: 'position:absolute;z-index:10;top:8px;left:8px;display:flex;gap:8px;flex-wrap:wrap',
  });
  canvasHost.append(controls);
  document.body.append(log, canvasHost);

  const write = (line) => {
    log.append(`${line}\n`);
    log.scrollTop = log.scrollHeight;
  };

  write('Banc d\'essai comparatif — même DTO, mêmes fixtures, mêmes gestes, canvas 2D forcé.');
  write(`WebView : ${navigator.userAgent}`);
  write(`Écran : ${window.innerWidth}x${window.innerHeight} @ dpr ${window.devicePixelRatio}`);

  // Première chose faite, avant toute fixture : la WebView peint-elle ?
  const frameLoop = await probeFrameLoop();
  if (!frameLoop.alive) {
    write('');
    write('ARRÊT : la WebView ne peint aucune image (requestAnimationFrame suspendu).');
    write(`  sonde : ${frameLoop.frames} image(s) en ${frameLoop.elapsedMs} ms, document.hidden=${frameLoop.documentHidden}`);
    write('  Cause habituelle : la fenêtre n\'est pas composée — minimisée, occultée,');
    write('  ou lancée dans une session sans compositeur qui la présente.');
    write('  Toute mesure d\'images par seconde serait ici dénuée de sens : le banc s\'arrête.');
    await postResult({
      label: 'sonde-echouee',
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      frameLoop,
      results: [],
      failures: [{ stage: 'frame-loop', message: 'requestAnimationFrame suspendu' }],
    });
    return;
  }
  write(`Boucle d'images vivante : ${frameLoop.frames} images en ${frameLoop.elapsedMs} ms.`);

  let manifest = [];
  try {
    manifest = await (await fetch(MANIFEST_URL)).json();
    write(`Manifeste : ${manifest.length} profils.`);
  } catch (error) {
    write(`ERREUR : manifeste introuvable (${error.message}).`);
    write('Lancer d\'abord : node scripts/advanced-graph-fixtures.mjs');
    return;
  }

  const profileByName = new Map(manifest.map((profile) => [profile.name, profile]));
  const viewCache = new Map();

  async function loadView(name) {
    if (viewCache.has(name)) return viewCache.get(name);
    const started = performance.now();
    const response = await fetch(FIXTURE_URL(name));
    if (!response.ok) throw new Error(`vue ${name} absente : lancer la recette Rust`);
    const text = await response.text();
    const fetched = performance.now();
    const view = JSON.parse(text);
    const parsed = performance.now();
    // Le transport et l'analyse du DTO sont mesurés et **rapportés à part** :
    // ils ne sont pas imputés à un moteur, puisqu'ils sont identiques pour les
    // deux. Sur les gros profils, ils dominent le chargement.
    write(
      `  DTO ${name} : ${(text.length / 1e6).toFixed(2)} Mo, `
      + `transport ${Math.round(fetched - started)} ms, JSON.parse ${Math.round(parsed - fetched)} ms`,
    );
    viewCache.set(name, view);
    return view;
  }

  function container() {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    canvasHost.append(host);
    return host;
  }

  async function run({ label, engines, profiles, sustainedPanSeconds }) {
    const report = {
      label,
      // Identifiant stable de la campagne : le serveur réécrit **le même**
      // fichier à chaque envoi. Une campagne interrompue laisse donc tout ce
      // qu'elle avait déjà mesuré, au lieu de ne rien laisser du tout.
      runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`,
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      // Ce que le banc **force** : le canvas 2D partout, pour les deux
      // finalistes comme pour le témoin.
      renderer: 'canvas-2d',
      phases: [],
      results: [],
      failures: [],
    };
    controls.querySelectorAll('button').forEach((button) => { button.disabled = true; });

    for (const name of profiles) {
      const profile = profileByName.get(name);
      if (!profile) {
        write(`  profil ${name} absent du manifeste — ignoré`);
        continue;
      }
      let view;
      try {
        view = await loadView(name);
      } catch (error) {
        write(`  ${name} : ${error.message}`);
        report.failures.push({ profile: name, stage: 'fixture', message: error.message });
        continue;
      }

      for (const engineId of engines) {
        const host = container();
        write(`\n▶ ${ENGINE_REGISTRY[engineId].label} — ${name} (${profile.nodes} nœuds, ${profile.edges} arêtes)`);
        try {
          const result = await runProfile({
            engineId,
            profile,
            view,
            container: host,
            sustainedPanSeconds,
            report,
          });
          report.results.push(result);
          write(
            `  premier affichage ${result.firstLoad.firstUsablePaintMs} ms`
            + ` (index ${result.firstLoad.buildIndexMs} + éléments ${result.firstLoad.toElementsMs}`
            + ` + montage ${result.firstLoad.mountAndPaintMs})`,
          );
          write(`  reprises médiane ${result.reloads?.median} ms, p95 ${result.reloads?.p95} ms`);
          write(`  pan/zoom ${result.panZoom.fps} i/s, intervalle p95 ${result.panZoom.frameIntervalMs.p95} ms`);
          write(
            `  sélection p95 ${result.interactions.selection.p95} ms,`
            + ` recherche p95 ${result.interactions.search.p95} ms,`
            + ` cadrage p95 ${result.interactions.focus.p95} ms`,
          );
          if (result.sustainedPan) {
            write(
              `  panoramique soutenu ${result.sustainedPan.seconds} s :`
              + ` ${result.sustainedPan.fps} i/s, ${result.sustainedPan.heapSamples.length} relevés de tas`,
            );
          }
          write(`  destruction/recréation médiane ${result.recycle.destroyMs?.median} ms`);
        } catch (error) {
          // Un plantage est un **résultat** du criblage, pas une panne du banc :
          // il est consigné avec son contre-exemple et la mesure continue.
          write(`  ÉCHEC ${engineId}/${name} : ${error?.message ?? error}`);
          report.failures.push({
            engine: engineId,
            profile: name,
            stage: 'protocol',
            message: String(error?.message ?? error),
            stack: String(error?.stack ?? ''),
          });
        } finally {
          host.remove();
        }
        // Écriture **après chaque** moteur-profil. C'est la leçon de la
        // campagne perdue : un relevé écrit seulement à la fin est un relevé
        // qu'un profil non borné peut emporter entièrement.
        report.finishedAt = new Date().toISOString();
        report.complete = false;
        const partial = await postResult(report);
        write(`  ↳ relevé intermédiaire : ${partial ?? 'non écrit'}`);
      }
    }

    report.finishedAt = new Date().toISOString();
    report.complete = true;
    const file = await postResult(report);
    write(`\n■ ${label} terminé. Relevé : ${file ?? 'non écrit'}`);
    controls.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    return report;
  }

  // Plan « captures » : monter chaque moteur sur un profil lisible, cadrer, et
  // composer **le rendu complet** — le PNG du moteur, plus la couche de
  // surimpressions que la surface publie. Le PNG seul montrait un graphe sans
  // un seul nom, badge ni zone de groupe : ce n'était plus la preuve visuelle
  // annoncée, seulement la moitié peinte par le canvas.
  async function capture(profileName) {
    const profile = profileByName.get(profileName);
    if (!profile) return;
    const view = await loadView(profileName);
    const { buildGraphIndex } = await import('../../src/store/advancedGraphView/graphViewModel.js');
    const { toEngineElements } = await import('../../src/components/AdvancedGraphCanvas/engines/engineContract.js');
    const { captureGraphSurface } = await import('../../src/components/AdvancedGraphCanvas/graphSurfaceCapture.js');
    for (const engineId of FINALISTS) {
      const host = container();
      try {
        const index = buildGraphIndex(view);
        let overlay = null;
        const engine = await ENGINE_REGISTRY[engineId].create({
          container: host,
          onOverlayChange: (published) => { overlay = published; },
        });
        await engine.mount(toEngineElements(index));
        // Cadrage par la primitive **du moteur** : deux vues également
        // remplies, donc deux captures comparables.
        await engine.fitContent();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dataUrl = await captureGraphSurface({
          engine,
          overlay,
          size: { width: host.clientWidth, height: host.clientHeight },
        });
        if (dataUrl) {
          const response = await fetch('/__bench/capture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: `canvas-${profileName}-${engineId}`, dataUrl }),
          });
          write(`  capture ${engineId}/${profileName} : ${response.ok ? 'écrite' : 'refusée'}`);
        } else {
          write(`  capture ${engineId}/${profileName} : le moteur n'a rien rendu`);
        }
        engine.destroy();
      } catch (error) {
        write(`  capture ${engineId}/${profileName} : ${error.message}`);
      } finally {
        host.remove();
      }
    }
  }

  const button = (label, handler) => {
    const node = element('button', {
      style: 'padding:6px 10px;background:#22303c;color:#e8eaed;border:1px solid #3a4753;'
        + 'border-radius:4px;cursor:pointer;font:12px system-ui',
    }, [label]);
    node.addEventListener('click', handler);
    controls.append(node);
    return node;
  };

  button('Étape 1 — criblage', () => run({
    label: 'etape-1-criblage',
    engines: FINALISTS,
    profiles: SCREENING_PROFILES,
    sustainedPanSeconds: SUSTAINED_PAN_SECONDS,
  }));
  button('Étape 1 — criblage court (60 s)', () => run({
    label: 'etape-1-criblage-court',
    engines: FINALISTS,
    profiles: SCREENING_PROFILES,
    sustainedPanSeconds: 60,
  }));
  button('Étape 2 — protocole complet', () => run({
    label: 'etape-2-complet',
    engines: FINALISTS,
    profiles: FULL_PROFILES,
    sustainedPanSeconds: 0,
  }));
  button('Captures du rendu', () => capture('p90-795'));
  button('Témoin vis-network', () => run({
    label: 'temoin-vis-network',
    engines: [ENGINE_IDS.VIS_NETWORK],
    profiles: SCREENING_PROFILES,
    sustainedPanSeconds: 0,
  }));

  // Lancement automatique : la fenêtre de `tauri dev` s'ouvre sur l'URL de
  // développement, sans barre d'adresse et sans paramètre de requête. Le plan
  // à jouer vient donc d'une variable d'environnement, que Vite inscrit à la
  // compilation ; le paramètre de requête reste accepté pour un navigateur.
  const auto = new URLSearchParams(window.location.search).get('run')
    ?? import.meta.env.VITE_BENCH_RUN
    ?? null;
  if (auto) {
    write(`\nLancement automatique : ${auto}`);
    const plans = {
      'etape-1': { label: 'etape-1-criblage', engines: FINALISTS, profiles: SCREENING_PROFILES, sustainedPanSeconds: SUSTAINED_PAN_SECONDS },
      'etape-1-court': { label: 'etape-1-criblage-court', engines: FINALISTS, profiles: SCREENING_PROFILES, sustainedPanSeconds: 60 },
      'etape-2': { label: 'etape-2-complet', engines: FINALISTS, profiles: FULL_PROFILES, sustainedPanSeconds: 0 },
      temoin: { label: 'temoin-vis-network', engines: [ENGINE_IDS.VIS_NETWORK], profiles: SCREENING_PROFILES, sustainedPanSeconds: 0 },
    };
    if (auto === 'captures') {
      await capture('p90-795');
      await capture('mediane-124');
      write('\n■ captures terminées.');
      return;
    }
    if (plans[auto]) await run(plans[auto]);
  }
}
