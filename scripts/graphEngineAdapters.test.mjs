import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import cytoscape from 'cytoscape';
import { resetColorCache } from '../src/components/AdvancedGraphCanvas/engines/engineColors.js';
import {
  createCytoscapeEngine,
  cytoscapeGridStyle,
} from '../src/components/AdvancedGraphCanvas/engines/cytoscapeEngine.js';
import {
  nodePortOffsets,
  PORT_RADIUS,
} from '../src/components/AdvancedGraphCanvas/engines/engineContract.js';
import { createG6Engine } from '../bench/graphEngines/engines/g6Engine.js';
import { createVisNetworkEngine } from '../bench/graphEngines/engines/visNetworkEngine.js';
import { canvasMetrics, probeResponsiveness } from '../bench/graphEngines/protocol.js';

const elements = { nodes: [{ id: 'a', kind: 'stage', x: 0, y: 0 }, { id: 'b', kind: 'stage', x: 100, y: 0 }], edges: [] };

function themedContainer(initialBackground, variables = {}) {
  let pixel = [0, 0, 0, 255];
  const context = {
    set fillStyle(value) {
      if (!/^#[0-9a-f]{6}$/i.test(value)) return;
      pixel = [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)).concat(255);
    },
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: pixel }),
  };
  const view = {
    document: { createElement: () => ({ getContext: () => context }) },
    getComputedStyle: (element) => ({
      getPropertyValue: (property) => (
        property === '--bg0' ? element.background : (element.variables[property] ?? '')
      ),
    }),
  };
  return {
    background: initialBackground,
    variables: { ...variables },
    ownerDocument: { defaultView: view },
  };
}

// Les deux thèmes de `variables.css`, tels que la WebView les résout : `:root`
// porte le thème clair, `:root[data-theme="dark"]` le surcharge. Un token
// déclaré d'un seul côté laisse l'autre thème sur le repli hexadécimal de
// l'adaptateur — c'est-à-dire sur la couleur de l'autre thème, peinte sur le
// mauvais fond. Les essais lisent donc la feuille réelle, pas une copie.
function themeTokens() {
  const source = readFileSync(new URL('../src/styles/variables.css', import.meta.url), 'utf8');
  const read = (selector) => {
    const start = source.indexOf(`${selector} {`);
    assert.ok(start >= 0, `bloc ${selector} absent de variables.css`);
    const block = source.slice(start, source.indexOf('\n}', start));
    return (property) => {
      const found = block.match(new RegExp(`${property}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
      return found ? found[1] : null;
    };
  };
  return { light: read(':root'), dark: read(':root[data-theme="dark"]') };
}

// Luminance relative et rapport de contraste WCAG. C'est la mesure qui fixe
// un seuil de 3:1 entre la carte d'un Écran sans image et le fond du canvas.
function relativeLuminance(hex) {
  const [red, green, blue] = [1, 3, 5]
    .map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a, b) {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function headlessCytoscape(container) {
  let instance;
  const engine = createCytoscapeEngine({
    container,
    cytoscape: (options) => {
      instance = cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
      return instance;
    },
  });
  return { engine, peek: () => instance };
}

function decodeSvgDataUri(uri) {
  return decodeURIComponent(String(uri).slice(String(uri).indexOf(',') + 1));
}

// Les trois couches de fond d'un nœud, retrouvées par leur régime de
// confinement plutôt que par leur rang : la vignette éventuelle et la
// décoration sont inscrites dans le contour, la couche des prises est la seule
// à déborder. C'est ce qui fait que les essais ne se cassent pas quand une
// couche apparaît ou disparaît selon le zoom.
function backgroundLayers(node) {
  const images = node.data('renderedImages') ?? [];
  const containments = node.data('renderedImageContainments') ?? [];
  const inside = images.filter((_, index) => containments[index] === 'inside');
  const overIndex = containments.indexOf('over');
  return {
    thumbnail: inside.length > 1 ? inside[0] : null,
    decoration: decodeSvgDataUri(inside[inside.length - 1]),
    ports: overIndex === -1 ? null : decodeSvgDataUri(images[overIndex]),
  };
}

test('Cytoscape laisse voir le fond CSS pendant le mouvement et conserve le thème des captures', async () => {
  resetColorCache();
  const container = themedContainer('#EBEEF3');
  let instance;
  const engine = createCytoscapeEngine({
    container,
    cytoscape: (options) => {
      instance = cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
      return instance;
    },
  });
  const textureBackground = () => instance.style().json()
    .find((rule) => rule.selector === 'core').style;

  try {
    await engine.mount(elements);
    assert.equal(textureBackground()['outside-texture-bg-color'], 'rgb(235,238,243)');
    assert.equal(textureBackground()['outside-texture-bg-opacity'], '0');

    container.background = '#0a0a0e';
    engine.refreshTheme();
    assert.equal(textureBackground()['outside-texture-bg-color'], 'rgb(10,10,14)');
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test("la carte d'un Écran sans image se détache du fond du canvas, dans les deux thèmes", () => {
  const { light, dark } = themeTokens();
  // Deux cibles, et c'est un arbitrage de l'auteur du produit, pas un oubli.
  // Le sombre tient les 3:1. Le clair est relâché à 2:1 : sur un fond
  // presque blanc, 3:1 imposait une carte ardoise franche qui transformait la
  // surface en damier et écrasait les vignettes photo. Le seuil est gardé en
  // essai des deux côtés pour qu'un ajustement de palette ne le repasse pas
  // sous la barre sans qu'on le voie.
  for (const [name, read, floor] of [['clair', light, 2], ['sombre', dark, 3]]) {
    const canvas = read('--bg0');
    const card = read('--graph-card-bg');
    const border = read('--graph-card-border');
    assert.ok(card, `--graph-card-bg absent du thème ${name}`);
    assert.ok(border, `--graph-card-border absent du thème ${name}`);
    assert.ok(
      contrastRatio(card, canvas) >= floor,
      `carte ${card} sur fond ${canvas} : ${contrastRatio(card, canvas).toFixed(2)}:1 en thème ${name}, attendu ${floor}:1`,
    );
    // Le contour doit s'écarter du fond **dans le même sens** que la carte,
    // sans quoi il se referme sur elle et la silhouette disparaît. En clair la
    // carte est plus sombre que le fond, en sombre plus claire.
    const towardsCard = relativeLuminance(card) - relativeLuminance(canvas);
    const towardsBorder = relativeLuminance(border) - relativeLuminance(card);
    assert.ok(
      Math.sign(towardsCard) === Math.sign(towardsBorder),
      `le contour du thème ${name} revient vers le fond au lieu de s'en écarter`,
    );
  }
  // Le rapport s'inverse d'un thème à l'autre : c'est la condition que le
  // handoff avait manquée en laissant le thème clair hors passe.
  assert.ok(relativeLuminance(light('--graph-card-bg')) < relativeLuminance(light('--bg0')));
  assert.ok(relativeLuminance(dark('--graph-card-bg')) > relativeLuminance(dark('--bg0')));
});

test("la carte d'un Écran suit les tokens de canvas et les relit au changement de thème", async () => {
  resetColorCache();
  const { light, dark } = themeTokens();
  const container = themedContainer(light('--bg0'), {
    '--graph-card-bg': light('--graph-card-bg'),
    '--graph-card-border': light('--graph-card-border'),
  });
  const { engine, peek } = headlessCytoscape(container);
  const toRgb = (hex) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(',')})`;

  try {
    await engine.mount(elements);
    const card = () => peek().$id('a');
    assert.equal(card().style('background-color'), toRgb(light('--graph-card-bg')));
    assert.equal(card().style('border-color'), toRgb(light('--graph-card-border')));

    container.background = dark('--bg0');
    container.variables['--graph-card-bg'] = dark('--graph-card-bg');
    container.variables['--graph-card-border'] = dark('--graph-card-border');
    engine.refreshTheme();
    assert.equal(card().style('background-color'), toRgb(dark('--graph-card-bg')));
    assert.equal(card().style('border-color'), toRgb(dark('--graph-card-border')));
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('la silhouette, le pictogramme Écran et les décorations sont peints par Cytoscape', async () => {
  resetColorCache();
  const container = themedContainer('#0a0a0e');
  const { engine, peek } = headlessCytoscape(container);
  try {
    await engine.mount({
      nodes: [
        { id: 'stage', kind: 'stage', label: 'Accueil', x: 0, y: 0, groupId: 'g1' },
        { id: 'action', kind: 'action', label: 'Choix', x: 200, y: 0, outgoingCount: 2 },
      ],
      edges: [],
    });
    const stage = peek().$id('stage');
    const action = peek().$id('action');
    assert.equal(stage.style('label'), '');
    assert.match(backgroundLayers(stage).decoration, /d="M3 7V5a2 2 0 0 1 2-2h2"/);
    assert.match(backgroundLayers(stage).decoration, /width="10" height="8" x="7" y="8" rx="1"/);
    assert.equal(action.style('shape'), 'diamond');
    assert.equal(Number.parseFloat(action.style('width')), 52);
    assert.equal(Number.parseFloat(action.style('height')), 52);
    assert.equal(backgroundLayers(stage).thumbnail, null);
    // Le glyphe d'aiguillage est l'icône `Waypoints`, ramenée au carré de 52.
    assert.match(backgroundLayers(action).decoration, /<g transform="translate\(26 26\) scale/);
    assert.match(backgroundLayers(action).decoration, /d="M6 12h12"/);
    // Les prises vivent dans leur propre couche, hors de la découpe au contour.
    // La décoration, elle, garde la sienne : le bandeau de groupe d'un Écran a
    // des coins carrés, et sortir tout le dessin de la découpe les ferait
    // ressortir des angles arrondis de la carte.
    //
    // Le glyphe porte lui-même des disques : le discriminant n'est donc plus la
    // présence d'un `<circle>`, mais le **rayon de la prise d'arrivée**, que
    // seule la couche des prises emploie et que tout nœud porte — là où les
    // crans d'options varient avec le nombre de sorties.
    const arrival = new RegExp(`r="${PORT_RADIUS - 1}"`);
    assert.doesNotMatch(backgroundLayers(action).decoration, arrival,
      "la décoration d'une Action ne porte plus ses prises");
    assert.match(backgroundLayers(action).ports, arrival,
      'les prises sont peintes par leur propre couche');
    // Cytoscape laisse **tomber en silence** une propriété qu'il ne connaît
    // pas : sans cette vérification, une faute de frappe rendrait simplement
    // les prises découpées au contour, sans rien signaler.
    assert.equal(action.style('background-image-containment'), 'inside over');
    assert.equal(action.style('background-clip'), 'node none');
    assert.equal(action.style('background-fit'), 'contain none');

    engine.setNodeImage('stage', 'data:image/png;base64,AA==');
    assert.ok(backgroundLayers(stage).thumbnail, 'la vignette est présente au-dessus de 5 %');
    await engine.setViewport({ x: 0, y: 0, zoom: 0.049 });
    assert.equal(backgroundLayers(stage).thumbnail, null, 'la vignette tombe sous 5 %');
    await engine.setViewport({ x: 0, y: 0, zoom: 0.051 });
    assert.ok(backgroundLayers(stage).thumbnail, 'la vignette revient au-dessus de 5 %');
    engine.setNodeImage('stage', null);

    await engine.setViewport({ x: 0, y: 0, zoom: 0.25 });
    assert.doesNotMatch(backgroundLayers(action).decoration, /M17 17h8v7h10/,
      'le glyphe tombe sous 30 %');
    assert.ok(backgroundLayers(action).ports, 'les prises restent à partir de 20 %');

    await engine.setViewport({ x: 0, y: 0, zoom: 0.15 });
    assert.equal(backgroundLayers(action).ports, null, 'les prises tombent sous 20 %');
    assert.match(backgroundLayers(stage).decoration, /d="M3 7V5a2 2 0 0 1 2-2h2"/,
      'le pictogramme reste visible à 15 %');
    assert.doesNotMatch(backgroundLayers(stage).decoration, /cx="94" cy="70"/,
      'aucun point audio ne se confond avec les prises de raccord');

    await engine.setViewport({ x: 0, y: 0, zoom: 0.10 });
    assert.doesNotMatch(backgroundLayers(stage).decoration, /d="M3 7V5a2 2 0 0 1 2-2h2"/,
      'le pictogramme tombe sous 12 %');
    assert.doesNotMatch(backgroundLayers(stage).decoration, /<rect x="17.33"/,
      'aucune barre ne le remplace : l’aplat de la carte porte l’Écran');
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test("l'Action est un aplat teal à tous les zooms, peint devant les Écrans", async () => {
  resetColorCache();
  // Les deux thèmes sont parcourus sur la feuille réelle : la teinte d'une
  // Action n'a de sens que relue au thème courant, et un basculement sans
  // mouvement de caméra doit la repeindre.
  const { light, dark } = themeTokens();
  const toRgb = (hex) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(',')})`;
  const tokens = ['--graph-action-bg', '--graph-action-border', '--graph-action-glyph'];
  const container = themedContainer(dark('--bg0'), Object.fromEntries(tokens.map((token) => [token, dark(token)])));
  const { engine, peek } = headlessCytoscape(container);
  const action = () => peek().$id('action');
  const wearTheme = (read) => {
    container.background = read('--bg0');
    for (const token of tokens) container.variables[token] = read(token);
    engine.refreshTheme();
  };

  try {
    await engine.mount({
      nodes: [
        { id: 'stage', kind: 'stage', label: 'Accueil', x: 0, y: 0 },
        { id: 'action', kind: 'action', label: 'Choix', x: 240, y: 0, outgoingCount: 2 },
      ],
      edges: [],
    });
    assert.ok(
      Number(action().style('z-index')) > Number(peek().$id('stage').style('z-index')),
      'une Action passe devant un Écran, même agrandi au dézoom',
    );

    for (const [name, read] of [['sombre', dark], ['clair', light]]) {
      wearTheme(read);
      for (const zoom of [1, 0.25, 0.08, 0.02]) {
        await engine.setViewport({ x: 0, y: 0, zoom });
        assert.equal(action().style('background-color'), toRgb(read('--graph-action-bg')),
          `l'Action garde sa teinte à ${zoom * 100} % en thème ${name}`);
        assert.equal(action().style('border-color'), toRgb(read('--graph-action-border')));
        // Plus de silhouette neutre peinte dans la décoration : c'est le fond
        // du nœud qui porte la teinte, à tous les régimes.
        assert.doesNotMatch(backgroundLayers(action()).decoration, /<path d="M26 0 52 26 26 52 0 26Z" fill=/);
      }
    }
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('les teintes des Écrans et des Actions se séparent en clarté, pas seulement en teinte', () => {
  const { light, dark } = themeTokens();
  // Violet et teal à luminance égale ne se séparent plus pour un œil qui
  // confond les deux teintes, et au dézoom la forme n'est plus lisible. L'écart
  // est donc tenu en contraste, contre le contour d'un Écran — qui devient son
  // aplat sous 12 % — comme contre sa carte.
  for (const [name, read] of [['clair', light], ['sombre', dark]]) {
    const canvas = read('--bg0');
    const action = read('--graph-action-bg');
    const border = read('--graph-action-border');
    const glyph = read('--graph-action-glyph');
    for (const [token, value] of [['--graph-action-bg', action], ['--graph-action-border', border], ['--graph-action-glyph', glyph]]) {
      assert.ok(value, `${token} absent du thème ${name}`);
    }
    assert.ok(contrastRatio(action, canvas) >= 3,
      `Action ${action} sur fond ${canvas} : ${contrastRatio(action, canvas).toFixed(2)}:1 en thème ${name}, attendu 3:1`);
    assert.ok(contrastRatio(glyph, action) >= 4.5,
      `pictogramme ${glyph} sur Action ${action} : ${contrastRatio(glyph, action).toFixed(2)}:1 en thème ${name}`);
    for (const token of ['--graph-card-border', '--graph-card-bg']) {
      assert.ok(contrastRatio(action, read(token)) >= 1.5,
        `Action ${action} contre ${token} ${read(token)} : ${contrastRatio(action, read(token)).toFixed(2)}:1 en thème ${name}, attendu 1,5:1`);
    }
    // Le contour s'écarte du fond dans le même sens que l'aplat, comme pour la
    // carte d'un Écran : sans quoi il se referme sur le fond.
    assert.equal(
      Math.sign(relativeLuminance(action) - relativeLuminance(canvas)),
      Math.sign(relativeLuminance(border) - relativeLuminance(action)),
      `le contour d'Action du thème ${name} revient vers le fond`,
    );
    // L'aplat d'un Écran au dézoom est une marque de quelques pixels : il tient
    // 3:1, là où la carte au zoom de travail est relâchée à 2:1 en clair.
    assert.ok(contrastRatio(read('--graph-card-border'), canvas) >= 3,
      `aplat d'Écran sur fond ${canvas} : ${contrastRatio(read('--graph-card-border'), canvas).toFixed(2)}:1 en thème ${name}`);
  }
});

test('au dézoom, les nœuds sont agrandis autour de leur centre et peints en aplat', async () => {
  resetColorCache();
  const { dark } = themeTokens();
  const container = themedContainer(dark('--bg0'), {
    '--graph-card-bg': dark('--graph-card-bg'),
    '--graph-card-border': dark('--graph-card-border'),
  });
  const { engine, peek } = headlessCytoscape(container);
  const toRgb = (hex) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(',')})`;
  const size = (id) => [peek().$id(id).style('width'), peek().$id(id).style('height')].map(Number.parseFloat);

  try {
    await engine.mount({
      nodes: [
        { id: 'stage', kind: 'stage', label: 'Accueil', x: 0, y: 0 },
        { id: 'action', kind: 'action', label: 'Choix', x: 240, y: 0, outgoingCount: 2 },
      ],
      edges: [],
    });
    assert.deepEqual(size('stage'), [104, 80]);
    assert.deepEqual(size('action'), [52, 52]);
    assert.equal(peek().$id('stage').style('background-color'), toRgb(dark('--graph-card-bg')));

    await engine.setViewport({ x: 0, y: 0, zoom: 0.13 });
    assert.deepEqual(size('stage'), [104, 80], 'rien ne change au-dessus de 12 %');

    // Entre 12 et 5 %, l'Action est agrandie et l'Écran passe en aplat, mais
    // garde sa taille : il porte encore sa vignette, et l'agrandir avec elle
    // coûtait la moitié de la cadence du cadrage large sur 9 121 nœuds.
    await engine.setViewport({ x: 0, y: 0, zoom: 0.11 });
    assert.deepEqual(size('action'), [104, 104], 'Action agrandie sous 12 %');
    assert.deepEqual(size('stage'), [104, 80], 'Écran à sa taille tant que les vignettes restent');
    assert.equal(peek().$id('stage').style('background-color'), toRgb(dark('--graph-card-border')),
      "la carte devient l'aplat de son contour sous 12 %");

    await engine.setViewport({ x: 0, y: 0, zoom: 0.04 });
    assert.deepEqual(size('stage'), [156, 120], 'Écran agrandi sous 5 %, vignettes retirées');
    assert.deepEqual(size('action'), [104, 104]);
    // Le régime éloigné ne réduit plus les nœuds en poussière : sous 3 %, ils
    // gardent leur aplat typé et leur taille agrandie.
    await engine.setViewport({ x: 0, y: 0, zoom: 0.02 });
    await engine.setDetailLevel('simplified');
    assert.deepEqual(size('stage'), [156, 120]);
    assert.deepEqual(size('action'), [104, 104]);
    assert.equal(peek().$id('action').style('shape'), 'diamond');
    await engine.setDetailLevel('full');

    // Les positions ne bougent pas, et la taille d'origine revient intacte.
    await engine.setViewport({ x: 0, y: 0, zoom: 0.5 });
    assert.deepEqual(size('stage'), [104, 80]);
    assert.deepEqual(size('action'), [52, 52]);
    assert.deepEqual(peek().$id('action').position(), { x: 240, y: 0 });
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test("les terminaisons, la gaine et l'opacité des liens suivent le dézoom", async () => {
  resetColorCache();
  const container = themedContainer('#0a0a0e');
  const { engine, peek } = headlessCytoscape(container);
  const shape = (id) => peek().$id(id).style('target-arrow-shape');
  const opacity = (id) => Number.parseFloat(peek().$id(id).style('opacity'));
  const sheath = () => Number.parseFloat(peek().$id('ok').style('underlay-opacity'));
  try {
    await engine.mount({
      nodes: [
        { id: 'stage', kind: 'stage', label: 'Accueil', x: 0, y: 0 },
        { id: 'action', kind: 'action', label: 'Choix', x: 240, y: 0, outgoingCount: 1 },
        { id: 'retour', kind: 'stage', label: 'Retour', x: 480, y: 0 },
      ],
      edges: [
        { id: 'ok', kind: 'stage-ok', source: 'stage', target: 'action' },
        { id: 'home', kind: 'stage-home', source: 'action', target: 'retour' },
        { id: 'option', kind: 'action-option', source: 'action', target: 'retour' },
      ],
    });
    // Les trois natures gardent leur terminaison propre au zoom de travail :
    // c'est elle, et non la couleur, qui les sépare dans la légende.
    assert.deepEqual([shape('ok'), shape('home'), shape('option')], ['triangle', 'tee', 'circle']);
    assert.equal(peek().$id('ok').style('mid-target-arrow-shape'), 'chevron');
    assert.equal(sheath(), 1);
    assert.equal(opacity('ok'), 1);

    await engine.setViewport({ x: 0, y: 0, zoom: 0.19 });
    assert.deepEqual([shape('ok'), shape('home'), shape('option')], ['none', 'none', 'none'],
      'les terminaisons tombent sous 20 %, où elles mesurent moins de deux pixels');
    assert.equal(peek().$id('ok').style('mid-target-arrow-shape'), 'none');
    assert.equal(sheath(), 0, 'la gaine tombe avec elles');
    assert.equal(opacity('ok'), 1, 'le trait garde son opacité jusqu’à 12 %');

    await engine.setViewport({ x: 0, y: 0, zoom: 0.11 });
    assert.equal(opacity('ok'), 0.5, 'les traits passent au fond sous 12 %');

    // Le retrait et la trace de présentation sont déclarés après le régime
    // d'encre : un lien montré reste plein, un lien écarté reste écarté.
    await engine.setPresentation({ mode: 'playback', nodePaths: ['stage'], edgeIds: ['ok'] });
    assert.equal(opacity('ok'), 1);
    assert.equal(opacity('home'), 0.06);
    await engine.setPresentation(null);
    assert.equal(opacity('ok'), 0.5);
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('la boîte englobante d’un nœud contient les prises qui débordent de sa silhouette', async () => {
  resetColorCache();
  // Cytoscape met en cache le rendu de chaque nœud dans une tuile taillée à sa
  // boîte englobante : ce qui déborde y est rogné. Le défaut est invisible
  // pendant un mouvement de caméra, où la scène est peinte d'un bloc sans
  // passer par ce cache — d'où des pastilles entières pendant le zoom et
  // coupées en deux à l'arrêt. L'invariant est donc vérifié ici et non à l'œil.
  const container = themedContainer('#0a0a0e');
  const { engine, peek } = headlessCytoscape(container);
  try {
    await engine.mount({
      nodes: [
        { id: 'stage', kind: 'stage', label: 'S', x: 0, y: 0, optionSlots: 1 },
        { id: 'lonely', kind: 'action', label: 'A', x: 400, y: 0, optionSlots: 1 },
        { id: 'busy', kind: 'action', label: 'B', x: 800, y: 0, optionSlots: 12 },
        { id: 'crowded', kind: 'action', label: 'C', x: 1200, y: 0, optionSlots: 40 },
      ],
      edges: [],
    });
    for (const path of ['stage', 'lonely', 'busy', 'crowded']) {
      const node = peek().$id(path);
      const box = node.boundingBox();
      for (const port of nodePortOffsets(node.data('kind'), node.data('optionSlots'))) {
        assert.ok(
          Math.abs(port.x) + PORT_RADIUS <= box.w / 2 && Math.abs(port.y) + PORT_RADIUS <= box.h / 2,
          `${path} : une prise sort de la boîte englobante et sera rognée par le cache de tuile`,
        );
      }
    }
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('les décorations suivent le thème et préservent la couleur personnelle sans inventer de groupe', async () => {
  resetColorCache();
  const container = themedContainer('#0a0a0e', {
    '--graph-card-bg': '#5f5d70',
    '--graph-card-border': '#7b7891',
    '--graph-action-glyph': '#031a19',
    '--text-secondary': '#a6a2c0',
    '--muted': '#6e6c8a',
    '--info': '#79b8ff',
  });
  const { engine, peek } = headlessCytoscape(container);
  try {
    await engine.mount({
      nodes: [
        { id: 'personal', kind: 'stage', label: 'Personnel', x: 0, y: 0, personalColor: '#123456' },
        { id: 'grouped', kind: 'stage', label: 'Groupe', x: 120, y: 0, groupId: 'g1' },
        { id: 'empty-action', kind: 'action', label: 'Vide', x: 240, y: 0, outgoingCount: 0 },
      ],
      edges: [],
    });
    const personal = peek().$id('personal');
    const grouped = peek().$id('grouped');
    const action = peek().$id('empty-action');
    const personalSvg = backgroundLayers(personal).decoration;
    const groupedSvg = backgroundLayers(grouped).decoration;
    const darkActionSvg = backgroundLayers(action).decoration;
    assert.match(personalSvg, /fill="#123456" fill-opacity="\.36"/);
    assert.doesNotMatch(personalSvg, /width="104" height="6"/,
      'un Écran sans groupe ne reçoit pas de faux bandeau');
    assert.match(groupedSvg, /width="104" height="6"/);
    assert.match(darkActionSvg, /stroke="#031a19"/, 'le glyphe d’une Action suit le thème sombre');
    // Une Action sans option porte deux prises : son arrivée, et le cran
    // d'ajout qui rend une Action vide raccordable. Elle n'a pas de rail — il
    // n'y a rien à relier tant qu'il n'y a qu'un cran.
    const emptyPorts = backgroundLayers(action).ports;
    assert.equal((emptyPorts.match(/<circle/g) ?? []).length, 2);
    assert.doesNotMatch(emptyPorts, /<rect/);
    assert.match(personalSvg, /stroke="#123456"/);

    container.background = '#EBEEF3';
    Object.assign(container.variables, {
      '--graph-card-bg': '#a2aab9',
      '--graph-card-border': '#7e8797',
      '--graph-action-glyph': '#ffffff',
      '--text-secondary': '#4d5666',
      '--muted': '#707a8a',
      '--info': '#246fa8',
    });
    engine.refreshTheme();
    const lightActionSvg = backgroundLayers(action).decoration;
    assert.match(lightActionSvg, /stroke="#ffffff"/);
    assert.doesNotMatch(lightActionSvg, /#031a19/);
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

const linkElements = {
  nodes: [
    { id: 'stage-a', kind: 'stage', x: 0, y: 0 },
    { id: 'action', kind: 'action', x: 100, y: 0 },
    { id: 'stage-b', kind: 'stage', x: 200, y: 0 },
  ],
  edges: [
    { id: 'ok', kind: 'stage-ok', visibilityGroup: 'structure', source: 'stage-a', target: 'action', sourceEndpoint: '50% 0%', targetEndpoint: '-50% 0%' },
    { id: 'home', kind: 'stage-home', visibilityGroup: 'returns', source: 'stage-b', target: 'action', sourceEndpoint: '0% 50%', targetEndpoint: '-50% 0%' },
    { id: 'option', kind: 'action-option', visibilityGroup: 'structure', source: 'action', target: 'stage-b', sourceEndpoint: '33.33% -16.67%', targetEndpoint: '-50% 0%' },
    { id: 'random', kind: 'action-option', visibilityGroup: 'random', random: true, source: 'action', target: 'stage-a', sourceEndpoint: '33.33% 16.67%', targetEndpoint: '-50% 0%' },
  ],
};

test('un lien accroché avive ses deux bouts, et redevient uni sous le pointeur', async () => {
  resetColorCache();
  const { dark } = themeTokens();
  const container = themedContainer(dark('--bg0'), {
    '--graph-link-return': dark('--graph-link-return'),
    '--info': dark('--info'),
    '--text-secondary': dark('--text-secondary'),
    '--muted': dark('--muted'),
  });
  const { engine, peek } = headlessCytoscape(container);
  const toRgb = (hex) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(',')})`;
  try {
    await engine.mount(linkElements);
    const ok = peek().$id('ok');
    const home = peek().$id('home');
    // Un trait qui ne fait que passer derrière un nœud le croise avec son
    // milieu terne ; accroché, il le quitte dans la teinte vive.
    assert.equal(ok.style('line-fill'), 'linear-gradient');
    const stops = (edge) => String(edge.style('line-gradient-stop-colors')).replace(/\s+/g, '');
    const expected = (end, middle) => [end, middle, middle, end].map(toRgb).join('');
    assert.equal(stops(ok), expected(dark('--text-secondary'), dark('--muted')));
    assert.equal(stops(home), expected(dark('--info'), dark('--graph-link-return')));
    ok.addClass('pointer-hover');
    assert.equal(ok.style('line-fill'), 'solid', 'le survol repeint le trait d’une seule teinte');
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('le survol ravive la famille d’un lien, et le retrait passe avant lui', async () => {
  resetColorCache();
  const { dark } = themeTokens();
  const container = themedContainer(dark('--bg0'), {
    '--graph-link-return': dark('--graph-link-return'),
    '--info': dark('--info'),
    '--text-secondary': dark('--text-secondary'),
  });
  const { engine, peek } = headlessCytoscape(container);
  const toRgb = (hex) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(',')})`;
  try {
    await engine.mount(linkElements);
    const home = () => peek().$id('home');
    const ok = () => peek().$id('ok');

    // Au repos, un retour porte sa teinte de retrait, pas le bleu franc.
    assert.equal(home().style('line-color'), toRgb(dark('--graph-link-return')));

    // Chez Cytoscape, la dernière règle qui touche une propriété gagne : les
    // règles d'état doivent donc être déclarées après les familles. Elles ne
    // l'étaient pas, et la recoloration du survol n'a jamais rien peint.
    home().addClass('pointer-hover');
    assert.equal(home().style('line-color'), toRgb(dark('--info')),
      'le bleu franc est réservé au lien qu’on survole');
    assert.equal(Number.parseFloat(home().style('width')), 2.6);
    ok().addClass('pointer-hover');
    assert.equal(ok().style('line-color'), toRgb(dark('--text-secondary')),
      'une structure survolée s’éclaircit sans changer de famille');

    // Et le retrait de présentation passe **avant** le survol : un lien écarté
    // le reste même sous le pointeur.
    home().addClass('presentation-dim');
    assert.equal(Number.parseFloat(home().style('opacity')), 0.06);
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('la teinte de retrait d’un retour reste du même rang que la structure', () => {
  const { light, dark } = themeTokens();
  // `--info` est fait pour un message, pas pour des centaines de traits : il
  // tient 9,5:1 sur le fond sombre contre 3,9:1 pour une structure, soit deux
  // fois et demie son poids alors que les deux familles sont de même rang.
  // L'atténuer par l'opacité ne tient pas les deux thèmes — le bleu est plus
  // clair que le fond en sombre et plus sombre en clair — d'où une teinte.
  for (const [name, read] of [['clair', light], ['sombre', dark]]) {
    const canvas = read('--bg0');
    const rest = contrastRatio(read('--graph-link-return'), canvas);
    const structure = contrastRatio(read('--muted'), canvas);
    assert.ok(rest >= 3, `le retour disparaît en thème ${name} : ${rest.toFixed(2)}:1`);
    assert.ok(
      rest <= structure * 1.5,
      `le retour pèse encore ${(rest / structure).toFixed(2)} fois la structure en thème ${name}`,
    );
    assert.ok(rest < contrastRatio(read('--info'), canvas),
      `le repos doit être en retrait du bleu de survol en thème ${name}`);
  }
});

test('les halos d’une Action épousent son losange plutôt que de l’encadrer', async () => {
  resetColorCache();
  const container = themedContainer('#0a0a0e');
  const { engine, peek } = headlessCytoscape(container);
  try {
    await engine.mount({
      nodes: [
        { id: 'stage', kind: 'stage', label: 'S', x: 0, y: 0 },
        { id: 'action', kind: 'action', label: 'A', x: 200, y: 0, optionSlots: 1 },
      ],
      edges: [],
    });
    // Cytoscape peint sélection, survol d'un lien attenant et lecture en cours
    // dans la forme que dit `overlay-shape`, jamais dans celle du nœud : un
    // losange héritait donc d'un cadre rectangulaire.
    assert.equal(peek().$id('action').style('overlay-shape'), 'ellipse');
    assert.equal(peek().$id('stage').style('overlay-shape'), 'round-rectangle');
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('les nœuds passent devant les liens, qui restent gainés à leurs croisements', async () => {
  resetColorCache();
  const { dark } = themeTokens();
  const container = themedContainer(dark('--bg0'), {
    '--graph-card-bg': dark('--graph-card-bg'),
    '--graph-card-border': dark('--graph-card-border'),
  });
  const { engine, peek } = headlessCytoscape(container);

  try {
    await engine.mount(linkElements);
    const edge = () => peek().$id('ok');
    const node = () => peek().$id('stage-a');

    // Le renderer examine les éléments dans l'ordre inverse de peinture pour
    // choisir la cible du pointeur : une carte traversée doit gagner le clic.
    assert.equal(edge().style('z-index-compare'), 'manual');
    assert.equal(node().style('z-index-compare'), 'manual');
    assert.ok(Number(node().style('z-index')) > Number(edge().style('z-index')));

    assert.equal(edge().style('underlay-color'), 'rgb(10,10,14)');
    assert.equal(Number.parseFloat(edge().style('underlay-opacity')), 1);
    // Cytoscape ajoute le padding de chaque côté au trait existant. Le couloir
    // ainsi réservé vaut 1,8 fois la largeur du trait : assez pour séparer deux
    // croisements, trop peu pour que les gaines d'un faisceau se recouvrent et
    // le fassent lire en peigne.
    const corridor = Number.parseFloat(edge().style('width'))
      + (2 * Number.parseFloat(edge().style('underlay-padding')));
    assert.equal(Math.round(corridor * 100) / 100, 3.1);
    assert.ok(corridor / Number.parseFloat(edge().style('width')) < 2);

    // La gaine suit l'opacité de son trait. Cytoscape ne les multiplie pas :
    // un lien mis en retrait garderait sinon une traînée opaque à la couleur
    // du fond, visible à ses croisements avec d'autres liens.
    await engine.setPresentation({ mode: 'connections', nodePaths: [], edgeIds: [] });
    assert.equal(Number.parseFloat(edge().style('underlay-opacity')), Number.parseFloat(edge().style('opacity')));
    await engine.setPresentation(null);
    await engine.setDetailLevel('simplified');
    assert.equal(Number.parseFloat(edge().style('underlay-opacity')), 0);
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('trois natures de lien, trois terminaisons, distinctes sans la couleur', async () => {
  resetColorCache();
  const container = themedContainer('#0a0a0e');
  const { engine, peek } = headlessCytoscape(container);

  try {
    await engine.mount(linkElements);
    const shapeOf = (id) => peek().$id(id).style('target-arrow-shape');
    const terminations = {
      ok: shapeOf('ok'), home: shapeOf('home'), option: shapeOf('option'), random: shapeOf('random'),
    };
    assert.deepEqual(terminations, {
      ok: 'triangle', home: 'tee', option: 'circle', random: 'circle',
    });
    assert.equal(peek().$id('ok').style('source-endpoint'), '50% 0%');
    assert.equal(peek().$id('home').style('source-endpoint'), '0% 50%');
    assert.equal(peek().$id('option').style('source-endpoint'), '33.33% -16.67%');
    assert.equal(peek().$id('option').style('target-endpoint'), '-50% 0%');

    // La contrainte du projet : chaque famille filtrable reste identifiable par
    // la forme quand les deux autres sont masquées. Les trois natures portent
    // donc trois terminaisons différentes, et l'option tirée au sort se sépare
    // de l'option figée par son motif de trait, pas par sa terminaison.
    assert.equal(new Set(['ok', 'home', 'option'].map(shapeOf)).size, 3);
    assert.equal(peek().$id('option').style('line-style'), 'solid');
    assert.equal(peek().$id('random').style('line-style'), 'dashed');
    assert.notDeepEqual(
      peek().$id('random').style('line-dash-pattern'),
      peek().$id('home').style('line-dash-pattern'),
    );

    // Le chevron médian est conservé — il porte le sens en cours de trait — et
    // reste creux pour ne pas se confondre avec le triangle plein de l'arrivée.
    for (const id of Object.keys(terminations)) {
      assert.equal(peek().$id(id).style('mid-target-arrow-shape'), 'chevron');
    }
  } finally {
    engine.destroy();
    resetColorCache();
  }
});

test('la phase et le pas de grille suivent exactement pan et zoom', () => {
  const positiveModulo = (value, period) => ((value % period) + period) % period;
  const modulo = (value, period) => {
    const result = positiveModulo(value, period);
    return Math.abs(result) < 1e-8 || Math.abs(period - result) < 1e-8 ? 0 : result;
  };

  for (const zoom of [0.04, 0.1, 0.4, 0.8, 1.25, 4]) {
    for (const [x, y] of [[83.75, -129.5], [-400.25, 96.125]]) {
      const style = cytoscapeGridStyle({ x, y, zoom });
      const minorStep = 32 * zoom;
      const majorStep = minorStep * 5;
      assert.equal(style['--graph-grid-step'], `${minorStep}px`);
      assert.equal(style['--graph-grid-major-step'], `${majorStep}px`);

      for (const [worldX, worldY] of [[0, 0], [160, -320], [-640, 480]]) {
        const minorX = modulo(worldX * zoom + x, minorStep);
        const minorY = modulo(worldY * zoom + y, minorStep);
        const majorX = modulo(worldX * zoom + x, majorStep);
        const majorY = modulo(worldY * zoom + y, majorStep);
        assert.ok(Math.abs(minorX - Number.parseFloat(style['--graph-grid-x'])) < 1e-8);
        assert.ok(Math.abs(minorY - Number.parseFloat(style['--graph-grid-y'])) < 1e-8);
        assert.ok(Math.abs(majorX - Number.parseFloat(style['--graph-grid-major-x'])) < 1e-8);
        assert.ok(Math.abs(majorY - Number.parseFloat(style['--graph-grid-major-y'])) < 1e-8);
      }
    }
  }

  assert.equal(cytoscapeGridStyle({ zoom: 0.04 })['--graph-grid-minor-alpha'], '0.00%');
  assert.equal(cytoscapeGridStyle({ zoom: 0.04 })['--graph-grid-major-alpha'], '0.00%');
  assert.ok(Number.parseFloat(cytoscapeGridStyle({ zoom: 0.5 })['--graph-grid-minor-alpha']) > 0);
  assert.equal(cytoscapeGridStyle({ zoom: 0.5 })['--graph-grid-major-step'], '80px');
});

test('pan/zoom rapprochés publient la dernière grille sur une seule frame et resize reste aligné', async () => {
  resetColorCache();
  const container = themedContainer('#EBEEF3');
  const styleValues = new Map();
  const frames = new Map();
  let nextFrameId = 1;
  const frameWindow = container.ownerDocument.defaultView;
  frameWindow.requestAnimationFrame = callback => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  frameWindow.cancelAnimationFrame = id => frames.delete(id);
  container.style = {
    setProperty: (property, value) => styleValues.set(property, value),
    removeProperty: property => styleValues.delete(property),
  };
  let instance;
  const engine = createCytoscapeEngine({
    container,
    cytoscape: options => {
      instance = cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
      return instance;
    },
  });
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  try {
    await engine.mount(elements);
    flushFrames();
    for (let frame = 0; frame < 80; frame += 1) {
      await engine.setViewport({
        x: 320.25 - frame * 2.75,
        y: -141.5 + frame * 1.875,
        zoom: 0.2 + frame * 0.023,
      });
    }
    assert.ok(frames.size <= 2, 'la grille et les surimpressions partagent au plus deux callbacks RAF');
    flushFrames();
    const expected = cytoscapeGridStyle(engine.getViewport());
    for (const [property, value] of Object.entries(expected)) assert.equal(styleValues.get(property), value);

    engine.resize();
    flushFrames();
    for (const [property, value] of Object.entries(expected)) assert.equal(styleValues.get(property), value);

    engine.setViewport({ x: -19.5, y: 80.25, zoom: 0.04 });
    assert.ok(frames.size > 0);
  } finally {
    engine.destroy();
    assert.equal(frames.size, 0, 'la destruction annule les callbacks RAF en attente');
    assert.equal(styleValues.size, 0, 'la destruction retire les variables de grille du conteneur');
    resetColorCache();
  }
});

test('Cytoscape réel headless : sélection utilisateur suivie de restauration sans écho', async () => {
  let instance; const events = [];
  const engine = createCytoscapeEngine({ cytoscape: options => {
    instance = cytoscape({ ...options, headless: true, styleEnabled: false });
    return instance;
  }, onSelect: selected => events.push(selected) });
  try {
    await engine.mount(elements);
    instance.$id('a').select();
    assert.deepEqual(events, [['a']]);
    await engine.setSelection(['b']);
    assert.deepEqual(instance.$(':selected').map(n => n.id()), ['b']);
    assert.equal(events.length, 1);
    await engine.setViewport({ x: 41, y: -18, zoom: 2 });
    assert.deepEqual(engine.getViewport(), { x: 41, y: -18, zoom: 2 });
  } finally { engine.destroy(); }
});

test('Cytoscape applique le voisinage et la trace avec un seul état de présentation', async () => {
  let instance;
  const engine = createCytoscapeEngine({ cytoscape: options => {
    instance = cytoscape({ ...options, headless: true, styleEnabled: false });
    return instance;
  } });
  try {
    await engine.mount({
      nodes: [
        { id: 'stage-a', kind: 'stage', x: 0, y: 0 },
        { id: 'action', kind: 'action', x: 100, y: 0 },
        { id: 'stage-b', kind: 'stage', x: 200, y: 0 },
      ],
      edges: [
        { id: 'home', kind: 'stage-home', source: 'stage-a', target: 'action' },
        { id: 'option', kind: 'action-option', source: 'action', target: 'stage-b' },
      ],
    });
    await engine.setPresentation({
      mode: 'connections',
      nodePaths: ['stage-a', 'action'],
      edgeIds: ['home'],
    });
    assert.equal(instance.$id('stage-b').hasClass('presentation-dim'), true);
    assert.equal(instance.$id('stage-a').hasClass('presentation-dim'), false);

    await engine.setPresentation({
      mode: 'playback',
      nodePaths: ['stage-a', 'action', 'stage-b'],
      edgeIds: ['home', 'option'],
    });
    assert.equal(instance.$id('option').hasClass('presentation-trace'), true);
  } finally { engine.destroy(); }
});

test('Cytoscape filtre les familles de liens sans retirer les arêtes du graphe', async () => {
  let instance;
  const engine = createCytoscapeEngine({ cytoscape: options => {
    instance = cytoscape({ ...options, headless: true, styleEnabled: false });
    return instance;
  } });
  try {
    await engine.mount({
      nodes: [
        { id: 'stage-a', kind: 'stage', x: 0, y: 0 },
        { id: 'action', kind: 'action', x: 100, y: 0 },
        { id: 'stage-b', kind: 'stage', x: 200, y: 0 },
      ],
      edges: [
        { id: 'structure', kind: 'stage-ok', visibilityGroup: 'structure', source: 'stage-a', target: 'action' },
        { id: 'return', kind: 'stage-home', visibilityGroup: 'returns', source: 'stage-b', target: 'action' },
        { id: 'random', kind: 'action-option', visibilityGroup: 'random', random: true, source: 'action', target: 'stage-b' },
      ],
    });
    await engine.setEdgeVisibility({ structure: false, returns: true, random: false });
    assert.equal(instance.$id('structure').hasClass('legend-hidden'), true);
    assert.equal(instance.$id('return').hasClass('legend-hidden'), false);
    assert.equal(instance.$id('random').hasClass('legend-hidden'), true);
    assert.equal(instance.edges().length, 3, 'les filtres ne mutent pas le graphe');

    await engine.setEdgeVisibility({ structure: true, returns: false, random: true });
    assert.equal(instance.$id('structure').hasClass('legend-hidden'), false);
    assert.equal(instance.$id('return').hasClass('legend-hidden'), true);
    assert.equal(instance.$id('random').hasClass('legend-hidden'), false);
  } finally { engine.destroy(); }
});

test('G6 : conversion commune de caméra, densité explicite et position de glisser', async () => {
  let instance; let drag;
  class Graph {
    constructor(options) { this.options = options; this.zoom = 1; this.origin = [23, 42]; this.events = {}; instance = this; }
    on(name, callback) { this.events[name] = callback; }
    async render() {}
    getNodeData() { return this.options.data.nodes; }
    getEdgeData() { return this.options.data.edges; }
    async zoomTo(zoom) { this.zoom = zoom; this.origin = [91, -56]; }
    getViewportByCanvas() { return this.origin; }
    async translateBy([x, y]) { this.origin = [this.origin[0] + x, this.origin[1] + y]; }
    getZoom() { return this.zoom; }
    getElementPosition() { return [12.5, -17, 0]; }
    destroy() {}
  }
  const engine = createG6Engine({ g6: { Graph }, onNodeDragEnd: (path, position) => { drag = { path, position }; } });
  try {
    await engine.mount(elements);
    assert.equal(instance.options.devicePixelRatio, 1);
    for (const zoom of [0.1, 1, 4]) {
      await engine.setViewport({ x: 270, y: -48, zoom });
      assert.deepEqual(engine.getViewport(), { x: 270, y: -48, zoom });
    }
    instance.events['node:dragend']({ target: { id: 'a' } });
    assert.deepEqual(drag, { path: 'a', position: { x: 12.5, y: -17 } });
  } finally { engine.destroy(); }
});

test('G6 applique les filtres de légende par groupe et ne touche qu’au rendu', async () => {
  let instance;
  class Graph {
    constructor(options) { this.options = options; this.hidden = []; this.shown = []; instance = this; }
    on() {}
    async render() {}
    getNodeData() { return this.options.data.nodes; }
    getEdgeData() { return this.options.data.edges; }
    async hideElement(ids) { this.hidden.push(...ids); }
    async showElement(ids) { this.shown.push(...ids); }
    destroy() {}
  }
  const engine = createG6Engine({ g6: { Graph } });
  try {
    await engine.mount({ nodes: [], edges: [
      { id: 'structure', kind: 'stage-ok', visibilityGroup: 'structure', source: 'a', target: 'b' },
      { id: 'return', kind: 'stage-home', visibilityGroup: 'returns', source: 'a', target: 'b' },
      { id: 'random', kind: 'action-option', visibilityGroup: 'random', source: 'a', target: 'b' },
    ] });
    await engine.setEdgeVisibility({ structure: false, returns: true, random: false });
    assert.deepEqual(instance.hidden.sort(), ['random', 'structure']);
    await engine.setEdgeVisibility({ structure: true, returns: true, random: true });
    assert.deepEqual(instance.shown.sort(), ['random', 'structure']);
  } finally { engine.destroy(); }
});

test('vis-network applique le filtre sans reconstruire sa collection de liens', async () => {
  let instance;
  class DataSet {
    constructor(items) { this.items = items.map((item) => ({ ...item })); }
    update(updates) {
      for (const update of updates) {
        const current = this.items.find((item) => item.id === update.id);
        Object.assign(current, update);
      }
    }
  }
  class Network {
    constructor(_container, data) { this.data = data; instance = this; }
    on() {}
    destroy() {}
  }
  const engine = createVisNetworkEngine({ visNetwork: { DataSet, Network } });
  try {
    await engine.mount({ nodes: [], edges: [
      { id: 'structure', kind: 'stage-ok', visibilityGroup: 'structure', source: 'a', target: 'b' },
      { id: 'return', kind: 'stage-home', visibilityGroup: 'returns', source: 'a', target: 'b' },
      { id: 'random', kind: 'action-option', visibilityGroup: 'random', source: 'a', target: 'b' },
    ] });
    await engine.setEdgeVisibility({ structure: true, returns: false, random: true });
    const edges = instance.data.edges.items;
    assert.equal(edges.find((edge) => edge.id === 'return').hidden, true);
    assert.equal(edges.find((edge) => edge.id === 'structure').hidden, false);
    assert.equal(edges.find((edge) => edge.id === 'random').hidden, false);
    await engine.setEdgeVisibility({ structure: true, returns: true, random: false });
    assert.equal(edges.find((edge) => edge.id === 'return').hidden, false);
    assert.equal(edges.find((edge) => edge.id === 'random').hidden, true);
  } finally { engine.destroy(); }
});

test('le banc relève les pixels alloués, indépendamment du DPR de fenêtre', () => {
  const metrics = canvasMetrics({ querySelectorAll: () => [{ width: 800, height: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) }] });
  assert.equal(metrics[0].ratioX, 1);
  assert.equal(metrics[0].ratioY, 1);
});

test('la sonde de réactivité relève un retard de boucle et se nettoie', () => {
  let now = 0; let beat; let cancelled; const samples = [];
  const stop = probeResponsiveness({ now: () => now, schedule: cb => { beat = cb; return 1; }, cancel: id => { cancelled = id; }, onBeat: sample => samples.push(sample) });
  now = 1000; beat(); now = 9000; beat();
  const result = stop();
  assert.equal(result.maxEventLoopGapMs, 8000);
  assert.equal(result.beats, 2);
  assert.equal(samples.length, 2);
  assert.equal(cancelled, 1);
});
