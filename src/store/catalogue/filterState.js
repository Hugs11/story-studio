import { FORMAT_ORDER } from './entryModel.js';
import { normalizeFilters, activeFilterSummary, filterErrors, filterOptions } from './filters.js';

export function initialFilterState() { return { query: '', filters: normalizeFilters(), additions: null }; }
export function filterStateReducer(state, action) {
  switch (action.type) {
    case 'restore': return { ...initialFilterState(), ...action.value, filters: normalizeFilters(action.value?.filters) };
    case 'query': return { ...state, query: action.value };
    case 'clearSearch': return { ...state, query: '' };
    // Ce raccourci doit montrer tout l'ensemble annoncé par la pastille.
    case 'showMissing': return { ...state, query: '', filters: normalizeFilters({ missingFilesOnly: true }), additions: null };
    case 'reset': return { ...state, filters: normalizeFilters(), additions: null };
    case 'set': return { ...state, filters: normalizeFilters({ ...state.filters, [action.family]: action.value }) };
    case 'remove':
      if (action.family === 'age') return { ...state, filters: normalizeFilters({ ...state.filters, age: {} }) };
      return action.family === 'additions' ? { ...state, additions: null }
      : { ...state, filters: normalizeFilters({ ...state.filters, [action.family]: normalizeFilters()[action.family] }) };
    case 'additions': return { ...state, additions: action.report ?? [...new Set(action.ids)] };
    default: return state;
  }
}
export function filterSummary(state) {
  const summary = activeFilterSummary(state.filters);
  if (state.additions !== null) summary.push({ family: 'additions', key: 'catalogue:filter.additions.label', params: {} });
  return summary;
}
export const FILTER_DEFINITIONS = Object.freeze([
  { family: 'age', key: 'catalogue:filter.age.label', value: { min: null, max: 5, hideUnknown: false } },
  { family: 'favoritesOnly', key: 'catalogue:filter.favorites.only', value: true, menu: 'toggle' },
  { family: 'incompleteOnly', key: 'catalogue:palette.incomplete', value: true, menu: 'toggle' },
  { family: 'missingFilesOnly', key: 'catalogue:filter.missingFiles.label', value: true, menu: 'toggle' },
  { family: 'hideOfficial', key: 'catalogue:filter.hideOfficial.label', value: true, menu: 'toggle' },
  { family: 'tags', key: 'catalogue:filter.tags.label', value: { ids: [], mode: 'any' }, menu: 'values', reason: 'catalogue:tags.filterEmpty' },
  { family: 'formats', key: 'catalogue:filter.family.format', value: [], menu: 'values' },
  { family: 'languages', key: 'catalogue:filter.family.language', menu: 'values' },
  { family: 'projectTypes', key: 'catalogue:filter.family.projectType' },
  { family: 'sourceIds', key: 'catalogue:filter.family.source', menu: 'values' },
  { family: 'packStates', key: 'catalogue:filter.family.packState' },
  { family: 'missing', key: 'catalogue:filter.family.missing' },
]);
const definition = family => FILTER_DEFINITIONS.find(item => item.family === family);
// Ordres historiques conservés pour les consommateurs hors du menu Filtres.
export const CRITERIA = Object.freeze(['age', 'favoritesOnly', 'tags', 'formats', 'incompleteOnly', 'missingFilesOnly'].map(definition));
export const FAMILY_CONTROLS = Object.freeze(['languages', 'formats', 'projectTypes', 'sourceIds', 'tags', 'packStates', 'missing'].map(definition));
export const FILTER_MENU_TOGGLES = Object.freeze(FILTER_DEFINITIONS.filter(item => item.menu === 'toggle'));
export const FILTER_MENU_VALUES = Object.freeze(FILTER_DEFINITIONS.filter(item => item.menu === 'values'));
/** « Dossier » n'a de sens qu'avec au moins deux dossiers à départager. */
export const filterMenuValues = folderCount => FILTER_MENU_VALUES.filter(item => item.family !== 'sourceIds' || folderCount > 1);
export function filterControls(cards) {
  const options = filterOptions(cards);
  return FAMILY_CONTROLS.map(control => ({ ...control, values: control.family === 'formats' ? [...FORMAT_ORDER] : options[control.family], unavailable: !!control.reason && !options[control.family].length }));
}
export { filterErrors };

// Additions are an explicit temporary override: user criteria stay untouched.
export function effectiveCriteria(state) {
  return state.additions === null ? { query: state.query, filters: state.filters }
    : { query: '', filters: normalizeFilters({ availability: 'all' }) };
}

export function compactTagLabel(ids, tags) {
  const labels = ids.slice(0, 2).map(id => tags.find(tag => tag.id === id)?.label ?? id);
  return labels.join(', ') + (ids.length > 2 ? ` +${ids.length - 2}` : '');
}
