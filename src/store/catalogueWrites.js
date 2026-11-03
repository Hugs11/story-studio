// Déclaration des écritures de l'application au catalogue des packs.
//
// La surveillance des sources (côté Rust) doit reconnaître les fichiers que
// l'application écrit elle-même : un enregistrement de projet dans
// `sauvegardes` ne doit provoquer ni nouvelle analyse complète ni bilan. Toute
// écriture est donc déclarée avant sa première mutation, puis close : un succès
// publie aussitôt le fichier écrit, un échec le fait réconcilier.
//
// La déclaration n'empêche jamais l'écriture : si le catalogue est
// indisponible, l'enregistrement se fait quand même et la réconciliation
// suivante rattrape l'index.

async function catalogueInvoke(command, args) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke(command, args);
  } catch {
    return null;
  }
}

/**
 * Exécute `write` en déclarant au catalogue les chemins qu'elle touche.
 * @param {{ kind: string, paths?: string[], temporaries?: string[], subtrees?: string[] }} declaration
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 * @template T
 */
export async function withDeclaredWrite(declaration, write) {
  const operationId = await catalogueInvoke('catalogue_begin_write', {
    kind: declaration.kind,
    paths: (declaration.paths ?? []).filter(Boolean),
    temporaries: (declaration.temporaries ?? []).filter(Boolean),
    subtrees: (declaration.subtrees ?? []).filter(Boolean),
  });
  let succeeded = false;
  try {
    const result = await write();
    succeeded = true;
    return result;
  } finally {
    if (typeof operationId === 'string' && operationId.length > 0) {
      await catalogueInvoke('catalogue_finish_write', { operationId, succeeded });
    }
  }
}
