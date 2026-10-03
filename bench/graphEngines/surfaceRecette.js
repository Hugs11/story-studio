// La recette Tauri de la surface du graphe, exécutée dans WebKitGTK.
//
// Elle existe parce que des correctifs de la surface avancée ont été livrés
// sans avoir été vus à l'écran : leurs preuves étaient des rendus statiques et
// des appels de gestionnaires sous Node. Un `border-color` refusé par le
// parseur du moteur, un anneau de 56 unités de graphe qui mesure un demi-pixel
// à 1 %, une miniature `pointer-events:none` — aucun de ces défauts ne se voit
// dans un rendu sans navigateur. Ils se voient ici.
//
// Ce qu'elle prouve, et c'est tout ce qu'elle prétend :
//
// - la WebView **peint** (sonde d'images, sans quoi les mesures ne veulent rien
//   dire) ;
// - les couleurs modernes de `variables.css` sont réellement converties par
//   cette WebView-ci, et la bascule de thème relit la palette du moteur **sans
//   remonter le document** ;
// - aux quatre régimes de détail, ce qui est peint est ce que la planche
//   demande, mesuré en **pixels écran** et non en unités de graphe ;
// - les libellés ne se chevauchent pas au-delà d'un seuil mesuré ;
// - la miniature pilote la caméra à la souris **et** au clavier ;
// - au cadrage large d'un pack de 9 121 nœuds, l'entrée et les nœuds à corriger
//   restent trouvables sans connaître leur nom ;
// - le pan/zoom tient une cadence **mesurée**, au zoom de travail et au cadrage
//   large, vignettes chargées, avec le nombre de surimpressions consigné.
//
// Ce qu'elle ne prouve pas, et qu'elle ne doit pas laisser croire :
//
// - **les gestes matériels.** Les événements sont synthétiques. Ils entrent par
//   les mêmes gestionnaires que la souris et le clavier réels, ce qui est
//   beaucoup plus qu'un appel de fonction sous Node, mais ce n'est pas la
//   chaîne d'entrée du compositeur. Un défaut de capture de pointeur, de
//   défilement par inertie ou de pincement de trackpad lui échappe.
// - **le confort et le goût.** Un chevauchement se compte ; un équilibre
//   typographique se regarde. La recette rend les captures pour cela, elle ne
//   prononce pas le verdict.
// - **les autres plateformes.** Ce qui est écrit ici est Fedora/WebKitGTK.
//   Windows et macOS restent à déclarer séparément.

const RESULT_LABEL = 'recette-graphe-a-plat';

// Les seuils de `graphRenderTier`, encadrés au millième : c'est la seule façon
// de montrer qu'un régime tombe **à** son seuil et pas à côté.
const TIER_LADDER = [
  { zoom: 2.5, expect: 'full', why: 'gros zoom : la carte suit le zoom, les textes non' },
  { zoom: 1, expect: 'full', why: 'zoom de travail' },
  { zoom: 0.6, expect: 'full', why: 'juste au-dessus du seuil des noms' },
  { zoom: 0.56, expect: 'full', why: 'dernier centième avant la chute des noms' },
  { zoom: 0.54, expect: 'noLabels', why: 'les noms tombent' },
  { zoom: 0.52, expect: 'noLabels', why: 'échelle de référence du design' },
  { zoom: 0.11, expect: 'noLabels', why: 'échelle de référence du design' },
  { zoom: 0.07, expect: 'noLabels', why: 'échelle de référence du design' },
  { zoom: 0.051, expect: 'noLabels', why: 'dernier millième avant la chute des vignettes' },
  { zoom: 0.049, expect: 'noThumbs', why: 'les vignettes tombent' },
  { zoom: 0.031, expect: 'noThumbs', why: 'dernier millième avant le régime éloigné' },
  { zoom: 0.029, expect: 'simplified', why: 'régime éloigné : repères seuls' },
];

// Un chevauchement n'est pas un défaut en soi : deux libellés peuvent se
// toucher d'un pixel sans gêner personne. Le seuil compte une intersection
// comme réelle au-delà de ce recouvrement, en pixels carrés.
const OVERLAP_AREA_PX = 12;

// Le palier de pan/zoom : dix secondes, comme le protocole du banc comparatif.
const PAN_ZOOM_SECONDS = 10;
// Une image au-delà de ce budget est « longue » : 50 ms, soit trois images
// manquées à 60 Hz. Le relevé donne aussi les percentiles bruts.
const LONG_FRAME_MS = 50;

let suspendedFrames = 0;

// Deux images, avec la minuterie en filet.
//
// Une fenêtre non composée — minimisée, occultée, ou dans une session sans
// compositeur qui la présente — **suspend** `requestAnimationFrame` sans
// erreur. Une recette qui n'attendrait que des images s'arrêterait alors
// indéfiniment, à zéro pour cent de processeur, et passerait pour un blocage du
// produit. Le relevé dit laquelle des deux a gagné.
function settle(timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (byTimer) => {
      if (settled) return;
      settled = true;
      if (byTimer) suspendedFrames += 1;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(() => finish(false)));
    setTimeout(() => finish(true), timeoutMs);
  });
}

// La sonde de peinture : la première chose que fait la recette, et son échec
// arrête tout au lieu de fausser la suite.
async function paintProbe(timeoutMs = 4000) {
  const start = performance.now();
  let frames = 0;
  await new Promise((resolve) => {
    const tick = () => {
      frames += 1;
      if (frames >= 6 || performance.now() - start > timeoutMs) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const elapsed = performance.now() - start;
  return { frames, elapsedMs: Math.round(elapsed), painting: frames >= 6 && elapsed < timeoutMs };
}

// Aucun pas n'est réputé réussi : chacun porte son verdict et ce qu'il a vu.
function step(name, held, observed, extra = {}) {
  return { name, held: held === true, observed, ...extra };
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function surface() {
  return window.__recette?.surface?.current ?? null;
}

function zoomOutput() {
  const text = $('[aria-label="Niveau de zoom"]')?.textContent ?? '';
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Le cadrage exact passe par la primitive du moteur — la même que les boutons
// appellent. Sans elle, on ne peut pas se poser **au** centième d'un seuil, et
// c'est justement ce que la planche demande de vérifier.
async function setZoom(zoom) {
  const handle = surface();
  const engine = handle?.engine();
  if (!engine) return null;
  const size = handle.size();
  const current = engine.getViewport();
  const graphX = (size.width / 2 - current.x) / current.zoom;
  const graphY = (size.height / 2 - current.y) / current.zoom;
  await engine.setViewport({
    x: size.width / 2 - graphX * zoom,
    y: size.height / 2 - graphY * zoom,
    zoom,
  });
  await settle();
  await settle();
  return engine.getViewport();
}

// --- Mesures de la couche HTML ----------------------------------------------

// Les boîtes réellement occupées, telles que la WebView les a mises en page.
// C'est la mesure que Node ne peut pas rendre : sans moteur de mise en page, un
// `getBoundingClientRect` est nul partout.
function measuredBoxes(selector) {
  return $$(selector)
    .map((element) => {
      const box = element.getBoundingClientRect();
      return {
        width: Math.round(box.width * 100) / 100,
        height: Math.round(box.height * 100) / 100,
        x: Math.round(box.left * 100) / 100,
        y: Math.round(box.top * 100) / 100,
        text: (element.textContent ?? '').trim(),
        fontPx: Math.round(Number.parseFloat(getComputedStyle(element).fontSize) * 100) / 100,
      };
    })
    .filter((box) => box.width > 0 && box.height > 0);
}

// Comptage des recouvrements par grille : comparer 600 boîtes deux à deux fait
// 180 000 paires par palier. La grille ramène le travail au voisinage réel, et
// le résultat est le même.
function countOverlaps(boxes, minArea = OVERLAP_AREA_PX) {
  if (boxes.length < 2) return { pairs: 0, worstArea: 0 };
  const cell = 64;
  const buckets = new Map();
  const key = (cx, cy) => `${cx}:${cy}`;
  boxes.forEach((box, index) => {
    const x0 = Math.floor(box.x / cell);
    const x1 = Math.floor((box.x + box.width) / cell);
    const y0 = Math.floor(box.y / cell);
    const y1 = Math.floor((box.y + box.height) / cell);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const at = key(cx, cy);
        const list = buckets.get(at);
        if (list) list.push(index);
        else buckets.set(at, [index]);
      }
    }
  });
  const seen = new Set();
  let pairs = 0;
  let worstArea = 0;
  for (const list of buckets.values()) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const left = Math.min(list[a], list[b]);
        const right = Math.max(list[a], list[b]);
        const at = `${left}|${right}`;
        if (seen.has(at)) continue;
        seen.add(at);
        const one = boxes[left];
        const two = boxes[right];
        const overlapX = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
        const overlapY = Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const area = overlapX * overlapY;
        if (area > worstArea) worstArea = area;
        if (area >= minArea) pairs += 1;
      }
    }
  }
  return { pairs, worstArea: Math.round(worstArea) };
}

// Ce que la couche HTML porte, à l'instant du relevé. Les compteurs sont
// nommés comme la planche les nomme, pour qu'une comparaison côte à côte
// n'ait pas à traduire.
function overlayCensus() {
  const labels = measuredBoxes('.advanced-node-overlay__label');
  return {
    cards: $$('.advanced-node-overlay').length,
    labels: labels.length,
    labelFontPx: labels.length > 0 ? labels[0].fontPx : null,
    badges: $$('.advanced-node-overlay__badge').length,
    actionCounts: $$('.advanced-node-overlay__action-count').length,
    groupZones: $$('.advanced-group-overlay').length,
    selectionRings: $$('.advanced-node-overlay__selection').length,
    landmarks: {
      total: $$('.advanced-landmark').length,
      entry: $$('.advanced-landmark--entry').length,
      warning: $$('.advanced-landmark--warning').length,
      hub: $$('.advanced-landmark--hub').length,
      selected: $$('.advanced-landmark--selected').length,
    },
    labelOverlaps: countOverlaps(labels),
    // Les noms du régime éloigné se mesurent aussi. Une première version ne
    // comptait que les noms de carte : au régime éloigné il n'y a plus de
    // carte, et les chevauchements des repères passaient donc inaperçus alors
    // qu'ils sont visibles à l'écran.
    landmarkNameOverlaps: countOverlaps(
      measuredBoxes('.advanced-landmark__name, .advanced-landmark__tag'),
    ),
  };
}

// La place que les repères d'avertissement prennent réellement à l'écran.
//
// C'est la mesure qui manquait le plus. Tous les contrôles de repère peuvent
// passer — l'entrée est là, son anneau fait 56 px, il porte « ENTRÉE » — et
// l'écran être inutilisable : sur un pack dont la moitié des nœuds porte un
// avertissement, les anneaux se touchent et forment un aplat dans lequel
// l'entrée ne se distingue plus. Le critère de recette est « retrouver
// l'entrée sans connaître son nom », pas « l'entrée est dans le DOM ».
function landmarkCrowding() {
  const stage = $('.advanced-canvas__stage') ?? $('.advanced-canvas__host');
  const box = stage?.getBoundingClientRect();
  if (!box || box.width === 0) return null;
  const viewport = box.width * box.height;
  const rings = $$('.advanced-landmark--warning i').map((element) => element.getBoundingClientRect());
  const ringArea = rings.reduce((sum, ring) => sum + ring.width * ring.height, 0);
  const names = measuredBoxes('.advanced-landmark__name');
  const nameArea = names.reduce((sum, name) => sum + name.width * name.height, 0);
  return {
    anneauxAvertissement: rings.length,
    partDeLaSceneCouverteParLesAnneaux: Math.round((ringArea / viewport) * 1000) / 1000,
    partDeLaSceneCouverteParLesNoms: Math.round((nameArea / viewport) * 1000) / 1000,
    nomsRepere: names.length,
    recouvrementsDeNoms: countOverlaps(names),
  };
}

// --- Capture ----------------------------------------------------------------

// La capture vient du **moteur qui a peint**, composée avec le relevé de
// surimpressions que la surface a publié : c'est `captureGraphSurface`, la
// méthode prévue pour cela. Rien de ce qui se trouve à l'écran au même
// moment ne peut s'y retrouver — ce n'est pas une capture d'écran.
async function capture(name) {
  const handle = surface();
  const profile = window.__recette?.profile ?? 'sans-profil';
  const engine = handle?.engine();
  if (!engine) return { name, written: false, reason: 'moteur absent' };
  const { captureGraphSurface } = await import('../../src/components/AdvancedGraphCanvas/graphSurfaceCapture.js');
  const dataUrl = await captureGraphSurface({
    engine,
    overlay: handle.overlay(),
    size: handle.size(),
  });
  if (!dataUrl) return { name, written: false, reason: 'le moteur n’a rien rendu' };
  const response = await fetch('/__bench/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${profile}-${name}`, dataUrl }),
  });
  return { name: `${profile}-${name}`, written: response.ok };
}

// --- R1 : thème -------------------------------------------------------------

// L'empreinte du rendu peint, sur les **pixels opaques seulement**.
//
// Deux pièges ont été rencontrés ici, et tous deux faisaient accuser le produit
// à tort :
//
// 1. la grille tournait au cadrage d'ouverture, qui tombe au régime éloigné sur
//    un gros pack. Le moteur n'y peint presque rien — la couche HTML porte les
//    repères — et la grille ne ramenait que du transparent : les deux thèmes
//    rendaient la même empreinte. Les pixels transparents sont donc écartés et
//    leur nombre est consigné ;
// 2. l'égalité **stricte** de deux relectures du même thème n'est pas tenable.
//    Cytoscape redessine par calques, avec sa propre mise en cache, et les
//    vignettes arrivent par une file bornée : deux relevés pris à quelques
//    images d'écart peuvent différer de quelques pixels sans qu'aucune palette
//    n'ait changé. La comparaison porte donc sur une **part d'échantillons
//    différents**, avec deux seuils nommés.
function paintedSignature() {
  const layers = $$('.advanced-canvas__host canvas');
  if (layers.length === 0) return null;
  const samples = [];
  let probed = 0;
  for (const [index, layer] of layers.entries()) {
    const context = layer.getContext('2d');
    if (!context) continue;
    const stepX = Math.max(1, Math.floor(layer.width / 24));
    const stepY = Math.max(1, Math.floor(layer.height / 24));
    for (let y = stepY; y < layer.height; y += stepY) {
      for (let x = stepX; x < layer.width; x += stepX) {
        try {
          probed += 1;
          const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
          if (alpha === 0) continue;
          samples.push({ at: `${index}:${x}:${y}`, value: `${red},${green},${blue},${alpha}` });
        } catch {
          // Un calque dont les pixels ne sont pas lisibles ne disqualifie pas
          // les autres ; le compte d'échantillons le dit.
        }
      }
    }
  }
  return { samples, opaque: samples.length, probed, layers: layers.length };
}

// Une palette change quand plus d'un dixième des échantillons comparables
// change ; deux relectures du même thème sont tenues pour identiques sous deux
// pour cent. Entre les deux, la recette ne tranche pas et le dit.
const PALETTE_CHANGED_RATIO = 0.1;
const PALETTE_STABLE_RATIO = 0.02;

// La part d'échantillons qui diffèrent, sur les seuls points relevés **des deux
// côtés** : un point peint dans un thème et transparent dans l'autre n'est pas
// une divergence de couleur, et le compter en ferait une.
function signatureDelta(left, right) {
  if (!left || !right) return null;
  const rightByPoint = new Map(right.samples.map((sample) => [sample.at, sample.value]));
  let shared = 0;
  let different = 0;
  for (const sample of left.samples) {
    const other = rightByPoint.get(sample.at);
    if (other === undefined) continue;
    shared += 1;
    if (other !== sample.value) different += 1;
  }
  return {
    communs: shared,
    differents: different,
    part: shared > 0 ? Math.round((different / shared) * 1000) / 1000 : null,
  };
}

// Attendre que la charge des vignettes **cesse de bouger**.
//
// Les vignettes partent par une file bornée à six lectures simultanées, et le
// moteur repeint à chaque arrivée. Mesurer une palette pendant cette montée
// comparait deux rendus dont les images n'étaient pas les mêmes, et faisait
// échouer un pas qui n'avait rien à voir.
async function waitForThumbnails(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const loaded = overlayLoad().ecransAvecVignette;
    if (loaded === previous) stable += 1;
    else stable = 0;
    previous = loaded;
    if (stable >= 3) return { vignettesChargees: loaded, stabilise: true };
    await settle(400);
  }
  return { vignettesChargees: previous, stabilise: false };
}

async function themeSteps() {
  const { applyThemePreference, loadThemePreference } = await import('../../src/store/themePreference.js');
  const { toRenderableColor } = await import('../../src/components/AdvancedGraphCanvas/engines/engineColors.js');
  const host = $('.advanced-canvas__host');
  const steps = [];

  // Le thème se juge là où le moteur **peint des cartes**. Au régime éloigné
  // il ne peint quasiment rien, et une comparaison de pixels n'y mesurerait
  // que du vide. Et il se juge une fois les vignettes posées : sinon deux
  // relevés comparent deux jeux d'images différents.
  await setZoom(1);
  const thumbnails = await waitForThumbnails();

  // Garde contre le succès creux : si la variable d'accent n'emploie plus de
  // syntaxe moderne, ce contrôle n'a plus rien à prouver, et la recette
  // doit le dire au lieu de conclure.
  const rawAccent = getComputedStyle(host).getPropertyValue('--accent').trim();
  const modern = /oklch|color-mix/i.test(rawAccent);
  const converted = toRenderableColor(rawAccent, window);
  steps.push(step(
    'la WebView convertit l’accent du thème en sRGB',
    modern ? /^#[0-9a-f]{6}$|^rgba\(/i.test(String(converted)) : null,
    { rawAccent, converted, syntaxeModerne: modern },
    modern ? {} : { sansObjet: 'l’accent n’emploie plus oklch()/color-mix() : rien à convertir' },
  ));

  const initialPreference = loadThemePreference();
  steps.push(step(
    'la charge des vignettes se stabilise avant la mesure',
    thumbnails.stabilise,
    thumbnails,
  ));

  const layersBefore = $$('.advanced-canvas__host canvas');
  const atMount = paintedSignature();

  // Trois bascules, pas une.
  //
  // Une première version comparait l'empreinte après un aller clair → sombre à
  // celle du montage, et concluait au défaut quand elles différaient. C'est le
  // mauvais critère : au montage, `themeEpoch` vaut zéro et `refreshTheme()`
  // n'a jamais tourné, si bien qu'une différence peut venir de l'écart entre la
  // palette **construite au montage** et la palette **relue**, et non d'une
  // bascule qui échoue. Ce qui se vérifie vraiment : la palette change, et deux
  // relectures du même thème donnent le même rendu. L'écart montage/relecture
  // est mesuré et rendu à part, en diagnostic.
  const cycle = [];
  for (const preference of ['light', 'dark', 'light', 'dark']) {
    applyThemePreference(preference);
    await settle();
    await settle();
    cycle.push({ preference, signature: paintedSignature() });
  }
  const layersAfter = $$('.advanced-canvas__host canvas');
  const [light1, dark1, light2, dark2] = cycle;

  const sameLayers = layersBefore.length > 0
    && layersBefore.length === layersAfter.length
    && layersBefore.every((layer, index) => layer === layersAfter[index]);

  steps.push(step(
    'la bascule de thème ne remonte pas le document',
    sameLayers,
    { calquesAvant: layersBefore.length, calquesApres: layersAfter.length, memesElements: sameLayers },
  ));

  const opaque = (entry) => entry?.signature?.opaque ?? 0;
  const changed = signatureDelta(light1?.signature, dark1?.signature);
  const comparable = opaque(light1) > 0 && opaque(dark1) > 0 && (changed?.communs ?? 0) > 0;
  steps.push(step(
    'le canvas change de palette à chaud',
    comparable ? changed.part >= PALETTE_CHANGED_RATIO : null,
    {
      pixelsOpaquesClair: opaque(light1),
      pixelsOpaquesSombre: opaque(dark1),
      pixelsSondes: light1?.signature?.probed ?? 0,
      cartesPeintes: $$('.advanced-node-overlay').length,
      ecart: changed,
      seuil: PALETTE_CHANGED_RATIO,
    },
    comparable ? {} : { sansObjet: 'aucun échantillon opaque commun : rien à comparer' },
  ));

  const lightStable = signatureDelta(light1?.signature, light2?.signature);
  const darkStable = signatureDelta(dark1?.signature, dark2?.signature);
  const stable = (lightStable?.communs ?? 0) > 0 && (darkStable?.communs ?? 0) > 0;
  steps.push(step(
    'deux relectures du même thème rendent le même dessin',
    stable
      ? lightStable.part <= PALETTE_STABLE_RATIO && darkStable.part <= PALETTE_STABLE_RATIO
      : null,
    { clair: lightStable, sombre: darkStable, seuil: PALETTE_STABLE_RATIO },
    stable ? {} : { sansObjet: 'aucun échantillon opaque commun : rien à comparer' },
  ));

  // Diagnostic, sans verdict : le montage construit sa palette sans passer par
  // `refreshTheme()`. Si les deux diffèrent, c'est cet écart-là qu'il faut
  // regarder, et non la bascule.
  const mountDelta = cycle
    .map((entry) => signatureDelta(atMount, entry.signature))
    .filter((delta) => delta !== null && delta.communs > 0);
  const closest = mountDelta.length > 0
    ? mountDelta.reduce((best, delta) => (delta.part < best.part ? delta : best))
    : null;
  steps.push(step(
    'diagnostic : la palette du montage se retrouve après relecture',
    closest ? closest.part <= PALETTE_STABLE_RATIO : null,
    {
      preferenceAuDemarrage: initialPreference,
      pixelsOpaquesAuMontage: opaque({ signature: atMount }),
      ecartLePlusProche: closest,
      note: 'au montage `themeEpoch` vaut 0 et `refreshTheme()` n\u2019a pas tourné ;'
        + ' un écart ici désigne la construction initiale, pas la bascule',
    },
    closest ? {} : { sansObjet: 'aucun échantillon opaque au montage : rien à comparer' },
  ));

  applyThemePreference('light');
  await settle();
  const lightCensus = overlayCensus();
  const lightCapture = await capture('r1-theme-clair');
  applyThemePreference('dark');
  await settle();
  const darkCapture = await capture('r1-theme-sombre');
  // La préférence de l'utilisateur est rendue : la recette ne laisse pas
  // l'application dans le thème qu'elle a imposé pour mesurer.
  applyThemePreference(initialPreference);
  await settle();

  return { steps, lightCensus, captures: [lightCapture, darkCapture] };
}

// --- R2 : régimes de détail -------------------------------------------------

async function tierSteps() {
  const { graphRenderTier } = await import('../../src/components/AdvancedGraphCanvas/useGraphCanvasEngine.js');
  const rungs = [];
  for (const rung of TIER_LADDER) {
    const viewport = await setZoom(rung.zoom);
    if (!viewport) {
      rungs.push({ ...rung, held: false, observed: { raison: 'moteur absent' } });
      continue;
    }
    const tier = graphRenderTier(viewport.zoom);
    const census = overlayCensus();
    const shot = await capture(`r2-zoom-${String(Math.round(rung.zoom * 1000)).padStart(4, '0')}`);
    rungs.push({
      ...rung,
      held: tier === rung.expect,
      observed: {
        zoomDemande: rung.zoom,
        zoomObtenu: Math.round(viewport.zoom * 1000) / 1000,
        zoomAffiche: zoomOutput(),
        regime: tier,
        ...census,
      },
      capture: shot,
    });
  }

  const steps = rungs.map((rung) => step(
    `seuils — ${Math.round(rung.zoom * 1000) / 10} % attend le régime « ${rung.expect} » (${rung.why})`,
    rung.held,
    rung.observed,
    rung.capture ? { capture: rung.capture } : {},
  ));

  // Les chevauchements, lus sur les paliers où des noms existent.
  const withLabels = rungs.filter((rung) => (rung.observed.labels ?? 0) > 1);
  const worst = withLabels.reduce((accumulator, rung) => {
    const pairs = rung.observed.labelOverlaps?.pairs ?? 0;
    return pairs > (accumulator?.observed.labelOverlaps?.pairs ?? -1) ? rung : accumulator;
  }, null);
  steps.push(step(
    'seuils — les noms ne se chevauchent pas de façon significative',
    worst !== null ? (worst.observed.labelOverlaps?.pairs ?? 0) === 0 : null,
    worst === null ? { raison: 'aucun palier ne porte plus d’un nom' } : {
      pireZoom: worst.zoom,
      pairesRecouvrantes: worst.observed.labelOverlaps.pairs,
      pireRecouvrementPx2: worst.observed.labelOverlaps.worstArea,
      nomsMesures: worst.observed.labels,
      seuilPx2: OVERLAP_AREA_PX,
    },
  ));

  // Sous 55 %, le nom et le compteur HTML tombent. Le glyphe de l'Action vit
  // désormais dans la texture Cytoscape et se juge dans la capture à 52 % ;
  // le compter dans le DOM reviendrait précisément à réintroduire le défaut.
  const noLabels = rungs.find((rung) => rung.observed.regime === 'noLabels');
  steps.push(step(
    'sous le seuil des noms, la couche HTML abandonne noms et compteurs au canvas',
    noLabels ? noLabels.observed.actionCounts === 0 && noLabels.observed.labels === 0 : null,
    noLabels ? {
      zoom: noLabels.zoom,
      compteursActionsHtml: noLabels.observed.actionCounts,
      noms: noLabels.observed.labels,
      glypheCanvas: 'capture à contrôler',
    } : { raison: 'aucun palier en régime noLabels' },
  ));

  // Les textes HTML gardent une taille fixe pendant que la carte suit le zoom :
  // c'est ce que l'audit demande de confronter à l'écran.
  const big = rungs.find((rung) => rung.zoom === 2.5);
  const work = rungs.find((rung) => rung.zoom === 1);
  steps.push(step(
    'le texte garde sa taille quand la carte suit le zoom',
    big && work && big.observed.labelFontPx !== null && work.observed.labelFontPx !== null
      ? big.observed.labelFontPx === work.observed.labelFontPx
      : null,
    {
      nomPxA250: big?.observed.labelFontPx ?? null,
      nomPxA100: work?.observed.labelFontPx ?? null,
    },
  ));

  return { steps, rungs };
}

// --- R3 : charge --------------------------------------------------------------

// Ce que la surface **publie** à cet instant : c'est le relevé que le moteur a
// composé, pas une reconstruction. Il porte `hasImage` par nœud, seule façon de
// distinguer « la vignette n'est pas arrivée » de « cet Écran n'a pas d'image ».
function overlayLoad() {
  const overlay = surface()?.overlay() ?? null;
  const nodes = overlay?.nodes ?? [];
  const stages = nodes.filter((node) => node.kind === 'stage');
  return {
    regime: overlay?.detailLevel ?? null,
    zoom: overlay ? Math.round(overlay.zoom * 10000) / 10000 : null,
    surimpressions: nodes.length,
    ecrans: stages.length,
    ecransAvecVignette: stages.filter((node) => node.hasImage).length,
    reperes: nodes.filter((node) => node.isEntry || node.diagnosed || node.duplicated
      || node.isolated || node.noIncoming || node.hasDangling || node.isHub || node.selected).length,
  };
}

// La cadence du pan/zoom, mesurée pendant que la caméra bouge **à chaque
// image**.
//
// Deux versions ont été écartées avant celle-ci, et il vaut mieux le dire que
// de laisser croire à une mesure évidente :
//
// 1. la première espaçait ses gestes d'une attente de 60 ms ; les écarts entre
//    images comptaient surtout du temps mort, et le relevé décrivait le rythme
//    de la recette plutôt que le coût du rendu ;
// 2. la deuxième tenait un `mousedown` au centre de la scène pour panoramiquer.
//    Au zoom de travail, 378 cartes couvrent la scène : le bouton tombait sur un
//    nœud, et Cytoscape commençait un **déplacement de nœud**. Dix secondes de
//    mesure portaient alors sur un glisser de carte, la caméra ne bougeait pas,
//    et le nombre de surimpressions restait figé.
//
// Le panoramique passe donc par la primitive de caméra — celle que la miniature
// et les boutons appellent — et le zoom garde le vrai gestionnaire de molette.
// Ce que la mesure ne couvre pas reste l'inertie et le pincement, qui n'existent
// que sur du matériel.
async function panZoomFrames(seconds, label) {
  const host = $('.advanced-canvas__host');
  const handle = surface();
  const engine = handle?.engine();
  if (!host || !engine) return { label, raison: 'surface absente' };
  const box = host.getBoundingClientRect();
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;

  const startViewport = engine.getViewport();
  const loadSamples = [];
  const frames = [];
  let wheels = 0;

  await new Promise((resolve) => {
    const deadline = performance.now() + seconds * 1000;
    let last = performance.now();
    let frame = 0;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      frame += 1;
      // Une trajectoire circulaire large : de nouveaux nœuds entrent réellement
      // dans la vue à chaque image, au lieu de trembler sur place.
      const angle = frame / 18;
      const reach = Math.min(box.width, box.height);
      const current = engine.getViewport();
      void engine.setViewport({
        x: current.x + Math.cos(angle) * reach * 0.06,
        y: current.y + Math.sin(angle) * reach * 0.06,
        zoom: current.zoom,
      });
      // Un va-et-vient de molette toutes les trente images : le régime de
      // détail change en cours de route, ce qui est le cas coûteux.
      if (frame % 30 === 0) {
        wheels += 1;
        host.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, clientX: centerX, clientY: centerY,
          deltaY: wheels % 2 === 0 ? -120 : 120,
        }));
      }
      if (frame % 20 === 0) loadSamples.push(overlayLoad().surimpressions);
      if (now < deadline) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
    // Filet : une fenêtre non composée suspend `requestAnimationFrame`, et la
    // mesure ne doit pas attendre indéfiniment.
    setTimeout(resolve, seconds * 1000 + 5000);
  });
  await settle();

  const endViewport = engine.getViewport();
  const moved = Math.abs(endViewport.x - startViewport.x) > 1
    || Math.abs(endViewport.y - startViewport.y) > 1
    || Math.abs(endViewport.zoom - startViewport.zoom) > 0.001;

  // La première image porte l'écart depuis l'installation du rappel : elle
  // n'est pas une image de rendu et fausserait le maximum.
  const measured = frames.slice(1);
  const sorted = [...measured].sort((left, right) => left - right);
  const at = (quantile) => (sorted.length === 0
    ? null
    : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] * 100) / 100);
  const total = measured.reduce((sum, delta) => sum + delta, 0);
  return {
    label,
    images: measured.length,
    secondes: Math.round((total / 1000) * 100) / 100,
    cameraDeplacee: moved,
    coupsDeMolette: wheels,
    surimpressionsMin: loadSamples.length > 0 ? Math.min(...loadSamples) : null,
    surimpressionsMax: loadSamples.length > 0 ? Math.max(...loadSamples) : null,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted.length > 0 ? Math.round(sorted[sorted.length - 1] * 100) / 100 : null,
    imagesLongues: measured.filter((delta) => delta > LONG_FRAME_MS).length,
    budgetImageLongueMs: LONG_FRAME_MS,
    imagesParSeconde: measured.length > 0 ? Math.round((measured.length / (total / 1000)) * 10) / 10 : null,
    fenetreVisible: document.visibilityState,
    fenetreFocus: document.hasFocus(),
  };
}

async function loadSteps(mediaReport, tierRungs) {
  const steps = [];
  const engine = surface()?.engine();

  // Le plafond de surimpressions est un **plafond**, pas une cible : le nombre
  // réellement peint est celui des nœuds dans la vue. Ce que la recette doit
  // vérifier, c'est le contrat de `publishOverlays` : les repères survivent
  // toujours, les nœuds ordinaires sont bornés.
  const byLoad = [...tierRungs].sort(
    (left, right) => (right.observed.cards ?? 0) - (left.observed.cards ?? 0),
  );
  const heaviest = byLoad[0] ?? null;
  await setZoom(heaviest?.zoom ?? 1);
  const atWork = overlayLoad();

  steps.push(step(
    'charge — les nœuds ordinaires restent bornés par le plafond de surimpressions',
    atWork.surimpressions - atWork.reperes <= 600,
    {
      plafond: 600,
      zoomLePlusCharge: heaviest?.zoom ?? null,
      surimpressions: atWork.surimpressions,
      dontReperes: atWork.reperes,
      dontOrdinaires: atWork.surimpressions - atWork.reperes,
      maxCartesSurLEchelle: heaviest?.observed.cards ?? null,
    },
  ));

  // Les vignettes se comptent à un régime **qui les peint**. Mesurée au zoom le
  // plus chargé — `noThumbs` — la comparaison attendait 150 marqueurs d'absence
  // pour zéro mesuré : à ce régime aucune vignette n'est posée, donc aucun
  // marqueur non plus.
  const thumbRung = [...tierRungs]
    .filter((rung) => rung.observed.regime === 'full' || rung.observed.regime === 'noLabels')
    .sort((left, right) => (right.observed.cards ?? 0) - (left.observed.cards ?? 0))[0] ?? null;
  await setZoom(thumbRung?.zoom ?? 1);
  const withThumbs = overlayLoad();
  const placeholders = $$('.advanced-node-overlay__image-placeholder').length;
  steps.push(step(
    'charge — les vignettes des Écrans qui en portent une sont chargées',
    mediaReport.bindings > 0
      ? withThumbs.ecransAvecVignette > 0 && placeholders === 0
      : null,
    {
      zoomMesure: thumbRung?.zoom ?? 1,
      regime: withThumbs.regime,
      liaisonsFabriquees: mediaReport.bindings,
      tailleVignettePx: mediaReport.size,
      ecransVisibles: withThumbs.ecrans,
      ecransAvecVignetteChargee: withThumbs.ecransAvecVignette,
      placeholdersMesures: placeholders,
      placeholdersAttendus: 0,
      // Un Écran sans image porte désormais un monogramme ou sa barre de
      // repli sur le canvas ; l'ancienne icône HTML d'absence reste supprimée.
      partAvecImageAuDocument: mediaReport.documentRatio ?? null,
      partAvecVignetteDansLaVue: withThumbs.ecrans > 0
        ? Math.round((withThumbs.ecransAvecVignette / withThumbs.ecrans) * 1000) / 1000
        : null,
    },
    mediaReport.bindings > 0 ? {} : { sansObjet: 'aucune liaison média fabriquée' },
  ));

  // La molette, elle, reste le **vrai** chemin d'entrée du zoom : la mesurer à
  // part évite qu'un panoramique par la caméra laisse croire que le
  // gestionnaire de molette a été exercé.
  const host = $('.advanced-canvas__host');
  const hostBox = host?.getBoundingClientRect() ?? null;
  const beforeWheel = engine?.getViewport() ?? null;
  if (host && hostBox) {
    host.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true,
      clientX: hostBox.left + hostBox.width / 2,
      clientY: hostBox.top + hostBox.height / 2,
      deltaY: -120,
    }));
    await settle();
  }
  const afterWheel = engine?.getViewport() ?? null;
  steps.push(step(
    'charge — la molette change le zoom par le gestionnaire du moteur',
    beforeWheel !== null && afterWheel !== null
      && Math.abs(afterWheel.zoom - beforeWheel.zoom) > 1e-6,
    {
      zoomAvant: beforeWheel ? Math.round(beforeWheel.zoom * 10000) / 10000 : null,
      zoomApres: afterWheel ? Math.round(afterWheel.zoom * 10000) / 10000 : null,
    },
  ));

  await setZoom(heaviest?.zoom ?? 1);

  // Deux paliers, parce que les deux comptent : le zoom de travail où l'auteur
  // vit, et le cadrage large où la surface porte le plus de surimpressions.
  const cadences = [];
  const atWorkFrames = await panZoomFrames(PAN_ZOOM_SECONDS, `zoom ${heaviest?.zoom ?? 1}`);
  cadences.push(atWorkFrames);

  if (engine) {
    await engine.fitContent();
    await settle();
    await settle();
    const wide = overlayLoad();
    const wideFrames = await panZoomFrames(PAN_ZOOM_SECONDS, `cadrage large (${wide.surimpressions} surimpressions)`);
    wideFrames.chargeAuDepart = wide;
    cadences.push(wideFrames);
  }

  steps.push(step(
    'charge — le pan/zoom déplace réellement la caméra',
    cadences.every((cadence) => cadence.cameraDeplacee === true),
    cadences.map((cadence) => ({ palier: cadence.label, deplacee: cadence.cameraDeplacee })),
  ));

  for (const cadence of cadences) {
    steps.push(step(
      `charge — cadence mesurée du pan/zoom : ${cadence.label}`,
      (cadence.images ?? 0) > 0,
      cadence,
      { verdictHumain: 'la fluidité se juge à l\u2019œil : les percentiles situent le coût, ils ne le remplacent pas' },
    ));
  }

  return { steps, census: atWork, frames: cadences };
}

// --- R4 : miniature ---------------------------------------------------------

function overviewCameraBox() {
  const rect = $('.advanced-graph-overview__camera');
  if (!rect) return null;
  return {
    x: Math.round(Number(rect.getAttribute('x')) * 100) / 100,
    y: Math.round(Number(rect.getAttribute('y')) * 100) / 100,
    width: Math.round(Number(rect.getAttribute('width')) * 100) / 100,
    height: Math.round(Number(rect.getAttribute('height')) * 100) / 100,
  };
}

function pointerAt(type, svg, fraction) {
  const box = svg.getBoundingClientRect();
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    button: type === 'pointerup' ? 0 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: box.left + box.width * fraction.x,
    clientY: box.top + box.height * fraction.y,
  });
  svg.dispatchEvent(event);
}

async function overviewSteps() {
  const steps = [];
  await setZoom(1);
  const svg = $('.advanced-graph-overview > svg');
  const engine = surface()?.engine();

  steps.push(step(
    'la miniature est atteignable au clavier et nommée',
    svg !== null && svg.getAttribute('tabindex') === '0'
      && (svg.getAttribute('aria-label') ?? '').length > 0
      && getComputedStyle(svg).pointerEvents !== 'none',
    {
      presente: svg !== null,
      tabindex: svg?.getAttribute('tabindex') ?? null,
      ariaLabel: svg?.getAttribute('aria-label') ?? null,
      pointerEvents: svg ? getComputedStyle(svg).pointerEvents : null,
      ariaHidden: svg?.getAttribute('aria-hidden') ?? null,
    },
  ));

  if (!svg || !engine) return { steps };

  // Clic : la caméra se recentre sur le point désigné, sans changer d'échelle.
  const beforeClick = engine.getViewport();
  const boxBefore = overviewCameraBox();
  let pointerCaptureError = null;
  try {
    pointerAt('pointerdown', svg, { x: 0.8, y: 0.8 });
  } catch (error) {
    pointerCaptureError = String(error?.message ?? error);
  }
  await settle();
  const afterClick = engine.getViewport();
  const boxAfterClick = overviewCameraBox();
  steps.push(step(
    'un clic dans la miniature déplace la caméra sans changer le zoom',
    Math.abs(afterClick.x - beforeClick.x) + Math.abs(afterClick.y - beforeClick.y) > 1
      && Math.abs(afterClick.zoom - beforeClick.zoom) < 1e-6,
    {
      avant: { x: Math.round(beforeClick.x), y: Math.round(beforeClick.y), zoom: beforeClick.zoom },
      apres: { x: Math.round(afterClick.x), y: Math.round(afterClick.y), zoom: afterClick.zoom },
      cadreAvant: boxBefore,
      cadreApres: boxAfterClick,
      erreurCaptureDePointeur: pointerCaptureError,
    },
    pointerCaptureError
      ? { reserve: 'setPointerCapture a refusé un pointeur synthétique : artefact de la recette, pas du produit' }
      : {},
  ));

  // Glisser : la caméra suit, puis s'arrête au relâchement.
  const trail = [];
  for (const fraction of [{ x: 0.6, y: 0.6 }, { x: 0.4, y: 0.4 }, { x: 0.2, y: 0.25 }]) {
    pointerAt('pointermove', svg, fraction);
    await settle();
    const viewport = engine.getViewport();
    trail.push({ x: Math.round(viewport.x), y: Math.round(viewport.y) });
  }
  const followed = trail.length > 1
    && trail.some((point, index) => index > 0
      && (point.x !== trail[index - 1].x || point.y !== trail[index - 1].y));
  steps.push(step(
    'la caméra suit le glisser dans la miniature',
    followed,
    { trace: trail },
  ));

  pointerAt('pointerup', svg, { x: 0.2, y: 0.25 });
  await settle();
  const atRelease = engine.getViewport();
  pointerAt('pointermove', svg, { x: 0.9, y: 0.1 });
  await settle();
  const afterRelease = engine.getViewport();
  steps.push(step(
    'après le relâchement, un mouvement ne déplace plus la caméra',
    Math.abs(afterRelease.x - atRelease.x) < 1 && Math.abs(afterRelease.y - atRelease.y) < 1,
    {
      auRelachement: { x: Math.round(atRelease.x), y: Math.round(atRelease.y) },
      apres: { x: Math.round(afterRelease.x), y: Math.round(afterRelease.y) },
    },
  ));

  // Clavier : un quart d'écran par flèche, et l'événement est consommé.
  svg.focus();
  const focused = document.activeElement === svg;
  const beforeKey = engine.getViewport();
  const keyEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' });
  svg.dispatchEvent(keyEvent);
  await settle();
  const afterKey = engine.getViewport();
  steps.push(step(
    'les flèches déplacent la caméra depuis la miniature',
    focused && Math.abs(afterKey.x - beforeKey.x) > 1 && keyEvent.defaultPrevented,
    {
      focusPose: focused,
      dx: Math.round(afterKey.x - beforeKey.x),
      dy: Math.round(afterKey.y - beforeKey.y),
      evenementConsomme: keyEvent.defaultPrevented,
    },
  ));

  return { steps, capture: await capture('r4-miniature') };
}

// --- R5 : repères du régime éloigné ----------------------------------------

async function landmarkSteps(expected) {
  const steps = [];
  const engine = surface()?.engine();
  if (!engine) return { steps };

  await engine.fitContent();
  await settle();
  await settle();
  const fitted = engine.getViewport();
  const fitCards = overlayCensus().cards;

  // Le cadrage d’un **petit** pack ne tombe pas au régime éloigné : sur la
  // médiane de 124 nœuds il s’arrête à 46 %, et les contrôles de repère
  // n’avaient alors rien à observer. Ils ne sont pas pour autant sans objet :
  // le régime éloigné existe à tout zoom sous 3 %. La recette descend donc
  // explicitement sous le seuil, et dit à part où le cadrage s’est arrêté.
  const simplifiedZoom = Math.min(fitted.zoom, 0.029);
  if (fitted.zoom > 0.029) await setZoom(simplifiedZoom);
  const census = overlayCensus();

  steps.push(step(
    'sous le seuil de 3 %, la surface passe aux repères seuls',
    census.cards === 0 && census.landmarks.total > 0,
    {
      zoomDuCadrage: Math.round(fitted.zoom * 10000) / 10000,
      cartesAuCadrage: fitCards,
      zoomMesure: Math.round(simplifiedZoom * 10000) / 10000,
      zoomAffiche: zoomOutput(),
      cartes: census.cards,
      reperes: census.landmarks,
    },
  ));

  // Le cœur du contrôle : l’entrée est **trouvable** sans connaître son
  // nom, et son repère mesure une taille d’écran lisible — pas 0,56 pixel.
  const entryMark = $('.advanced-landmark--entry');
  const entryRing = entryMark?.querySelector('i')?.getBoundingClientRect() ?? null;
  const entryTag = entryMark?.querySelector('.advanced-landmark__tag')?.textContent?.trim() ?? null;
  steps.push(step(
    'l’entrée porte son libellé ENTRÉE en pixels écran',
    census.landmarks.entry === expected.entries
      && entryTag === 'ENTRÉE'
      && (entryRing?.width ?? 0) >= 16,
    {
      reperesEntree: census.landmarks.entry,
      entreesAuDTO: expected.entries,
      libelle: entryTag,
      anneauPx: entryRing
        ? { width: Math.round(entryRing.width), height: Math.round(entryRing.height) }
        : null,
    },
  ));

  steps.push(step(
    'les nœuds à corriger gardent un repère au régime éloigné',
    census.landmarks.warning > 0,
    {
      reperesAvertissement: census.landmarks.warning,
      noeudsDiagnostiquesAuDTO: expected.diagnosed,
    },
  ));

  steps.push(step(
    'les carrefours gardent leur nom et leur nombre de liens',
    census.landmarks.hub > 0
      && /·\s\d+\slien/.test($('.advanced-landmark--hub .advanced-landmark__name')?.textContent ?? ''),
    {
      reperesCarrefour: census.landmarks.hub,
      exemple: $('.advanced-landmark--hub .advanced-landmark__name')?.textContent?.trim() ?? null,
    },
  ));

  // Le regroupement par zone d’écran : ce que la recette a fait ajouter. Il se
  // vérifie sur le relevé publié, qui porte le nombre de nœuds derrière chaque
  // marque — et non sur le seul compte d’éléments, qui ne dirait pas si les
  // nœuds regroupés sont bien tous représentés.
  const published = surface()?.overlay()?.nodes ?? [];
  const grouped = published.filter((node) => (node.clusterCount ?? 1) > 1);
  const represented = published.reduce((sum, node) => sum + (node.clusterCount ?? 1), 0);
  steps.push(step(
    'le regroupement borne les marques sans perdre de nœud',
    published.length > 0 && represented >= published.length
      && (expected.diagnosed <= 240 || grouped.length > 0),
    {
      marquesPubliees: published.length,
      marquesRegroupees: grouped.length,
      noeudsRepresentes: represented,
      plusGrandRegroupement: grouped.length > 0
        ? Math.max(...grouped.map((node) => node.clusterCount))
        : 0,
      budget: 240,
    },
  ));

  // Le critère de recette de l’étape 1 de l’audit, mesuré et non supposé.
  const crowding = landmarkCrowding();
  steps.push(step(
    'au régime éloigné, les repères restent distinguables les uns des autres',
    crowding
      ? crowding.partDeLaSceneCouverteParLesAnneaux < 0.25
        && crowding.recouvrementsDeNoms.pairs === 0
      : null,
    {
      ...crowding,
      seuilCouverture: 0.25,
      critere: 'retrouver l’entrée et les nœuds à corriger sans connaître leur nom',
    },
  ));

  const farCapture = await capture('r5-regime-eloigne');

  // Le même relevé **au cadrage du pack**, quel qu’il soit : c’est le geste que
  // l’auteur fait pour voir son pack en entier, et donc le cas qui compte.
  await engine.fitContent();
  await settle();
  await settle();
  const atFit = landmarkCrowding();
  const fitCensus = overlayCensus();
  steps.push(step(
    'au cadrage du pack entier, les repères restent distinguables',
    fitCensus.landmarks.total > 0
      ? atFit !== null
        && atFit.partDeLaSceneCouverteParLesAnneaux < 0.25
        && atFit.recouvrementsDeNoms.pairs === 0
      : null,
    {
      zoomDuCadrage: Math.round(fitted.zoom * 10000) / 10000,
      reperes: fitCensus.landmarks,
      ...atFit,
    },
    fitCensus.landmarks.total > 0
      ? {}
      : { sansObjet: 'le cadrage de ce pack reste au-dessus du seuil : aucun repère à compter' },
  ));
  const fitCapture = await capture('r5-cadrage-du-pack');

  steps.push(step(
    'les zones de groupe colorées disparaissent au régime éloigné',
    census.groupZones === 0,
    { zonesDeGroupe: census.groupZones, groupesAuDTO: expected.groups },
    expected.groups === 0
      ? { sansObjet: 'la fixture ne porte aucun groupe : le cas n’est pas exercé' }
      : {},
  ));

  return { steps, census, captures: [farCapture, fitCapture] };
}

// --- R6 : boutons de zoom ---------------------------------------------------

async function zoomButtonSteps() {
  const steps = [];
  const engine = surface()?.engine();
  const handle = surface();
  if (!engine || !handle) return { steps };

  // Le centre visible reste stable. Le point du graphe au centre de la
  // scène avant l'appui doit y rester après.
  await setZoom(1);
  const size = handle.size();
  const centerOf = () => {
    const viewport = engine.getViewport();
    return {
      x: (size.width / 2 - viewport.x) / viewport.zoom,
      y: (size.height / 2 - viewport.y) / viewport.zoom,
      zoom: viewport.zoom,
    };
  };
  const before = centerOf();
  $('[aria-label="Agrandir"]').click();
  await settle();
  const after = centerOf();
  steps.push(step(
    '« + » garde le centre visible stable',
    Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1 && after.zoom > before.zoom,
    {
      centreAvant: { x: Math.round(before.x), y: Math.round(before.y) },
      centreApres: { x: Math.round(after.x), y: Math.round(after.y) },
      zoom: { avant: before.zoom, apres: Math.round(after.zoom * 1000) / 1000 },
    },
  ));

  // La borne basse ne fait pas sauter la vue après un cadrage très éloigné.
  await engine.fitContent();
  await settle();
  const fitted = engine.getViewport();
  $('[aria-label="Réduire"]').click();
  await settle();
  const reduced = engine.getViewport();
  steps.push(step(
    '« − » après un cadrage à très faible zoom ne fait pas sauter la vue',
    reduced.zoom <= fitted.zoom && reduced.zoom > 0,
    {
      zoomCadre: Math.round(fitted.zoom * 100000) / 100000,
      zoomApresReduction: Math.round(reduced.zoom * 100000) / 100000,
      borneBasse: 0.001,
    },
  ));

  return { steps };
}

// --- R7 : commandes de repérage sur la surface ------------------------------

// Elles doivent rester joignables même liste et inspecteur fermés. Elles sont
// donc posées sur la scène, et c'est là qu'on les vérifie.
//
// Ce que ce bloc **ne** couvre pas : le menu contextuel et le bouton ▶, qui
// sont câblés dans `AdvancedWorkspace` et non sur la surface du banc. Ils sont
// éprouvés par `scripts/graphContextMenu.test.mjs`, et restent à exercer dans
// l'atelier (`VITE_BENCH=atelier`).
async function locateSteps(expected) {
  const steps = [];
  const engine = surface()?.engine();
  if (!engine) return { steps };

  const group = $('.advanced-graph-locate');
  const buttons = $$('.advanced-graph-locate button');
  steps.push(step(
    'repérage — les commandes sont sur la surface et nommées',
    group !== null && buttons.length >= 2
      && (group.getAttribute('aria-label') ?? '').length > 0,
    {
      presentes: group !== null,
      ariaLabel: group?.getAttribute('aria-label') ?? null,
      boutons: buttons.map((button) => button.textContent.trim()),
    },
  ));

  const show = buttons.find((button) => button.textContent.includes('Montrer'));
  if (!show) return { steps };

  // Éloigner délibérément la caméra de l'entrée, puis demander à y revenir.
  await setZoom(1);
  const away = engine.getViewport();
  void engine.setViewport({ x: away.x - 4000, y: away.y - 3000, zoom: away.zoom });
  await settle();
  const before = engine.getViewport();
  show.click();
  await settle();
  await settle();
  const after = engine.getViewport();
  steps.push(step(
    'repérage — « Montrer l’entrée » ramène la caméra sur l’entrée',
    expected.entries === 1
      ? Math.abs(after.x - before.x) + Math.abs(after.y - before.y) > 1
        && Math.abs(after.zoom - before.zoom) < 1e-6
      : null,
    {
      entreesAuDTO: expected.entries,
      avant: { x: Math.round(before.x), y: Math.round(before.y) },
      apres: { x: Math.round(after.x), y: Math.round(after.y) },
      zoomInchange: Math.abs(after.zoom - before.zoom) < 1e-6,
      desactive: show.getAttribute('aria-disabled'),
    },
    expected.entries === 1
      ? {}
      : { sansObjet: 'entrée absente ou ambiguë : la commande doit rester désactivée' },
  ));

  const back = buttons.find((button) => button.textContent.includes('Revenir'));
  steps.push(step(
    'repérage — « Revenir à la sélection » est désactivé sans sélection, avec sa raison',
    back !== null && back.getAttribute('aria-disabled') === 'true'
      && (back.getAttribute('title') ?? '').length > 0,
    {
      desactive: back?.getAttribute('aria-disabled') ?? null,
      raison: back?.getAttribute('title') ?? null,
    },
  ));

  // Le ▶ ne doit pas apparaître sur la surface du banc : l'écoute est une
  // commande de l'atelier, et le banc ne la transmet pas.
  steps.push(step(
    'repérage — aucun bouton d’écoute permanent sur la surface',
    $$('.advanced-graph-locate__listen').length === 0,
    { boutonsEcoute: $$('.advanced-graph-locate__listen').length },
    { note: 'le ▶ est câblé dans l’atelier, sur la sélection seulement' },
  ));

  // --- Précédent / Suivant, dans la WebView ---------------------------------
  //
  // Le banc monte le **même** hook que l'atelier, donc ce qui est exercé ici
  // est le code de production et non un adaptateur de banc.
  const steps2 = await historySteps();
  steps.push(...steps2);

  return { steps, capture: await capture('r7-reperage') };
}

async function historySteps() {
  const steps = [];
  const stepButtons = () => $$('.advanced-graph-locate__step');
  const back = () => stepButtons()[0] ?? null;
  const forward = () => stepButtons()[1] ?? null;

  steps.push(step(
    'historique — Précédent et Suivant sont rendus, désactivés et nommés au départ',
    stepButtons().length === 2
      && back().getAttribute('aria-disabled') === 'true'
      && forward().getAttribute('aria-disabled') === 'true'
      && (back().getAttribute('aria-label') ?? '').length > 0,
    {
      boutons: stepButtons().length,
      precedentDesactive: back()?.getAttribute('aria-disabled') ?? null,
      suivantDesactive: forward()?.getAttribute('aria-disabled') ?? null,
      libelles: stepButtons().map((button) => button.getAttribute('aria-label')),
    },
  ));

  // Révéler deux nœuds par la liste de résultats : c'est le chemin volontaire.
  const results = $$('.advanced-search__list [role="option"]');
  if (results.length < 2) {
    steps.push(step('historique — deux révélations depuis la liste', null,
      { resultats: results.length }, { sansObjet: 'la liste ne rend pas deux résultats' }));
    return steps;
  }
  results[0].click();
  await settle();
  await settle();
  const first = surface()?.engine()?.getViewport() ?? null;
  $$('.advanced-search__list [role="option"]')[1].click();
  await settle();
  await settle();
  const second = surface()?.engine()?.getViewport() ?? null;

  steps.push(step(
    'historique — après deux révélations, Précédent s’active et Suivant reste fermé',
    back()?.getAttribute('aria-disabled') === 'true'
      ? false
      : forward()?.getAttribute('aria-disabled') === 'true',
    {
      precedentDesactive: back()?.getAttribute('aria-disabled') ?? null,
      suivantDesactive: forward()?.getAttribute('aria-disabled') ?? null,
    },
  ));

  back().click();
  await settle();
  await settle();
  const returned = surface()?.engine()?.getViewport() ?? null;
  steps.push(step(
    'historique — Précédent ramène la caméra et ouvre Suivant',
    returned !== null && second !== null
      && (Math.abs(returned.x - second.x) + Math.abs(returned.y - second.y) > 1)
      && forward()?.getAttribute('aria-disabled') !== 'true',
    {
      cadrageDeLaPremiere: first ? { x: Math.round(first.x), y: Math.round(first.y) } : null,
      cadrageDeLaSeconde: second ? { x: Math.round(second.x), y: Math.round(second.y) } : null,
      apresPrecedent: returned ? { x: Math.round(returned.x), y: Math.round(returned.y) } : null,
      suivantDesactive: forward()?.getAttribute('aria-disabled') ?? null,
    },
  ));

  forward().click();
  await settle();
  await settle();
  steps.push(step(
    'historique — Suivant repart en avant et se referme au bout',
    forward()?.getAttribute('aria-disabled') === 'true'
      && back()?.getAttribute('aria-disabled') !== 'true',
    {
      suivantDesactive: forward()?.getAttribute('aria-disabled') ?? null,
      precedentDesactive: back()?.getAttribute('aria-disabled') ?? null,
    },
  ));

  return steps;
}

// --- Campagne ---------------------------------------------------------------

export async function runSurfaceRecette({ profile, expected, mediaReport }) {
  const report = {
    label: RESULT_LABEL,
    runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${RESULT_LABEL}-${profile}`,
    startedAt: new Date().toISOString(),
    profile,
    plateforme: {
      userAgent: navigator.userAgent,
      pixelRatio: window.devicePixelRatio,
      fenetre: { width: window.innerWidth, height: window.innerHeight },
    },
    attendu: expected,
    portee: {
      prouve: [
        'la WebView peint réellement',
        'conversion des couleurs du thème et relecture de palette sans remontage',
        'régimes de détail, décorations et chevauchements mesurés en pixels écran',
        'miniature pilotable à la souris et au clavier',
        'repères de l’entrée et des nœuds à corriger au régime éloigné',
        'cadence du pan/zoom sous charge, avec les vignettes chargées',
      ],
      neProuvePas: [
        'les gestes matériels : les événements sont synthétiques, ils entrent par les mêmes gestionnaires mais pas par le compositeur',
        'le confort, le goût et l’équilibre typographique : les captures sont là pour l’œil',
        'Windows et macOS : cette campagne est Fedora/WebKitGTK',
        'les groupes, absents de toutes les fixtures de graphe',
      ],
    },
    steps: [],
    captures: [],
  };

  const write = (line) => {
    const log = document.querySelector('#recette-log');
    if (log) log.textContent += `${line}\n`;
  };

  report.sondeDePeinture = await paintProbe();
  if (!report.sondeDePeinture.painting) {
    report.steps.push(step('sonde — la WebView peint', false, report.sondeDePeinture,
      { arret: 'fenêtre non composée : les mesures suivantes n’auraient aucun sens' }));
    report.finishedAt = new Date().toISOString();
    report.complete = false;
    await postResult(report);
    write('■ arrêt : la WebView ne peint pas.');
    return report;
  }
  report.steps.push(step('sonde — la WebView peint', true, report.sondeDePeinture));
  write(`sonde de peinture : ${report.sondeDePeinture.frames} images en ${report.sondeDePeinture.elapsedMs} ms`);

  // Cadrage de départ, avant toute mesure.
  //
  // La caméra d'ouverture vient du cache de vue, et aucun recadrage
  // automatique n'est fait ensuite : `applyCachedView` applique la caméra
  // mémorisée telle quelle, « une caméra ne s'ancre à aucun nœud ». Une
  // exécution précédente peut donc léguer une caméra posée en dehors du
  // contenu — et c'est arrivé : sur le profil p90, l'échelle de
  // zoom a mesuré une région vide, sans un pixel opaque ni une seule carte, et
  // quatre pas ont été comptés manqués pour cette seule raison. La recette part
  // donc d'un cadrage connu. Le cache reste exercé : il est lu, appliqué, puis
  // remplacé par un geste de vue ordinaire.
  const opening = surface()?.engine();
  if (opening) {
    const restored = opening.getViewport();
    await opening.fitContent();
    await settle();
    await settle();
    const framed = opening.getViewport();
    report.cadrageDeDepart = {
      cameraRestauree: {
        x: Math.round(restored.x), y: Math.round(restored.y),
        zoom: Math.round(restored.zoom * 10000) / 10000,
      },
      apresCadrage: {
        x: Math.round(framed.x), y: Math.round(framed.y),
        zoom: Math.round(framed.zoom * 10000) / 10000,
      },
      surimpressionsApresCadrage: overlayLoad().surimpressions,
    };
    write(`cadrage de départ : zoom ${report.cadrageDeDepart.apresCadrage.zoom}`
      + ` (caméra restaurée : ${report.cadrageDeDepart.cameraRestauree.zoom})`);
  }

  // Les paliers de R2 servent à R3 : le zoom le plus chargé se **constate**
  // sur l'échelle mesurée, il ne se devine pas de la géométrie de la fixture.
  let ladder = { rungs: [] };
  for (const [name, run] of [
    ['R1 thème', () => themeSteps()],
    ['R2 seuils', () => tierSteps()],
    ['R3 charge', () => loadSteps(mediaReport, ladder.rungs ?? [])],
    ['R4 miniature', () => overviewSteps()],
    ['R5 régime éloigné', () => landmarkSteps(expected)],
    ['R6 boutons de zoom', () => zoomButtonSteps()],
    ['R7 repérage', () => locateSteps(expected)],
  ]) {
    write(`\n▸ ${name}…`);
    try {
      const outcome = await run();
      if (outcome.rungs) ladder = outcome;
      report.steps.push(...outcome.steps);
      if (outcome.capture) report.captures.push(outcome.capture);
      if (outcome.captures) report.captures.push(...outcome.captures);
      if (outcome.frames) report.cadences = outcome.frames;
      for (const one of outcome.steps) {
        write(`  ${one.held ? '✓' : one.sansObjet ? '·' : '✗'} ${one.name}`);
      }
    } catch (error) {
      report.steps.push(step(`${name} — interrompu`, false, { erreur: String(error?.stack ?? error) }));
      write(`  ✗ ${name} interrompu : ${error?.message ?? error}`);
    }
    // Un relevé intermédiaire à chaque bloc : une campagne interrompue laisse
    // quand même ce qu'elle a mesuré.
    report.finishedAt = new Date().toISOString();
    report.complete = false;
    await postResult(report);
  }

  report.imagesSuspendues = suspendedFrames;
  report.bilan = {
    tenus: report.steps.filter((one) => one.held).length,
    manques: report.steps.filter((one) => !one.held && !one.sansObjet).length,
    sansObjet: report.steps.filter((one) => one.sansObjet).length,
  };
  report.finishedAt = new Date().toISOString();
  report.complete = true;
  const file = await postResult(report);
  write(`\n■ recette terminée : ${report.bilan.tenus} tenus, ${report.bilan.manques} manqués, ${report.bilan.sansObjet} sans objet.`);
  write(`relevé : ${file ?? 'non écrit'}`);
  return report;
}

async function postResult(report) {
  try {
    const response = await fetch('/__bench/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    if (!response.ok) return null;
    const { file } = await response.json();
    return file;
  } catch {
    return null;
  }
}
