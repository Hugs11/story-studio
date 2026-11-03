import { browseSession } from '../store/catalogue/browseSession.js';
import { useState } from 'react';
import { readViewPrefs, writeViewPrefs } from '../store/catalogue/viewPrefs.js';
import { naturalDirection, normalizeSort } from '../store/catalogue/sort.js';
import { normalizeView } from '../store/catalogue/viewModes.js';
import { normalizeCardDensity } from '../store/catalogue/windowing.js';
export function useCatalogueViewPrefs() {
  const [prefs, setPrefs] = useState(() => {
    const prefs = readViewPrefs();
    const saved = browseSession.restore();
    return saved ? { ...prefs, view: normalizeView(saved.view) } : prefs;
  });
  const update = change => setPrefs(current => {
    const next = { ...current, ...change };
    writeViewPrefs(next);
    return next;
  });
  return { ...prefs, setDensity: density => update({ density: normalizeCardDensity(density) }), toggleFichePanel: () => update({ fichePanelVisible: !prefs.fichePanelVisible }), setView: view => update({ view: normalizeView(view) }),
    setSortKey: key => update({ sort: normalizeSort({ key, direction: naturalDirection(key) }) }),
    toggleDirection: () => update({ sort: { ...prefs.sort, direction: prefs.sort.direction === 'asc' ? 'desc' : 'asc' } }) };
}
