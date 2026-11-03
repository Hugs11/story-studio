import { KEYS, read, write } from '../persistentSettings.js';
import { DEFAULT_SORT, SORT_KEYS, normalizeSort } from './sort.js';
import { normalizeView } from './viewModes.js';
import { normalizeCardDensity } from './windowing.js';

// Only these view preferences cross an application restart. Criteria belong to
// the in-memory consultation session, never to persistentSettings.
export function readViewPrefs(settings = { read }) {
  const view = normalizeView(settings.read(KEYS.CATALOGUE_VIEW));
  let sort;
  try { sort = JSON.parse(settings.read(KEYS.CATALOGUE_SORT)); } catch { sort = null; }
  return { view, density: normalizeCardDensity(settings.read(KEYS.CATALOGUE_CARD_DENSITY)), fichePanelVisible: settings.read(KEYS.CATALOGUE_FICHE_PANEL_VISIBLE) !== 'false', sort: normalizeSort(sort && SORT_KEYS.includes(sort.key) && ['asc','desc'].includes(sort.direction) ? sort : DEFAULT_SORT) };
}
export function writeViewPrefs(prefs, settings = { write }) {
  const view = settings.write(KEYS.CATALOGUE_VIEW, normalizeView(prefs.view));
  const sort = settings.write(KEYS.CATALOGUE_SORT, JSON.stringify(normalizeSort(prefs.sort)));
  const panel = settings.write(KEYS.CATALOGUE_FICHE_PANEL_VISIBLE, String(prefs.fichePanelVisible !== false));
  const density = settings.write(KEYS.CATALOGUE_CARD_DENSITY, normalizeCardDensity(prefs.density));
  return view && sort && panel && density;
}
