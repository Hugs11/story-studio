// Freeze the displayed order and revisions at the click, independent of scans.
export function assemblySelection(selectedIds, visibleCards) {
  const selected = new Set(selectedIds);
  return visibleCards.filter(card => selected.has(card.id)).map(card => ({ ficheId: card.id, expectedFicheRevision: card.ficheRevision }));
}
export function assemblyPacks(preparation) {
  return preparation.entries.map(entry => ({ id: entry.exemplarId, path: entry.zipPath, name: entry.title, fileName: entry.title, coverImage: entry.coverPath || '', ageMin: entry.ageMin ?? null, provenance: entry.provenance, ...(entry.officialOriginUuid ? { officialOriginUuid: entry.officialOriginUuid } : {}), ...(entry.packUuid ? { packUuid: entry.packUuid } : {}), ...(entry.officialProvenance ? { officialProvenance: entry.officialProvenance } : {}) }));
}

export function assemblyAction(count, phase) {
  return { id: 'assemble', labelKey: 'catalogue:selection.inline.assemble', labelParams: { count }, enabled: count > 0 && phase === 'idle', reasonKey: count ? 'catalogue:assembly.preparing' : 'catalogue:data.noTarget' };
}
