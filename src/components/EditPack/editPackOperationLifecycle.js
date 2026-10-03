/** Garde une seule opération Edit Pack active et invalide ses résultats au démontage. */
export function createEditPackOperationLifecycle() {
  let generation = 0;
  let running = false;
  let completionClaimed = false;
  let active = true;
  let session = 0;

  function begin() {
    if (!active || running) return null;
    running = true;
    completionClaimed = false;
    generation += 1;
    return generation;
  }

  function invalidate() {
    generation += 1;
    running = false;
    completionClaimed = false;
  }

  function activate() {
    if (active) return;
    active = true;
    session += 1;
  }

  function deactivate() {
    active = false;
    session += 1;
    invalidate();
  }

  function captureSession() {
    return active ? session : null;
  }

  function isSessionCurrent(token) {
    return active && token !== null && token === session;
  }

  function isCurrent(token) {
    return running && token === generation;
  }

  function finish(token) {
    if (!isCurrent(token)) return false;
    running = false;
    return true;
  }

  function claimCompletion(token) {
    if (!isCurrent(token) || completionClaimed) return false;
    completionClaimed = true;
    return true;
  }

  function isRunning() {
    return running;
  }

  function isActive() {
    return active;
  }

  return {
    activate,
    begin,
    captureSession,
    claimCompletion,
    deactivate,
    finish,
    invalidate,
    isActive,
    isCurrent,
    isRunning,
    isSessionCurrent,
  };
}

/// Qui répond à « quel éditeur ? » quand un pack convient aux deux. Ouvert
/// depuis le graphe, le parcours a déjà sa réponse : le graphe, sans question.
/// Depuis l'accueil ou l'éditeur par menus, l'auteur choisit.
export function editorChooserFor({ openedFromGraph, askEditor }) {
  return openedFromGraph ? async () => 'advanced' : askEditor;
}

/// Le tronc commun à tous les atterrissages : une fois le ZIP d'un pack connu,
/// la suite ne dépend plus de la manière dont il a été obtenu. Un enfant
/// d'enveloppe et un pack déposé directement passent donc exactement ici.
async function landResolvedPackZip({
  lifecycle,
  token,
  zipPath,
  classify,
  beforeLand,
  land,
  landAdvanced,
  chooseEditor,
  beforeReplace,
}) {
  const report = await classify(zipPath);
  if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };

  let editor = report?.authoringEditable ? 'free' : 'advanced';
  if (report?.authoringEditable && landAdvanced && chooseEditor) {
    editor = await chooseEditor({ report, zipPath });
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    if (editor !== 'free' && editor !== 'advanced') {
      lifecycle.finish(token);
      return { status: 'choice-cancelled', report, zipPath };
    }
  }

  if (editor === 'advanced' && !landAdvanced) {
    lifecycle.finish(token);
    return { status: 'classified', report, zipPath };
  }

  const canReplace = await beforeReplace({ editor, report, zipPath });
  if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
  if (!canReplace) {
    lifecycle.finish(token);
    return { status: 'choice-cancelled', report, zipPath };
  }

  beforeLand(editor);
  if (!lifecycle.claimCompletion(token)) return { status: 'cancelled' };
  try {
    if (editor === 'advanced') await landAdvanced(zipPath);
    else await land(zipPath);
  } catch (error) {
    // Un pack non fidèle au Libre part directement vers le Graphe. Si son
    // acquisition échoue aussi, conserver le verdict et le ZIP permet encore
    // la simulation au lieu de rejeter l'auteur sur la zone de dépôt.
    if (editor === 'advanced' && !report?.authoringEditable && lifecycle.isCurrent(token)) {
      lifecycle.finish(token);
      return { status: 'classified', report, zipPath, advancedError: error };
    }
    throw error;
  }
  if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
  lifecycle.finish(token);
  return { status: 'landed', report, zipPath, advanced: editor === 'advanced' };
}

export async function runEditPackImportOperation({
  lifecycle,
  path,
  isFolder,
  convertFolder,
  classify,
  // Inspection de l'archive : pack direct, ou enveloppe contenant plusieurs
  // packs ? Absente, l'opération se comporte exactement comme avant.
  inspect = null,
  beforeInspect = () => {},
  beforeLand = () => {},
  land,
  landAdvanced = null,
  // Le choix n'est demandé qu'après classification, et seulement quand les
  // deux éditeurs conviennent. Un pack non fidèle au Libre va au Graphe sans
  // étape supplémentaire.
  chooseEditor = null,
  beforeReplace = async () => true,
}) {
  if (!lifecycle.isActive()) return { status: 'cancelled' };
  const token = lifecycle.begin();
  if (token === null) return { status: 'busy' };

  try {
    // Un dossier n'est jamais une enveloppe : il porte un pack ou rien.
    if (isFolder) {
      const zipPath = await convertFolder(path);
      if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
      return await landResolvedPackZip({
        lifecycle, token, zipPath, classify, beforeLand, land, landAdvanced, chooseEditor, beforeReplace,
      });
    }

    if (inspect) {
      beforeInspect();
      const inspection = await inspect(path);
      if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
      if (inspection?.kind === 'bundle') {
        lifecycle.finish(token);
        return { status: 'bundle', containerPath: path, inspection };
      }
    }

    return await landResolvedPackZip({
      lifecycle, token, zipPath: path, classify, beforeLand, land, landAdvanced, chooseEditor, beforeReplace,
    });
  } catch (error) {
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    lifecycle.finish(token);
    return { status: 'error', error };
  }
}

/// L'enfant choisi dans une enveloppe : il est extrait, puis il reprend le
/// parcours d'un pack normal sans le modifier. Classement, choix d'éditeur et
/// garde de remplacement restent donc identiques à ceux d'un pack déposé seul.
export async function runEditPackBundleChildOperation({
  lifecycle,
  containerPath,
  containerFingerprint,
  childId,
  extractChild,
  classify,
  beforeExtract = () => {},
  beforeLand = () => {},
  land,
  landAdvanced = null,
  chooseEditor = null,
  beforeReplace = async () => true,
}) {
  if (!lifecycle.isActive()) return { status: 'cancelled' };
  const token = lifecycle.begin();
  if (token === null) return { status: 'busy' };

  try {
    beforeExtract();
    const zipPath = await extractChild({ containerPath, containerFingerprint, childId });
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    return await landResolvedPackZip({
      lifecycle, token, zipPath, classify, beforeLand, land, landAdvanced, chooseEditor, beforeReplace,
    });
  } catch (error) {
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    lifecycle.finish(token);
    return { status: 'error', error };
  }
}
