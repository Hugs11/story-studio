// Conversion des couleurs de thème vers ce qu'un moteur de rendu sait lire.
//
// `src/styles/variables.css` exprime les accents en `oklch(...)` et les états
// en `color-mix(...)`. Le parseur de styles de Cytoscape refuse ces deux
// syntaxes : passée telle quelle, la valeur est rejetée et la règle tombe.
// Le repli hexadécimal des adaptateurs ne rattrapait pas ce cas — il ne sert
// que lorsque la variable est **vide**, pas lorsque sa valeur est refusée.
// Les cartes, les contours de sélection et les diagnostics perdaient donc leur
// couleur sur le canvas alors que la couche HTML, elle, les affichait.
//
// La conversion n'est pas réécrite ici : c'est la WebView qui convertit. La
// valeur est peinte sur un canvas de 1 × 1 puis relue en octets sRGB. Ce
// chemin couvre toutes les syntaxes que la WebView sait lire — y compris
// celles qu'elle apprendra plus tard — sans table de correspondance à
// maintenir, sans dépendance nouvelle, et de la même façon sur les trois
// plateformes puisque c'est le moteur web qui répond.

// Le canevas de mesure est partagé : une couleur est convertie une fois, pas
// une fois par règle de style.
let probe = null;

function probeContext(view) {
  if (probe && probe.view === view) return probe.context;
  const document = view?.document;
  if (typeof document?.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext?.('2d', { willReadFrequently: true }) ?? null;
  probe = context ? { view, context } : null;
  return context;
}

// Deux témoins différents : une valeur **refusée** laisse le témoin en place,
// et les deux lectures divergent. Une valeur acceptée donne deux fois les
// mêmes octets, quelle que soit sa syntaxe. C'est ce qui distingue « la
// WebView ne connaît pas cette couleur » de « cette couleur est rouge ».
function paint(context, witness, value) {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = witness;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data;
}

const CACHE_LIMIT = 256;
const cache = new Map();

// Rend la couleur en sRGB, ou `null` si la WebView elle-même la refuse — auquel
// cas l'appelant garde son repli déclaré plutôt que de transmettre au moteur
// une valeur qu'il rejettera silencieusement.
export function toRenderableColor(value, view) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return null;
  if (cache.has(raw)) return cache.get(raw);
  let resolved = null;
  try {
    const context = probeContext(view);
    if (context) {
      const first = paint(context, '#ff0000', raw);
      const second = paint(context, '#0000ff', raw);
      const accepted = first[0] === second[0] && first[1] === second[1]
        && first[2] === second[2] && first[3] === second[3];
      if (accepted) resolved = serialize(first);
    }
  } catch {
    // Canvas indisponible — rendu hors navigateur, contexte refusé, lecture de
    // pixels interdite. L'appelant reste sur son repli : une palette approchée
    // vaut mieux qu'un rendu qui tombe.
    resolved = null;
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(raw, resolved);
  return resolved;
}

function serialize(channels) {
  const [red, green, blue, alpha] = channels;
  if (alpha === 255) {
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 1000) / 1000})`;
}

// La palette d'un adaptateur, relue depuis les variables CSS du conteneur puis
// convertie. `tokens` associe un nom d'usage à `[propriété CSS, repli]`.
//
// Elle est relue au montage **et à chaque changement de thème** : les styles
// d'un moteur sont construits une fois pour toutes, ils ne se recalculent pas
// seuls quand `data-theme` bascule.
export function readEngineColors(container, tokens) {
  const view = container?.ownerDocument?.defaultView
    ?? (typeof window === 'undefined' ? null : window);
  const computed = container && typeof view?.getComputedStyle === 'function'
    ? view.getComputedStyle(container)
    : null;
  const colors = {};
  for (const [name, definition] of Object.entries(tokens)) {
    const [property, fallback] = definition;
    const raw = computed?.getPropertyValue(property)?.trim() ?? '';
    colors[name] = toRenderableColor(raw, view) ?? fallback;
  }
  return colors;
}

// Réservé aux essais : le cache suit la valeur brute, qui change déjà d'elle-
// même avec le thème.
export function resetColorCache() {
  cache.clear();
  probe = null;
}
