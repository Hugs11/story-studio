// The engine computes identityLocked; JavaScript only carries its result.
export function normalizeOfficialProvenance(value) {
  return ['official', 'notOfficial'].includes(value) ? value : 'unknown';
}

export async function readPackIdentityLock(uuid, officialProvenance, invoke) {
  return invoke('read_pack_identity_lock', { uuid: String(uuid ?? ''), officialProvenance: normalizeOfficialProvenance(officialProvenance) });
}

// Libre containment is derived from entries, never from the cached project flag.
// Graph copies flatten the entries; their advanced payload retains a persistent flag.
export function containsOfficialContent(value) {
  if (value?.authoringMode === 'advanced') return !!value.containsOfficialContent;
  const entries = [...(value?.rootEntries ?? []), ...(value?.sharedEntries ?? []), ...(value?.children ?? [])];
  const isProject = Array.isArray(value?.rootEntries);
  return (!isProject && (value?.officialProvenance === 'official' || !!value?.containsOfficialContent))
    || entries.some(containsOfficialContent);
}

export function entryOfficialIdentityFields(value) {
  return {
    ...officialIdentityFields(value),
    ...(value?.officialProvenance ? { officialProvenance: normalizeOfficialProvenance(value.officialProvenance) } : {}),
  };
}

export function officialIdentityFields(value) {
  return {
    ...(value?.officialOriginUuid ? { officialOriginUuid: String(value.officialOriginUuid) } : {}),
    ...(value?.containsOfficialContent ? { containsOfficialContent: true } : {}),
  };
}
