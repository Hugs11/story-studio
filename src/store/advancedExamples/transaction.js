import { advancedGestures, presence } from '../projectModel/advancedGestures.js';
import { isFallbackProjectName } from '../projectSaveName.js';
import frGraph from '../../locales/fr/graph.json' with { type: 'json' };
import enGraph from '../../locales/en/graph.json' with { type: 'json' };
import itGraph from '../../locales/it/graph.json' with { type: 'json' };

const withoutValue = (field) => field?.presence !== 'value';
const SHORT_MIN = -32768;
const SHORT_MAX = 32767;
const BLOCK_MARGIN = 400;

function bounds(points) {
  return {
    minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
  };
}

// Le rectangle complet de l'exemple se place hors du rectangle du travail
// existant. La géométrie intérieure reste intacte, y compris au bord short.
export function exampleInsertionAnchor(view, example, preferredPoint = { x: 0, y: 0 }) {
  const offsets = [...example.stages, ...example.actions].map((node) => node.offset);
  if (offsets.length === 0 || offsets.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) {
    // eslint-disable-next-line i18next/no-literal-string -- Invariant technique du catalogue ; présenté comme erreur inattendue.
    throw new TypeError('Positions d’exemple invalides.');
  }
  const block = bounds(offsets);
  const lowX = SHORT_MIN - block.minX;
  const highX = SHORT_MAX - block.maxX;
  const lowY = SHORT_MIN - block.minY;
  const highY = SHORT_MAX - block.maxY;
  const occupied = [...(view.stages ?? []), ...(view.actions ?? [])]
    .map((node) => node.layout)
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const existing = occupied.length ? bounds(occupied) : null;
  const free = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)
    && point.x >= lowX && point.x <= highX && point.y >= lowY && point.y <= highY
    && (!existing
      || point.x + block.minX >= existing.maxX + BLOCK_MARGIN
      || point.x + block.maxX <= existing.minX - BLOCK_MARGIN
      || point.y + block.minY >= existing.maxY + BLOCK_MARGIN
      || point.y + block.maxY <= existing.minY - BLOCK_MARGIN);
  if (free(preferredPoint)) return { x: preferredPoint.x, y: preferredPoint.y };
  const alignX = Math.max(lowX, Math.min(highX, (existing?.minX ?? 0) - block.minX));
  const alignY = Math.max(lowY, Math.min(highY, (existing?.minY ?? 0) - block.minY));
  const candidates = existing ? [
    { x: existing.maxX + BLOCK_MARGIN - block.minX, y: alignY },
    { x: alignX, y: existing.maxY + BLOCK_MARGIN - block.minY },
    { x: existing.minX - BLOCK_MARGIN - block.maxX, y: alignY },
    { x: alignX, y: existing.minY - BLOCK_MARGIN - block.maxY },
  ] : [{ x: alignX, y: alignY }];
  const available = candidates.find(free);
  if (available) return available;
  // Refus présenté par sa clé, dans la langue courante ; le message reste technique.
  throw Object.assign(new Error('EXAMPLE_POSITION_UNAVAILABLE'), {
    code: 'EXAMPLE_POSITION_UNAVAILABLE',
    presentationRef: { key: 'examples:error.position.unavailable' },
  });
}

// Le squelette d'un projet neuf, tel que `create_advanced_document` le pose :
// « Écran 1 », OK seul actif, aucun média ni raccord. Son nom vient de la
// langue active à la création (`graph:node.defaultStageName`) : il est reconnu
// dans les trois langues et sous sa forme historique, quelle que soit la
// langue courante. Aucun nom existant n'est réécrit.
const firstStageName = (catalogue) => catalogue['node.defaultStageName'].replace('{{number}}', '1');
// eslint-disable-next-line i18next/no-literal-string -- Forme historique reconnue, jamais affichée ni écrite.
const SKELETON_NAMES = new Set(['Écran 1', ...[frGraph, enGraph, itGraph].map(firstStageName)]);
// Titres provisoires d'un document neuf (`graph:creation.pack.defaultName`),
// comparés sans casse : remplacés par le titre de l'exemple, jamais traduits.
const fallbackTitleKey = (title) => String(title ?? '').trim().normalize('NFKC').toLowerCase();
// eslint-disable-next-line i18next/no-literal-string -- Forme historique reconnue, jamais affichée ni écrite.
const FALLBACK_TITLES = new Set(['nouveau pack', ...[frGraph, enGraph, itGraph].map((catalogue) => fallbackTitleKey(catalogue['creation.pack.defaultName']))]);
const SKELETON_CONTROLS = Object.freeze({ wheel: false, ok: true, home: false, pause: false, autoplay: false });

function hasSkeletonControls(controls) {
  return Object.entries(SKELETON_CONTROLS).every(([key, value]) => (
    controls?.[key]?.presence === 'value' && controls[key].value === value
  ));
}

// Seule une entrée encore **intacte** est un squelette remplaçable. Un nom
// donné par l'auteur, un bouton réglé, une couleur, un média ou un raccord
// sont du travail : l'exemple s'ajoute alors à côté au lieu de le supprimer.
export function initialRootUuid(view) {
  if (view?.stages?.length !== 1 || (view.actions?.length ?? 0) !== 0) return null;
  const stage = view.stages[0];
  if (stage.squareOne?.presence !== 'value' || stage.squareOne.value !== true
    || stage.uniqueId === false || !stage.uuid
    || stage.name?.presence !== 'value' || !SKELETON_NAMES.has(String(stage.name.value ?? '').trim())
    || !hasSkeletonControls(stage.controls) || stage.personalColor
    || !withoutValue(stage.audio) || !withoutValue(stage.image)
    || !withoutValue(stage.okTransition) || !withoutValue(stage.homeTransition)) return null;
  return stage.uuid;
}

export function exampleSubgraph(example, anchor = { x: 0, y: 0 }) {
  // eslint-disable-next-line i18next/no-literal-string -- Invariant technique ; présenté comme erreur inattendue.
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) throw new TypeError('Position d’exemple invalide.');
  if (!Number.isInteger(example.entryRank) || !example.stages?.[example.entryRank]) {
    // eslint-disable-next-line i18next/no-literal-string -- Invariant technique du catalogue ; présenté comme erreur inattendue.
    throw new TypeError('L’exemple doit désigner son Écran d’entrée.');
  }
  const position = (offset) => {
    // eslint-disable-next-line i18next/no-literal-string -- Invariant technique ; présenté comme erreur inattendue.
    if (!Number.isFinite(offset?.x) || !Number.isFinite(offset?.y)) throw new TypeError('Position de nœud invalide.');
    return { x: anchor.x + offset.x, y: anchor.y + offset.y };
  };
  return {
    stages: example.stages.map(({ name, controls, offset }) => ({
      name, controls: { ...controls }, audio: null, image: null, position: position(offset),
    })),
    actions: example.actions.map(({ name, options, offset }) => ({
      name, options: options.map((option) => ({ ...option })), position: position(offset),
    })),
    transitions: example.transitions.map((transition) => ({ ...transition })),
  };
}

// Les étapes produisent uniquement des valeurs locales. La session d'auteur
// installe la **structure** complète en un seul commit — une seule étape
// d'undo —, ou jette tout au refus et à la péremption (undo, autre projet).
// Les médias ne font pas partie de cette transaction : ils arrivent ensuite,
// par des gestes séparés que `useAdvancedExamples` fond dans cette même étape
// tant que l'auteur n'a rien fait d'autre (voir `exampleHistory.js`).
export async function prepareExampleInsertion(project, example, {
  applyGesture, readView, isCurrent = () => true, anchor = { x: 0, y: 0 },
}) {
  const assertCurrent = () => {
    // eslint-disable-next-line i18next/no-literal-string -- Péremption interne de la session, jamais présentée.
    if (!isCurrent()) throw new Error('Le document de cet exemple a changé.');
  };
  assertCurrent();
  const view = await readView(project);
  assertCurrent();
  const rootUuid = initialRootUuid(view);
  const placedAnchor = rootUuid ? { x: 0, y: 0 } : exampleInsertionAnchor(view, example, anchor);
  let result = await applyGesture(project, advancedGestures.pasteSubgraph(exampleSubgraph(example, placedAnchor)));
  assertCurrent();
  const construction = result.report?.construction;
  if (construction?.stages?.length !== example.stages.length
    || construction?.actions?.length !== example.actions.length) {
    // eslint-disable-next-line i18next/no-literal-string -- Invariant du contrat natif ; présenté comme erreur inattendue.
    throw new Error('Le collage n’a pas rendu les identifiants des nœuds créés.');
  }
  const entryUuid = construction.stages[example.entryRank];
  if (rootUuid) {
    result = await applyGesture(result.project, advancedGestures.setSquareOne(entryUuid));
    assertCurrent();
    result = await applyGesture(result.project, advancedGestures.deleteStage(rootUuid));
    assertCurrent();
    const documentTitle = view.metadata?.title?.presence === 'value'
      ? String(view.metadata.title.value ?? '').trim() : '';
    const titleIsFallback = !documentTitle || FALLBACK_TITLES.has(fallbackTitleKey(documentTitle));
    if (titleIsFallback) {
      result = await applyGesture(result.project, advancedGestures.setDocumentMetadata({
        title: presence.value(example.title),
      }));
      assertCurrent();
    }
    if (isFallbackProjectName(result.project.projectName)) {
      result = { ...result, project: { ...result.project, projectName: titleIsFallback ? example.title : documentTitle } };
    }
  }
  return {
    project: result.project,
    report: {
      ...result.report,
      example: {
        id: example.id, stages: [...construction.stages], actions: [...construction.actions],
        entryUuid, replacedInitialRoot: rootUuid !== null, anchor: placedAnchor,
      },
    },
  };
}
