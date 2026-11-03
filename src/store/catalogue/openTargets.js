/** Translate a revalidated editor entry without opening files or sessions. */
export function openTarget(entry) {
  if (entry?.kind === 'project' && entry.path) {
    return { kind: 'openProject', path: entry.path };
  }
  if (entry?.kind === 'pack' && entry.path) {
    return { kind: 'openPackFunnel', source: { path: entry.path, packLabel: entry.packLabel, ...(['studioDirectory', 'fsDirectory'].includes(entry.format) ? { kind: 'folder' } : {}) } };
  }
  if (entry?.kind === 'bundleChild' && entry.containerPath && entry.childId) {
    return { kind: 'openBundleChild', source: {
      containerPath: entry.containerPath,
      containerFingerprint: entry.containerFingerprint,
      childId: entry.childId,
      packLabel: entry.packLabel,
    } };
  }
  throw new TypeError('Invalid catalogue editor entry');
}
