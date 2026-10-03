// Le protocole de charge, écrit une fois et appliqué identiquement
// à chaque moteur.
//
// C'est un **banc d'essai comparatif, pas deux essais séparés** : même DTO,
// mêmes fixtures, mêmes gestes, même machine, canvas 2D forcé partout. Le code
// ci-dessous ne connaît aucun moteur : il ne parle qu'au contrat d'adaptateur.
//
// Ce qu'il mesure, et qu'il ne confond pas :
//
// - le **temps Rust** est mesuré ailleurs, dans la suite `graph_view::tests::bench` ;
// - la fixture est téléchargée **avant** le chronomètre : « les temps sont
//   mesurés après disponibilité du payload, hors extraction/décodage des
//   médias » ;
// - le **premier affichage exploitable** compte la construction de l'index, la
//   traduction en éléments, le montage et l'image effectivement peinte ;
// - le **premier chargement** et les **reprises** sont rapportés séparément.

import { buildGraphIndex } from '../../src/store/advancedGraphView/graphViewModel.js';
import { searchGraph } from '../../src/store/advancedGraphView/graphSearch.js';
import { toEngineElements } from '../../src/components/AdvancedGraphCanvas/engines/engineContract.js';
import { engineDescriptor } from './engines/index.js';

// Au moins cinq mesures pour les chargements.
export const LOAD_SAMPLES = 5;
// Au moins cent interactions pour les percentiles de sélection et de recherche.
export const INTERACTION_SAMPLES = 100;
// Une séquence pan/zoom de dix secondes.
export const PAN_ZOOM_SECONDS = 10;
// Le panoramique soutenu du criblage éliminatoire, en secondes.
export const SUSTAINED_PAN_SECONDS = 600;

// Budgets de temps par phase.
//
// Ils ne réduisent pas le protocole : les minimums — cinq chargements, cent
// interactions, dix secondes de panoramique — restent la cible. Ils bornent
// seulement ce qu'un moteur très lent peut coûter avant que le banc passe à la
// suite. **Un dépassement est un résultat consigné**, avec le nombre de mesures
// réellement prises, et non une panne qui emporterait la campagne.
//
// Une opération déjà commencée ne peut pas être interrompue : JavaScript est
// mono-thread et `await graph.render()` n'est pas annulable. Le budget est donc
// vérifié **entre** les opérations, et une phase peut le dépasser du coût d'une
// seule opération. C'est dit ici parce que le rapport doit le dire.
export const DEFAULT_BUDGET = Object.freeze({
  loadMs: 150_000,
  interactionsMs: 200_000,
  recycleMs: 150_000,
});

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// Vrai quand la WebView peint réellement.
//
// Une fenêtre qui n'est pas composée — minimisée, occultée, ou ouverte dans une
// session sans compositeur qui la présente — **suspend** `requestAnimationFrame`
// sans erreur. Le banc s'y arrêterait alors indéfiniment, à zéro pour cent de
// processeur, et un relevé d'images par seconde y serait dénué de sens.
//
// La sonde transforme ce piège en diagnostic : elle est la première chose que
// le banc fait, et son échec arrête la mesure au lieu de la fausser.
export async function probeFrameLoop({ timeoutMs = 3_000 } = {}) {
  const started = performance.now();
  let frames = 0;
  const counted = new Promise((resolve) => {
    const tick = () => {
      frames += 1;
      if (frames >= 3) resolve(true);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const timedOut = new Promise((resolve) => { setTimeout(() => resolve(false), timeoutMs); });
  const alive = await Promise.race([counted, timedOut]);
  return {
    alive,
    frames,
    elapsedMs: round(performance.now() - started),
    // `document.hidden` ne suffit pas : sous Wayland, une fenêtre non présentée
    // reste « visible » pour la page tout en ne recevant aucune image.
    documentHidden: document.hidden,
  };
}

// Une image **peinte**, pas seulement planifiée : deux `requestAnimationFrame`
// encadrent la peinture, et le second ne s'exécute qu'après elle.
async function paintedFrame() {
  await nextFrame();
  await nextFrame();
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

export function summarize(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(total / sorted.length),
  };
}

function round(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

// Le relevé mémoire du moteur JavaScript, quand la WebView l'expose.
//
// WebKitGTK n'expose pas `performance.memory` : le relevé y est fait **hors du
// processus**, sur la mémoire résidente du `WebKitWebProcess`, par le script
// d'échantillonnage du banc. Rendre `null` ici est donc un résultat, pas un
// échec — et le rapport doit dire lequel des deux relevés il cite.
export function jsHeapBytes() {
  const memory = performance.memory;
  if (!memory || typeof memory.usedJSHeapSize !== 'number') return null;
  return memory.usedJSHeapSize;
}

// Une trace de phase, postée au serveur de développement pour que
// l'échantillonnage mémoire externe sache ce qui se passait à cet instant.
async function markPhase(report, phase, detail = {}) {
  const mark = { at: Date.now(), phase, ...detail };
  report.phases.push(mark);
  try {
    await fetch('/__bench/phase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mark),
    });
  } catch {
    // Le banc doit tourner même sans serveur d'écriture : la trace reste dans
    // le rapport rendu à la fin.
  }
}

// Dimensions réellement allouées : le DPR de la fenêtre ne suffit pas quand
// un moteur force une densité différente ou emploie plusieurs calques.
export function canvasMetrics(container) {
  return [...container.querySelectorAll('canvas')].map(canvas => {
    const rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width, height: canvas.height,
      cssWidth: rect.width, cssHeight: rect.height,
      ratioX: rect.width ? canvas.width / rect.width : null,
      ratioY: rect.height ? canvas.height / rect.height : null,
    };
  });
}

// Une absence de heartbeat pendant un montage est un résultat indéterminé,
// jamais une preuve d'absence de gel. Les marques survivent aux profils qui
// n'aboutissent pas, dans le journal du serveur de développement.
export function probeResponsiveness({
  now = () => performance.now(),
  schedule = callback => setInterval(callback, 1000),
  cancel = handle => clearInterval(handle),
  onBeat = () => {},
} = {}) {
  let previous = now();
  let maxGapMs = 0;
  let beats = 0;
  const sample = () => {
    const current = now();
    maxGapMs = Math.max(maxGapMs, current - previous);
    previous = current;
    return { beats, maxEventLoopGapMs: round(maxGapMs) };
  };
  const handle = schedule(() => { beats++; onBeat(sample()); });
  return () => { cancel(handle); return sample(); };
}

// Un chargement complet : index, éléments, montage, image peinte.
async function measureLoad({ descriptor, container, view, detailLevel }) {
  const started = performance.now();
  const index = buildGraphIndex(view);
  const indexed = performance.now();
  const elements = toEngineElements(index);
  const translated = performance.now();
  const engine = await descriptor.create({ container });
  const created = performance.now();
  // Chaque commande est **attendue** : chez G6 elles rendent des promesses, et
  // ne pas les attendre mesurerait un montage qui n'a pas eu lieu.
  const counts = await engine.mount(elements);
  const expectedEdges = elements.edges.filter(edge => edge.target != null).length;
  if (counts.nodes !== elements.nodes.length || counts.edges !== expectedEdges) {
    engine.destroy();
    throw new Error('Le renderer a omis des éléments du DTO.');
  }
  await engine.fitContent();
  if (detailLevel) await engine.setDetailLevel(detailLevel);
  await paintedFrame();
  const painted = performance.now();
  return {
    engine,
    index,
    elements,
    counts,
    canvases: canvasMetrics(container),
    timings: {
      buildIndexMs: round(indexed - started),
      toElementsMs: round(translated - indexed),
      createEngineMs: round(created - translated),
      mountAndPaintMs: round(painted - created),
      firstUsablePaintMs: round(painted - started),
    },
  };
}

// Une séquence pan/zoom **scriptée** : les deux moteurs reçoivent exactement
// les mêmes déplacements, aux mêmes instants. Un geste à la main ne serait pas
// comparable d'un moteur à l'autre.
async function measurePanZoom(engine, { seconds, sampleHeap = false }) {
  const start = performance.now();
  const deadline = start + seconds * 1_000;
  const base = engine.getViewport();
  const frames = [];
  const heapSamples = [];
  let previous = start;
  let step = 0;

  while (performance.now() < deadline) {
    step += 1;
    const phase = step / 30;
    // Un panoramique circulaire et un zoom lent : le viewport ne revient jamais
    // exactement au même endroit, donc aucun cache de texture ne peut couvrir
    // toute la séquence.
    await engine.setViewport({
      x: base.x + Math.cos(phase) * 600,
      y: base.y + Math.sin(phase) * 400,
      zoom: base.zoom * (1 + 0.35 * Math.sin(phase / 3)),
    });
    await nextFrame();
    const now = performance.now();
    frames.push(now - previous);
    previous = now;
    if (sampleHeap && step % 60 === 0) {
      const heap = jsHeapBytes();
      if (heap !== null) heapSamples.push({ atMs: round(now - start), heap });
    }
  }

  const durations = summarize(frames);
  return {
    seconds,
    frames: frames.length,
    // Les images par seconde observées, dérivées des intervalles réels.
    fps: round(frames.length / ((previous - start) / 1_000)),
    // Le p95 des intervalles dit ce que les à-coups coûtent, là où une moyenne
    // les masque.
    frameIntervalMs: durations,
    heapSamples,
  };
}

// Sélection et recherche : au moins cent interactions, mesurées séparément.
async function measureInteractions(engine, index, budgetMs) {
  const paths = index.entries.map((entry) => entry.path);
  const selectionSamples = [];
  const searchSamples = [];
  const focusSamples = [];

  const needles = ['écran', 'action', '0f9c2a41', 'story', 'audio', 'zzz-introuvable'];
  const started = performance.now();
  let budgetExceeded = false;
  for (let step = 0; step < INTERACTION_SAMPLES; step += 1) {
    if (step > 0 && performance.now() - started > budgetMs) {
      budgetExceeded = true;
      break;
    }
    const path = paths[(step * 97) % paths.length];

    const selectionStart = performance.now();
    await engine.setSelection([path]);
    await nextFrame();
    selectionSamples.push(performance.now() - selectionStart);

    const focusStart = performance.now();
    await engine.focusNode(path);
    await nextFrame();
    focusSamples.push(performance.now() - focusStart);

    // La recherche est mesurée sur l'index, hors moteur : c'est bien le même
    // code pour les deux, et c'est ce que le contrat exige — la logique de
    // recherche ne connaît aucun moteur.
    const searchStart = performance.now();
    const found = searchGraph(index, { query: needles[step % needles.length] });
    searchSamples.push(performance.now() - searchStart);
    if (found.total < 0) throw new Error('recherche incohérente');
  }

  return {
    selection: summarize(selectionSamples),
    focus: summarize(focusSamples),
    search: summarize(searchSamples),
    // Combien d'interactions ont réellement été mesurées, et si la série a été
    // écourtée. Un percentile calculé sur douze mesures n'a pas le même poids
    // que sur cent, et le rapport doit pouvoir le dire.
    samples: selectionSamples.length,
    requestedSamples: INTERACTION_SAMPLES,
    budgetExceeded,
  };
}

// Le geste que les défauts ouverts d'AntV G6 nomment précisément, et que le
// criblage éliminatoire vise : destruction puis recréation du composant.
async function measureRecycle({ descriptor, container, view, cycles = 3, budgetMs }) {
  const samples = [];
  const heap = [];
  const started = performance.now();
  let budgetExceeded = false;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle > 0 && performance.now() - started > budgetMs) {
      budgetExceeded = true;
      break;
    }
    const loaded = await measureLoad({ descriptor, container, view });
    const destroyStart = performance.now();
    loaded.engine.destroy();
    await paintedFrame();
    samples.push(performance.now() - destroyStart);
    const measured = jsHeapBytes();
    if (measured !== null) heap.push(measured);
  }
  return {
    destroyMs: summarize(samples),
    heapAfterCycle: heap,
    cycles: samples.length,
    requestedCycles: cycles,
    budgetExceeded,
  };
}

// Le protocole complet, pour un moteur et un profil.
async function measureProfile({
  engineId,
  profile,
  view,
  container,
  sustainedPanSeconds = 0,
  detailLevel = null,
  budget = DEFAULT_BUDGET,
  report,
}) {
  const descriptor = engineDescriptor(engineId);
  await markPhase(report, 'profile:start', { engine: engineId, profile: profile.name });

  // Premier chargement et reprises sont **séparés** : le premier porte le coût
  // du chargement du module, du premier style et du premier canvas.
  //
  // Le dernier chargement réussi est conservé pour les phases suivantes ; les
  // précédents sont détruits au fur et à mesure, pour ne pas laisser cinq
  // graphes de 9 121 nœuds vivants en mémoire pendant la mesure.
  const loads = [];
  let kept = null;
  let loadBudgetExceeded = false;
  const loadStarted = performance.now();
  for (let sample = 0; sample < LOAD_SAMPLES; sample += 1) {
    if (kept) { kept.engine.destroy(); kept = null; }
    const loaded = await measureLoad({ descriptor, container, view, detailLevel });
    loads.push(loaded.timings);
    kept = loaded;
    await paintedFrame();
    if (performance.now() - loadStarted > budget.loadMs && sample < LOAD_SAMPLES - 1) {
      loadBudgetExceeded = true;
      break;
    }
  }

  const result = {
    engine: engineId,
    engineVersion: kept.engine.version,
    canvases: kept.canvases,
    profile: profile.name,
    counts: {
      declared: profile,
      mounted: kept.counts,
      // Le graphe reste **complet** dans le DTO : les arêtes pendantes n'ont
      // pas de cible et ne sont donc pas posables, mais elles sont comptées.
      danglingEdges: kept.elements.edges.filter((edge) => edge.dangling).length,
    },
    firstLoad: loads[0],
    reloads: summarize(loads.slice(1).map((timing) => timing.firstUsablePaintMs)),
    loadBreakdown: loads,
    loadSamples: loads.length,
    requestedLoadSamples: LOAD_SAMPLES,
    loadBudgetExceeded,
  };

  await markPhase(report, 'panzoom:start', { engine: engineId, profile: profile.name });
  result.panZoom = await measurePanZoom(kept.engine, { seconds: PAN_ZOOM_SECONDS, sampleHeap: true });
  await markPhase(report, 'panzoom:end', { engine: engineId, profile: profile.name });

  await markPhase(report, 'interactions:start', { engine: engineId, profile: profile.name });
  result.interactions = await measureInteractions(kept.engine, kept.index, budget.interactionsMs);
  await markPhase(report, 'interactions:end', { engine: engineId, profile: profile.name });

  if (sustainedPanSeconds > 0) {
    await markPhase(report, 'sustained:start', {
      engine: engineId,
      profile: profile.name,
      seconds: sustainedPanSeconds,
    });
    result.sustainedPan = await measurePanZoom(kept.engine, {
      seconds: sustainedPanSeconds,
      sampleHeap: true,
    });
    await markPhase(report, 'sustained:end', { engine: engineId, profile: profile.name });
  }

  kept.engine.destroy();
  await paintedFrame();

  await markPhase(report, 'recycle:start', { engine: engineId, profile: profile.name });
  result.recycle = await measureRecycle({
    descriptor,
    container,
    view,
    budgetMs: budget.recycleMs,
  });
  await markPhase(report, 'recycle:end', { engine: engineId, profile: profile.name });

  result.jsHeapBytes = jsHeapBytes();
  // Un profil dont une phase a dépassé son budget porte moins de mesures que
  // les autres. Le drapeau remonte au rapport pour que la comparaison le dise
  // au lieu de présenter les deux comme équivalents.
  result.budgetExceeded = loadBudgetExceeded
    || result.interactions.budgetExceeded
    || result.recycle.budgetExceeded;
  await markPhase(report, 'profile:end', { engine: engineId, profile: profile.name });
  return result;
}

export async function runProfile(options) {
  const { report, engineId, profile } = options;
  const stop = probeResponsiveness({ onBeat: sample => {
    void markPhase(report, 'profile:heartbeat', { engine: engineId, profile: profile.name, ...sample });
  } });
  try {
    const result = await measureProfile(options);
    result.responsiveness = stop();
    return result;
  } finally { stop(); }
}
