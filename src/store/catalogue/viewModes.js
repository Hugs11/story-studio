// Les deux vues du catalogue, alimentées par le même résultat du pipeline.

export const VIEW_MODES = Object.freeze([
  { id: 'cards', labelKey: 'catalogue:toolbar.view.cards' },
  { id: 'list', labelKey: 'catalogue:toolbar.view.list' },
]);

export const DEFAULT_VIEW = 'cards';

export function normalizeView(view) {
  if (view === 'details') return 'list';
  return VIEW_MODES.some((mode) => mode.id === view) ? view : DEFAULT_VIEW;
}

/** Libellés des tris proposés (clé de tri → clé de traduction). */
export const SORT_LABELS = Object.freeze({
  title: 'catalogue:toolbar.sort.title',
  addedAt: 'catalogue:toolbar.sort.addedAt',
  modifiedAt: 'catalogue:toolbar.sort.modifiedAt',
  age: 'catalogue:toolbar.sort.age',
  duration: 'catalogue:toolbar.sort.duration',
  size: 'catalogue:toolbar.sort.size',
  format: 'catalogue:toolbar.sort.format',
  stories: 'catalogue:toolbar.sort.stories',
  language: 'catalogue:toolbar.sort.language',
  author: 'catalogue:toolbar.sort.author',
  producer: 'catalogue:toolbar.sort.producer',
});

/** Identifiant DOM sûr dérivé d'un identifiant de fiche ou d'exemplaire. */
export function domId(prefix, id) {
  return `${prefix}-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
