// Identity comes from Rust: two differently spelled paths can be one source.
// `after` is the source list reloaded after the addition, when known: a folder
// added inside an active source is explained (its packs are not counted twice).
export function sourceAddResult(items, outcome, after = null, expectedSourcesRevision = null) {
  // Rust leaves the revision unchanged for a duplicate, even if its row is hidden.
  const alreadyActive = (expectedSourcesRevision !== null && outcome.sourcesRevision === expectedSourcesRevision)
    || items.some((item) => item.id === outcome.sourceId && item.status === 'active');
  if (alreadyActive) return { alreadyActive, notice: { key: 'catalogue:sources.duplicate.message', params: {} } };
  const added = after?.find((item) => item.id === outcome.sourceId);
  const parent = added?.includedIn ? after.find((item) => item.id === added.includedIn) : null;
  if (parent) return { alreadyActive, notice: { key: 'catalogue:sources.nested.message', params: { path: parent.path } } };
  return { alreadyActive, notice: { key: 'catalogue:sources.added.message', params: {} } };
}

const lastSegments = (path) => String(path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);

/**
 * Dossiers proposés par le filtre « Dossier » : les sources actives listées par
 * « Gérer les dossiers », y compris les sources techniques non vides. Libellé = dernier
 * segment du chemin, casse respectée ; deux dossiers de même nom reçoivent le
 * dossier parent (« parent/nom »). Le chemin complet sert d'infobulle.
 */
export function sourceFolderOptions(sources = []) {
  const active = sources.filter((source) => source.status === 'active');
  const entries = active.map((source) => {
    const segments = lastSegments(source.path);
    return { id: source.id, path: source.path, segments, name: segments.at(-1) ?? source.path };
  });
  return entries.map(({ id, path, segments, name }) => {
    const clash = entries.filter((other) => other.name === name).length > 1;
    return { id, path, label: clash && segments.length > 1 ? `${segments.at(-2)}/${name}` : name };
  });
}
