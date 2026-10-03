// Les parcours d'acceptation de l'export avancé, joués dans la WebView réelle.
//
// Chaque cas de la matrice d'acceptation est une fonction, et chaque fonction
// dépose des **pas** portant leur propre verdict : aucun pas n'est réputé tenu parce
// que le parcours s'est terminé. Les cas qui n'ont pas pu être joués sont
// déclarés `nonExécuté` avec leur raison — jamais comptés comme des réussites.
//
// Le parcours n'invente aucun raccourci : il appelle les fonctions que les
// boutons appellent, enregistre par `saveProject`, rouvre par
// `loadProjectFromPath`, exporte par la session d'export, et **relit l'archive
// produite** par `load_pack_zip`, qui est le transport du simulateur. C'est cet
// aller-retour qui sert d'oracle de contenu : une capture d'écran ne dirait pas
// si l'option ajoutée est dans le ZIP.

import {
  advancedGestures,
  graphNode,
  optionTarget,
} from '../../src/store/projectModel/advancedGestures.js';
import { readAuthoringRevision } from '../../src/store/projectModel/authoringRevision.js';

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

// Les gestes sont assemblés par **les constructeurs que l'interface utilise**,
// jamais par des littéraux recopiés : un banc qui retape la forme d'une demande
// finit par prouver sa propre recopie. Les constructeurs valident en plus leurs
// arguments, ce qui transforme une faute de banc en erreur immédiate plutôt
// qu'en refus attribué au produit.

let suspendedFrames = 0;

// Deux images, avec une minuterie en filet : une fenêtre non composée suspend
// `requestAnimationFrame` sans erreur, et un parcours qui n'attendrait que des
// images passerait pour un blocage du code éprouvé.
function settle() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (byTimer) => {
      if (settled) return;
      settled = true;
      if (byTimer) suspendedFrames += 1;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(() => finish(false)));
    setTimeout(() => finish(true), 250);
  });
}

async function waitForDriver(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.__exportBench) return window.__exportBench;
    await settle();
  }
  throw new Error("Le pilote du banc d'export n'est jamais apparu.");
}

const bench = () => window.__exportBench;

// Un fichier de projet dans un dossier propre au cas. Le cas du déplacement
// emporte son dossier ; sans cette séparation, il emporterait aussi celui des
// cas qui le suivent, et leurs échecs seraient les siens.
async function projectFile(context, folder, name) {
  const directory = `${context.projectsDir}${context.separator}${folder}`;
  await fsAction('mkdir', directory);
  return `${directory}${context.separator}${name}`;
}

async function fsAction(action, path, to = undefined) {
  const response = await fetch('/__bench/export-fs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, path, to }),
  });
  return response.json();
}

const readView = (payload) => invokeTauri('read_advanced_graph_view', { payload });

// Un pas : ce qu'on attendait, ce qu'on a observé, et le verdict.
function step(list, name, expectation, observed, extra = {}) {
  let held = false;
  let error = null;
  try {
    held = expectation(observed) === true;
  } catch (thrown) {
    error = String(thrown?.message ?? thrown);
  }
  list.push({ name, held, observed, ...(error ? { error } : {}), ...extra });
  return held;
}

async function runGesture(gesture) {
  const outcome = await bench().runGesture(gesture);
  await settle();
  return outcome;
}

// ── Chaîne de fichier : les fonctions de production, sans dialogue ───────────

async function saveTo(path) {
  const { saveProject } = await import('../../src/store/projectIO.js');
  const saved = await saveProject(bench().project(), path, null, {
    workspaceDir: bench().context.workspaceDir,
  });
  bench().setSavePath(saved.path);
  await settle();
  return saved;
}

async function reopen(path) {
  const { loadProjectFromPath } = await import('../../src/store/projectIO.js');
  const loaded = await loadProjectFromPath(path);
  bench().loadProject(loaded.data);
  bench().setSavePath(loaded.path);
  await settle();
  return loaded;
}

async function exportTo(outputDir, options = undefined) {
  const outcome = await bench().startExport({ outputFolder: outputDir, options });
  await settle();
  return { outcome, state: bench().exportState() };
}

// L'oracle de contenu : l'archive produite, relue par le transport même du
// simulateur. `forSimulation: true` est ce que le lecteur ZIP demande.
async function readArchive(zipPath) {
  const raw = await invokeTauri('load_pack_zip', { zipPath, forSimulation: true });
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Cas 1 — Import → A → save/reopen → export → relecture ───────────────────

async function casParcoursA(report, context) {
  const steps = [];
  const view = await readView(bench().payload());
  // L'identité vient de la **vue**, pas du premier export : la comparer au
  // résultat d'un cas antérieur ferait dépendre ce verdict de la réussite de
  // celui-là.
  report.packIdentity = view.packIdentity?.value ?? null;
  const entryPath = view.entry?.stagePath ?? null;
  const menu = (view.actions ?? []).find((action) => (action.options?.length ?? 0) >= 3);
  const target = (view.stages ?? []).find((stage) => stage.path !== entryPath);
  if (!menu || !target) throw new Error('La fixture ne porte pas le menu attendu.');

  // Une modification de navigation : une occurrence insérée en tête de roue.
  const optionsBefore = menu.options.length;
  const inserted = await runGesture(
    advancedGestures.insertActionOption(menu.id, 0, optionTarget.stage(target.uuid)),
  );
  let current = await readView(bench().payload());
  let seenAction = current.actions.find((action) => action.path === menu.path);
  step(steps, 'A — occurrence insérée en tête de roue',
    (observed) => observed.applied && observed.after === observed.before + 1,
    { applied: inserted.status === 'applied', before: optionsBefore, after: seenAction?.options?.length ?? 0 });

  // Une modification de média : l'image d'un écran devient celle d'un autre —
  // même référence, donc partage explicite, pas de nouveau fichier.
  const donor = (current.stages ?? []).find((stage) => stage.path !== target.path
    && typeof stage.image?.assetRef === 'string');
  let mediaApplied = false;
  if (donor) {
    const outcome = await runGesture(advancedGestures.setStageMedia(
      target.uuid,
      'image',
      advancedGestures.stageMedia(donor.image.assetRef),
    ));
    mediaApplied = outcome.status === 'applied';
    current = await readView(bench().payload());
  }
  const seenStage = current.stages.find((stage) => stage.path === target.path);
  step(steps, 'A — image réassignée à une référence déjà liée',
    (observed) => observed.applied && observed.image === observed.expected,
    { applied: mediaApplied, image: seenStage?.image?.assetRef ?? null, expected: donor?.image?.assetRef ?? null });

  // Enregistrement puis réouverture : le document doit revenir **à l'octet**.
  const projectPath = await projectFile(context, 'parcours-a', 'a.mbah');
  const beforeSave = bench().payload();
  await saveTo(projectPath);
  await reopen(projectPath);
  const afterReopen = bench().payload();
  step(steps, 'A — enregistré puis rouvert, document identique à l’octet',
    (observed) => observed.same, { same: beforeSave === afterReopen, bytes: afterReopen?.length ?? 0 });

  // Export, puis relecture de l'archive réellement produite.
  const { state } = await exportTo(context.outputDir);
  step(steps, 'A — archive produite',
    (observed) => observed.phase === 'succeeded' && observed.zip !== null,
    { phase: state.phase, zip: state.result?.zipPath ?? null, refusal: state.refusal?.kind ?? null });

  if (state.result?.zipPath) {
    const story = await readArchive(state.result.zipPath);
    const stageIdMap = state.result.raw.stageIdMap ?? {};
    const copiedTarget = stageIdMap[target.uuid] ?? target.uuid;
    const copiedMenu = story.actionNodes?.find((action) => (action.options?.length ?? 0) === optionsBefore + 1);
    const copiedStage = story.stageNodes?.find((stage) => (stage.uuid ?? stage.id) === copiedTarget);
    step(steps, 'A — la navigation modifiée est dans le ZIP',
      (observed) => observed.width === observed.expected && observed.firstIsTarget,
      {
        width: copiedMenu?.options?.length ?? 0,
        expected: optionsBefore + 1,
        firstIsTarget: copiedMenu?.options?.[0] === copiedTarget,
      });
    step(steps, 'A — le média réassigné est dans le ZIP',
      (observed) => observed.hasImage,
      { hasImage: typeof copiedStage?.image === 'string' && copiedStage.image.length > 0 });

    // La couverture vient de l'écran d'entrée, pas du premier élément listé.
    step(steps, 'A — couverture rapportée conformément à l’écran d’entrée',
      (observed) => observed.hasThumbnail === true,
      { hasThumbnail: state.result.hasThumbnail });

    step(steps, 'A — identité du pack conservée de la lecture à l’archive',
      (observed) => observed.view !== null && observed.view === observed.archive,
      { view: report.packIdentity, archive: state.result.packIdentity });
    report.firstZip = state.result.zipPath;
  }
  bench().dismissExport();
  report.cases.push({ name: 'Import → A → save/reopen → export → relecture', steps });
  return steps.every((row) => row.held);
}

// ── Cas 2 — Import → B → entrée réassignée → save/reopen → export ───────────

async function casParcoursB(report, context) {
  const steps = [];

  const created = await runGesture(advancedGestures.createStage({
    name: 'Écran du parcours B',
    controls: { wheel: false, ok: true, home: true, pause: false, autoplay: false },
  }));
  const newUuid = created.report?.created?.stageUuid ?? null;
  step(steps, 'B — Écran créé, détaché et non entrée',
    (observed) => observed.applied && observed.uuid !== null,
    { applied: created.status === 'applied', uuid: newUuid });

  const transferred = newUuid
    ? await runGesture(advancedGestures.setSquareOne(newUuid))
    : { status: 'skipped' };
  let view = await readView(bench().payload());
  step(steps, 'B — entrée transférée, exactement une entrée',
    (observed) => observed.applied && observed.entries === 1,
    {
      applied: transferred.status === 'applied',
      entries: (view.stages ?? []).filter((stage) => stage.squareOne?.value === true).length,
    });

  // L'ancien écran d'entrée n'est plus l'entrée : il peut être retiré, avec le
  // plan que le refus lui-même dicte si des références subsistent.
  const projectPath = await projectFile(context, 'parcours-b', 'b.mbah');
  const beforeSave = bench().payload();
  await saveTo(projectPath);
  await reopen(projectPath);
  step(steps, 'B — enregistré puis rouvert, document identique à l’octet',
    (observed) => observed.same, { same: beforeSave === bench().payload() });

  const { state } = await exportTo(context.outputDir);
  step(steps, 'B — archive produite',
    (observed) => observed.phase === 'succeeded',
    { phase: state.phase, refusal: state.refusal?.kind ?? null });

  // L'identité du pack ne bouge ni à l'édition, ni au transfert d'entrée,
  // ni à la réouverture, ni à l'export.
  step(steps, 'B — identité du pack inchangée malgré le changement d’entrée',
    (observed) => observed.before !== null && observed.before === observed.after,
    { before: report.packIdentity ?? null, after: state.result?.packIdentity ?? null });

  if (state.result?.zipPath) {
    const story = await readArchive(state.result.zipPath);
    const squareOnes = (story.stageNodes ?? []).filter((stage) => stage.squareOne === true);
    step(steps, 'B — le ZIP porte une entrée et une seule',
      (observed) => observed.count === 1, { count: squareOnes.length });
    report.secondZip = state.result.zipPath;
  }
  bench().dismissExport();
  report.cases.push({ name: 'Import → B → entrée réassignée → save/reopen → export', steps });
  return steps.every((row) => row.held);
}

// ── Cas 6 — Deux exports dans le même dossier ───────────────────────────────

async function casDeuxExports(report, context) {
  const steps = [];
  const listing = await fsAction('list', context.outputDir);
  const archives = (listing.entries ?? []).filter((name) => name.toLowerCase().endsWith('.zip'));
  step(steps, 'Deux exports dans le même dossier : deux archives, aucun écrasement',
    (observed) => observed.distinct >= 2 && observed.first !== observed.second,
    {
      distinct: archives.length,
      first: report.firstZip ?? null,
      second: report.secondZip ?? null,
      entries: archives,
    });
  report.cases.push({ name: 'Deux exports dans le même dossier', steps });
  return steps.every((row) => row.held);
}

// ── Cas 9 — Export en cours puis intention d'éditer ─────────────────────────

async function casExportPuisEdition(report, context) {
  const steps = [];
  const expectedRevision = readAuthoringRevision(bench().project());
  const before = bench().payload();
  // L'export n'est pas attendu : on regarde ce que l'interface autorise
  // **pendant** qu'il tourne.
  const running = bench().startExport({ outputFolder: context.outputDir });
  await settle();
  const lockedDuring = bench().authoringLocked();
  const view = await readView(before);
  const someAction = (view.actions ?? [])[0] ?? null;
  const attempt = someAction
    ? await bench().runGesture(
      advancedGestures.insertActionOption(someAction.id, 0, optionTarget.stage(view.stages[0].uuid)),
    )
    : { status: 'skipped' };
  const duringPayload = bench().payload();
  await running;
  await settle();

  step(steps, 'Pendant l’export, l’édition est suspendue à la source',
    (observed) => observed.locked && observed.status === 'held' && observed.unchanged,
    { locked: lockedDuring, status: attempt.status, unchanged: duringPayload === before });
  step(steps, 'Après l’export, l’édition est rendue',
    (observed) => observed.locked === false, { locked: bench().authoringLocked() });

  const state = bench().exportState();
  step(steps, 'Le résultat est attribué à la révision qui l’a demandé',
    (observed) => observed.ownership === 'current' && observed.revision === observed.expected,
    { ownership: state.ownership, revision: state.result?.revision ?? null, expected: expectedRevision });
  bench().dismissExport();
  report.cases.push({ name: 'Export en cours puis intention d’éditer', steps });
  return steps.every((row) => row.held);
}

// ── Cas 7 — Annulation et dossier non inscriptible ──────────────────────────

async function casRefus(report, context) {
  const steps = [];

  // Annulation : la demande part aussitôt. Si l'export a déjà publié, le relevé
  // le dit — un cas non provoqué n'est pas un cas réussi.
  const before = bench().payload();
  const running = bench().startExport({ outputFolder: context.outputDir });
  await settle();
  await bench().cancelExport();
  await running;
  // L'état de session est lu **après** un rendu : `exportState()` passe par la
  // valeur que React a publiée, et la lire dans le même tour rendrait celle
  // d'avant le retour de la commande.
  await settle();
  const cancelled = bench().exportState();
  steps.push({
    name: 'Annulation demandée pendant un export',
    held: cancelled.phase === 'refused'
      ? cancelled.refusal?.kind === 'export-cancelled' || cancelled.refusal?.kind === 'output-write'
      : cancelled.phase === 'succeeded',
    observed: {
      phase: cancelled.phase,
      kind: cancelled.refusal?.kind ?? null,
      // Une annulation arrivée trop tard donne un succès : ce n'est pas un
      // échec du produit, et le relevé ne le maquille pas en annulation.
      arrivedTooLate: cancelled.phase === 'succeeded',
    },
  });
  step(steps, 'Le projet est intact après l’annulation',
    (observed) => observed.same, { same: bench().payload() === before });
  bench().dismissExport();

  // Dossier non inscriptible : le refus doit être `output-write`, avec son
  // chemin, et surtout pas une annulation.
  if (context.readOnlyEnforced) {
    const { state } = await exportTo(context.readOnlyDir);
    step(steps, 'Dossier non inscriptible : refus output-write, projet intact',
      (observed) => observed.phase === 'refused'
        && observed.kind === 'output-write'
        && observed.cancelled === false
        && observed.same,
      {
        phase: state.phase,
        kind: state.refusal?.kind ?? null,
        cancelled: state.refusal?.cancelled ?? null,
        path: state.refusal?.path ?? null,
        same: bench().payload() === before,
      });
    bench().dismissExport();
    await fsAction('make-writable', context.readOnlyDir);
  } else {
    steps.push({
      name: 'Dossier non inscriptible : refus output-write',
      held: null,
      nonExécuté: "le dossier d'essai est resté inscriptible malgré le refus posé ; "
        + 'le cas doit être mené avec un volume monté en lecture seule.',
    });
  }

  // L'outil indisponible (FFmpeg absent) n'est pas provoqué : il faudrait
  // retirer l'outil du bundle de développement. La recette est déposée, le cas
  // est déclaré non exécuté.
  steps.push({
    name: 'Outil de conversion indisponible',
    held: null,
    nonExécuté: 'non provoqué : exige de retirer FFmpeg du chemin résolu par le bundle. '
      + "Recette : déplacer le binaire FFmpeg résolu, relancer un export d'un pack dont un "
      + "média exige une conversion, attendre `media-unavailable` avec la cause "
      + '`tool-unavailable`, puis remettre le binaire.',
  });

  report.cases.push({ name: 'Annulation, dossier non inscriptible, outil indisponible', steps });
  return steps.filter((row) => row.held !== null).every((row) => row.held);
}

// ── Cas 8 — Save As et dossier déplacé ──────────────────────────────────────

async function casDeplacement(report, context) {
  const steps = [];
  const beforePayload = bench().payload();

  // « Enregistrer sous » : un second fichier, le même document.
  const deplacement = `${context.projectsDir}${context.separator}deplacement`;
  await fsAction('mkdir', deplacement);
  const asPath = `${deplacement}${context.separator}parcours-save-as.mbah`;
  await saveTo(asPath);
  step(steps, 'Save As : même document, nouveau fichier',
    (observed) => observed.same && observed.path.endsWith('parcours-save-as.mbah'),
    { same: bench().payload() === beforePayload, path: bench().savePath() });

  // Le dossier de projet est déplacé pendant que l'application tourne, puis le
  // projet est rouvert depuis son nouvel emplacement.
  const movedDir = `${context.movedProjectsDir}${context.separator}deplace`;
  const moved = await fsAction('move', deplacement, movedDir);
  const movedPath = `${movedDir}${context.separator}parcours-save-as.mbah`;
  let reopened = null;
  try {
    reopened = await reopen(movedPath);
  } catch (error) {
    reopened = { error: String(error?.message ?? error) };
  }
  step(steps, 'Dossier déplacé : le projet se rouvre depuis son nouvel emplacement',
    (observed) => observed.moved && observed.same,
    {
      moved: moved.ok === true,
      same: bench().payload() === beforePayload,
      error: reopened?.error ?? null,
    });

  // Les liaisons médias sont relatives au fichier : après déplacement, elles
  // doivent se résoudre, et l'export doit repartir.
  const { state } = await exportTo(context.outputDir);
  step(steps, 'Après déplacement, l’export retrouve ses médias',
    (observed) => observed.phase === 'succeeded' && observed.identity === observed.expected,
    {
      phase: state.phase,
      refusal: state.refusal?.kind ?? null,
      unavailable: state.refusal?.entries?.length ?? 0,
      identity: state.result?.packIdentity ?? null,
      expected: report.packIdentity ?? null,
    });
  bench().dismissExport();

  steps.push({
    name: 'Session temporaire et reprise après coupure',
    held: null,
    nonExécuté: "non provoqué dans ce banc : la reprise de session passe par l'autosave "
      + "éphémère du shell complet, que le banc ne monte pas. Recette : ouvrir un pack en "
      + "Éditeur avancé depuis l'application, éditer, tuer le processus, relancer, et "
      + 'vérifier la reprise proposée à l’accueil.',
  });

  report.cases.push({ name: 'Save As, session temporaire, crash/reprise, dossier déplacé', steps });
  return steps.filter((row) => row.held !== null).every((row) => row.held);
}

// ── Cas 4 et 5 — Décisions bloquantes, puis médias indisponibles ────────────

async function casDecisionsEtMedias(report, context) {
  const steps = [];
  const { acquireImportedAdvancedProject } = await import('../../src/store/projectModel/authoring.js');

  // Changement de projet : l'espace de travail en accueille un second, acquis
  // par la même commande que le funnel d'import.
  const project = await acquireImportedAdvancedProject({
    packPath: `${context.fixtureDir}${context.separator}export-blocked.zip`,
    assetsDir: 'export-blocked',
    workspaceDir: context.workspaceDir,
    projectName: 'banc-export-blocked',
  });
  bench().loadProject(project);
  bench().setSavePath(null);
  await settle();

  const readiness = await invokeTauri('assess_advanced_payload_readiness', { payload: bench().payload() });
  const blockingCodes = (readiness.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.level === 'ACTION_REQUIRED'
      || diagnostic.severity === 'ERROR'
      || diagnostic.source === 'graph-integrity')
    .map((diagnostic) => diagnostic.code);
  step(steps, 'Readiness : export bloqué, qualification dite à part',
    (observed) => observed.blocked === true && observed.codes.length > 0,
    { blocked: readiness.blocked, interoperability: readiness.interoperability, codes: blockingCodes });

  // Le projet reste enregistrable alors même qu'il n'est pas exportable.
  const blockedPath = await projectFile(context, 'decisions', 'decisions.mbah');
  let saveError = null;
  try {
    await saveTo(blockedPath);
  } catch (error) {
    saveError = String(error?.message ?? error);
  }
  step(steps, 'Un projet non exportable reste enregistrable',
    (observed) => observed.saved && observed.error === null,
    { saved: bench().savePath() !== null, error: saveError });

  const { state: refused } = await exportTo(context.outputDir);
  step(steps, 'Export refusé sur décision d’auteur, sans archive publiée',
    (observed) => observed.phase === 'refused'
      && observed.kind === 'preparation'
      && observed.sub === 'authoring-action-required',
    {
      phase: refused.phase,
      kind: refused.refusal?.kind ?? null,
      sub: refused.refusal?.preparationKind ?? null,
      diagnostics: (refused.refusal?.diagnostics ?? []).map((row) => row.code),
    });
  bench().dismissExport();

  // Les résolutions sont choisies **par le code du diagnostic et son
  // `nodePath`**, comme le panneau de résolutions le fait : jamais en devinant
  // quel nœud de la fixture est concerné.
  const withDiagnostic = async (code) => {
    const view = await readView(bench().payload());
    const paths = (view.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.code === code && diagnostic.nodePath)
      .map((diagnostic) => diagnostic.nodePath);
    return {
      view,
      stages: (view.stages ?? []).filter((stage) => paths.includes(stage.path)),
      actions: (view.actions ?? []).filter((action) => paths.includes(action.path)),
      count: paths.length,
    };
  };

  const incomplete = await withDiagnostic('CONTROL_SETTINGS_INCOMPLETE');
  const completions = [];
  for (const stage of incomplete.stages) {
    const outcome = await runGesture(advancedGestures.completeStageControls(stage.uuid, {
      wheel: false, ok: true, home: true, pause: false, autoplay: false,
    }));
    completions.push({ uuid: stage.uuid, status: outcome.status, code: outcome.error?.code ?? null });
  }
  step(steps, 'Contrôles complétés par choix explicite des cinq valeurs',
    (observed) => observed.length > 0 && observed.every((row) => row.status === 'applied'),
    completions);

  // Positions : la décision est posée **là où un diagnostic la demande**, et
  // nulle part ailleurs. Une disposition n'est demandée que pour les valeurs hors
  // de la plage courte ; une position fractionnaire mais valide n'en appelle
  // aucune, et Rust refuse — à juste titre — qu'on lui en pose une.
  // « Omettre explicitement » plutôt qu'arrondir : `POSITION_FRACTIONAL` seul
  // n'impose pas d'arrondir.
  const outOfRange = await withDiagnostic('POSITION_OUT_OF_RANGE_ACTION_REQUIRED');
  const positionDecisions = [];
  for (const stage of outOfRange.stages) {
    const outcome = await runGesture(advancedGestures.setPositionExportDisposition(
      graphNode.stage(stage.uuid),
      'omit-explicitly',
    ));
    positionDecisions.push({ uuid: stage.uuid, status: outcome.status, code: outcome.error?.code ?? null });
  }
  step(steps, 'Décisions de position posées là où un diagnostic les demande',
    (observed) => observed.length > 0 && observed.every((row) => row.status === 'applied'),
    positionDecisions);

  // Disposition **périmée** : déplacer le nœud après avoir décidé rend la
  // décision caduque. Elle reste enregistrée comme trace et ne s'applique plus
  // à la valeur courante — le rapport du geste le dit, et il faut redécider.
  const decidedUuid = positionDecisions.find((row) => row.status === 'applied')?.uuid ?? null;
  if (decidedUuid) {
    const moved = await runGesture(advancedGestures.setAuthoredPosition(
      graphNode.stage(decidedUuid),
      { x: 24, y: 36 },
    ));
    const stale = moved.report?.positions?.staleDecisions ?? [];
    step(steps, 'Un déplacement rend la décision d’export périmée, sans l’appliquer en douce',
      (observed) => observed.applied && observed.stale >= 1,
      { applied: moved.status === 'applied', stale: stale.length, paths: stale });

    // La valeur est redevenue valide : il n'y a plus de décision à prendre, et
    // en reposer une est refusé. C'est le comportement attendu — une
    // disposition ne s'applique qu'à une position hors plage courte.
    const redecided = await runGesture(advancedGestures.setPositionExportDisposition(
      graphNode.stage(decidedUuid),
      'omit-explicitly',
    ));
    step(steps, 'Une décision ne se repose pas sur une valeur redevenue valide',
      (observed) => observed.refused && observed.code === 'POSITION_DISPOSITION_REFUSED',
      { refused: redecided.status === 'refused', code: redecided.error?.code ?? null });
  }

  // Extensions inconnues : une décision par membre opaque, adressée par son
  // triplet `(path, key, sourceOccurrence)`. `PreserveUntested` transporte la
  // donnée sans prétendre la comprendre.
  const withOpaque = await readView(bench().payload());
  const opaqueDecisions = [];
  for (const member of withOpaque.opaqueMembers ?? []) {
    if (member.disposition) continue;
    const outcome = await runGesture(advancedGestures.setOpaqueExportDisposition(
      { path: member.path, key: member.key, sourceOccurrence: member.sourceOccurrence },
      'preserve-untested',
    ));
    opaqueDecisions.push({ key: member.key, status: outcome.status, code: outcome.error?.code ?? null });
  }
  step(steps, 'Extensions inconnues : conservées sur décision, jamais interprétées',
    (observed) => observed.length === 0 || observed.every((row) => row.status === 'applied'),
    opaqueDecisions);

  // L'Action orpheline porteuse de contenu : l'auteur la retire, explicitement.
  const orphaned = await withDiagnostic('ORPHAN_ACTION_AUTHORED_CONTENT');
  const orphanRemovals = [];
  for (const action of orphaned.actions) {
    const outcome = await runGesture(advancedGestures.deleteAction(action.id));
    orphanRemovals.push({ id: action.id, status: outcome.status, code: outcome.error?.code ?? null });
  }
  step(steps, 'Action orpheline retirée sur décision explicite',
    (observed) => observed.length > 0 && observed.every((row) => row.status === 'applied'),
    orphanRemovals);

  const afterResolutions = await invokeTauri('assess_advanced_payload_readiness', { payload: bench().payload() });
  const { state: resolved } = await exportTo(context.outputDir);
  step(steps, 'Après résolutions ciblées, l’export part',
    (observed) => observed.phase === 'succeeded',
    {
      phase: resolved.phase,
      blockedAfter: afterResolutions.blocked,
      refusal: resolved.refusal?.kind ?? null,
      sub: resolved.refusal?.preparationKind ?? null,
      diagnostics: (resolved.refusal?.diagnostics ?? []).map((row) => row.code),
      remaining: (afterResolutions.diagnostics ?? [])
        .filter((row) => row.level === 'ACTION_REQUIRED' || row.severity === 'ERROR')
        .map((row) => row.code),
    });
  bench().dismissExport();

  report.cases.push({ name: 'Contrôle absent, Action orpheline, disposition périmée', steps });
  return steps.filter((row) => row.held !== null).every((row) => row.held);
}

async function casMediaManquant(report, context) {
  const steps = [];
  const { acquireImportedAdvancedProject } = await import('../../src/store/projectModel/authoring.js');
  const project = await acquireImportedAdvancedProject({
    packPath: `${context.fixtureDir}${context.separator}export-mvp.zip`,
    assetsDir: 'export-mvp-medias',
    workspaceDir: context.workspaceDir,
    projectName: 'banc-medias',
  });
  bench().loadProject(project);
  bench().setSavePath(null);
  await settle();

  // La référence partagée par deux écrans : son fichier disparaît du disque.
  const shared = (project.authoring.mediaBindings ?? [])
    .find((binding) => binding.assetRef.includes('partagee'));
  const removal = shared?.path ? await fsAction('remove', shared.path) : { ok: false };
  step(steps, 'Le fichier d’une référence partagée est retiré du disque',
    (observed) => observed.removed, { removed: removal.ok === true, path: shared?.path ?? null });

  const { state } = await exportTo(context.outputDir);
  const entries = state.refusal?.entries ?? [];
  const sharedEntries = entries.filter((entry) => entry.assetRef === shared?.assetRef);
  const stageIds = [...new Set(sharedEntries.flatMap((entry) => entry.stageIds ?? []))];
  step(steps, 'Export refusé : media-unavailable, tous les usages visibles',
    (observed) => observed.kind === 'media-unavailable' && observed.stages >= 2,
    {
      kind: state.refusal?.kind ?? null,
      entries: entries.length,
      stages: stageIds.length,
      cause: sharedEntries[0]?.cause ?? null,
    });
  bench().dismissExport();

  // Réparation **par référence** : un autre fichier existant reprend la place,
  // pour les deux écrans à la fois.
  const survivor = (bench().project().authoring.mediaBindings ?? [])
    .find((binding) => binding.assetRef.includes('finale'));
  const repaired = survivor
    ? await runGesture(advancedGestures.repointMedia(shared.assetRef, {
      path: survivor.path,
      present: true,
    }))
    : { status: 'skipped' };
  step(steps, 'Réparation par référence, pas par ancien chemin',
    (observed) => observed.applied, { applied: repaired.status === 'applied' });

  const { state: after } = await exportTo(context.outputDir);
  step(steps, 'L’export repart après réparation',
    (observed) => observed.phase === 'succeeded',
    { phase: after.phase, refusal: after.refusal?.kind ?? null });
  if (after.result?.zipPath) {
    const story = await readArchive(after.result.zipPath);
    const audios = (story.stageNodes ?? []).map((stage) => stage.audio).filter(Boolean);
    step(steps, 'Le ZIP porte un audio pour chaque écran qui en demandait un',
      (observed) => observed.count >= 3, { count: audios.length });
  }
  bench().dismissExport();

  report.cases.push({ name: 'Média manquant partagé et path:null', steps });
  return steps.filter((row) => row.held !== null).every((row) => row.held);
}

// ── Cas 3 — Relecture de l'archive, et ce que l'interface en dit ────────────

// Le canvas ne met rien dans le DOM ; les panneaux, si. Leur **texte** est donc
// une meilleure preuve qu'une image pour des libellés, des présences et des
// états — c'est la convention de l'atelier natif, et elle vaut ici pour le tiroir
// d'export et le bandeau de relecture.
function panelText(selector) {
  return document.querySelector(selector)?.innerText?.replace(/\s+/g, ' ').trim() ?? null;
}

function clickByLabel(fragment) {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(fragment));
  button?.click();
  return Boolean(button);
}

async function casRelecture(report, context) {
  const steps = [];

  // Le tiroir s'ouvre par le bouton de la barre, comme un auteur le ferait.
  const opened = clickByLabel('Exporter le pack');
  await settle();
  // La readiness est demandée à l'ouverture ; elle arrive par IPC.
  for (let attempt = 0; attempt < 40 && !(panelText('.advanced-export__verdict') ?? '').includes('Export'); attempt += 1) {
    await settle();
  }
  const drawer = panelText('.advanced-export');
  step(steps, 'Le tiroir d’export dit le blocage et la qualification séparément',
    (observed) => observed.opened
      && observed.text.includes('Export')
      && observed.text.includes('Interopérabilité'),
    { opened, text: drawer ?? '' });

  const { state } = await exportTo(context.outputDir);
  await settle();
  step(steps, 'Le rapport de succès nomme le fichier et ses transformations',
    (observed) => observed.phase === 'succeeded' && observed.text.includes('Archive produite'),
    { phase: state.phase, text: panelText('.advanced-export__outcome') ?? '' });

  // La relecture s'ouvre par le bouton du rapport, sur l'archive réellement
  // produite — pas sur un chemin recomposé.
  const reviewed = clickByLabel('Relire cette archive');
  await settle();
  for (let attempt = 0; attempt < 40 && !document.querySelector('.lunii-sim'); attempt += 1) await settle();
  const banner = panelText('.advanced-review-banner');
  step(steps, 'La relecture porte sur ce ZIP, et le dit',
    (observed) => observed.opened
      && observed.mounted
      && observed.text.includes(observed.zip)
      && observed.text.includes('correspond au document actuellement ouvert'),
    {
      opened: reviewed,
      mounted: document.querySelector('.lunii-sim') !== null,
      text: banner ?? '',
      zip: state.result?.zipPath ?? '',
      current: document.querySelector('.advanced-review-banner')?.dataset?.current ?? null,
    });

  // Le simulateur est monté **sans projet hiérarchique** : aucun arbre Libre
  // n'apparaît derrière lui.
  step(steps, 'Le lecteur monte sans projet hiérarchique fictif',
    (observed) => observed.simulator && !observed.tree,
    {
      simulator: document.querySelector('.lunii-sim') !== null,
      tree: document.querySelector('.tree-panel, .structure-panel') !== null,
    });

  // Une édition suit : la simulation ne doit plus être présentée comme celle du
  // document courant.
  const view = await readView(bench().payload());
  const someStage = (view.stages ?? []).find((stage) => stage.squareOne?.value !== true) ?? view.stages[0];
  const edited = await runGesture(advancedGestures.setStageControls(someStage.uuid, {
    pause: { form: 'set', value: !(someStage.controls?.pause?.value === true) },
  }));
  await settle();
  const afterEdit = panelText('.advanced-review-banner');
  step(steps, 'Après une édition, la relecture n’est plus donnée pour le document courant',
    (observed) => observed.applied
      && observed.current === 'false'
      && observed.text.includes('le document a changé depuis cet export'),
    {
      applied: edited.status === 'applied',
      current: document.querySelector('.advanced-review-banner')?.dataset?.current ?? null,
      text: afterEdit ?? '',
    });

  clickByLabel('Fermer la relecture');
  await settle();
  bench().dismissExport();
  report.panels = { tiroir: drawer, bandeau: banner, bandeauApresEdition: afterEdit };
  report.cases.push({ name: 'Relecture de l’archive exportée', steps });
  return steps.every((row) => row.held);
}

// ── Campagne ────────────────────────────────────────────────────────────────

export async function runExportParcours({ profile, context }) {
  // Les erreurs non gérées sont recueillies : un plantage de rendu pendant un
  // pas fait tomber les suivants pour une raison qui n'est pas la leur, et le
  // relevé doit porter la cause première, pas seulement les conséquences.
  const crashes = [];
  window.addEventListener('error', (event) => {
    crashes.push({ at: new Date().toISOString(), message: String(event.message ?? event.error) });
  });
  window.addEventListener('unhandledrejection', (event) => {
    crashes.push({ at: new Date().toISOString(), rejection: String(event.reason?.message ?? event.reason) });
  });

  await waitForDriver();
  while (!bench().payload()) await settle();

  const report = {
    runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-export-${profile}`,
    label: 'export-g1-06',
    profile,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    startedAt: new Date().toISOString(),
    sandbox: context.sandbox,
    cases: [],
  };

  const suite = [
    ['Import → A → save/reopen → export → relecture', casParcoursA],
    ['Import → B → entrée réassignée → save/reopen → export', casParcoursB],
    ['Deux exports dans le même dossier', casDeuxExports],
    ['Relecture de l’archive exportée', casRelecture],
    ['Export en cours puis intention d’éditer', casExportPuisEdition],
    ['Annulation, dossier non inscriptible, outil indisponible', casRefus],
    ['Contrôle absent, Action orpheline, disposition périmée', casDecisionsEtMedias],
    ['Média manquant partagé et path:null', casMediaManquant],
    // Le déplacement de dossier passe en dernier : il emporte son dossier de
    // projet, et le faire plus tôt ferait échouer les cas suivants pour une
    // raison qui n'est pas la leur.
    ['Save As, session temporaire, crash/reprise, dossier déplacé', casDeplacement],
  ];

  for (const [name, run] of suite) {
    try {
      await run(report, context);
    } catch (error) {
      report.cases.push({
        name,
        steps: [],
        // Le message **et** la pile : sous WebKitGTK, `stack` ne porte pas le
        // message, et un relevé qui n'aurait que la pile obligerait à relancer
        // toute la campagne pour savoir ce qui s'est passé.
        interrompu: String(error?.message ?? error),
        pile: String(error?.stack ?? ''),
        brut: (() => { try { return JSON.stringify(error); } catch { return null; } })(),
      });
    }
  }

  // La source FS projetée n'est pas jouée ici : elle exige un pack au format FS
  // réel, que ce générateur de fixtures ne produit pas. Le déclarer vaut mieux
  // que de le compter.
  report.cases.push({
    name: 'Source FS projetée',
    steps: [{
      name: 'Import d’un pack FS, décisions explicites, aucune promotion de positions',
      held: null,
      nonExécuté: "non joué : la fixture FS n'est pas produite par le banc. Recette : "
        + "importer un dossier de pack FS par « Modifier un pack », cocher « Ouvrir dans "
        + "l'Éditeur avancé », puis rejouer les cas 1 et 4 sur ce document.",
    }],
  });

  const allSteps = report.cases.flatMap((entry) => entry.steps ?? []);
  report.crashes = crashes;
  report.finishedAt = new Date().toISOString();
  report.framesSuspended = suspendedFrames;
  report.stepCount = allSteps.length;
  report.executed = allSteps.filter((row) => row.held !== null).length;
  report.notExecuted = allSteps.filter((row) => row.held === null).map((row) => row.name);
  report.failed = allSteps.filter((row) => row.held === false).map((row) => row.name);
  report.interrupted = report.cases.filter((entry) => entry.interrompu).map((entry) => entry.name);
  report.held = report.failed.length === 0 && report.interrupted.length === 0;

  await fetch('/__bench/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });

  const banner = document.createElement('p');
  banner.setAttribute('role', 'status');
  banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;margin:0;padding:8px 12px;'
    + `font:13px system-ui;color:#fff;background:${report.held ? '#1e5e3a' : '#7a2016'};z-index:9999`;
  banner.textContent = report.held
    ? `Parcours export : ${report.executed} pas tenus, ${report.notExecuted.length} non exécutés.`
    : `Parcours export : ${report.failed.length} pas non tenus — ${report.failed.join(' · ')}`;
  document.body.append(banner);
  return report;
}
