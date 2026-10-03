// Le parcours natif de l'atelier : MVP-A puis MVP-B, dans la WebView réelle.
//
// Il ne double aucune règle et ne connaît aucun raccourci : il appelle les mêmes
// fonctions que les boutons de l'espace de travail, lit le graphe par la même
// commande que le canvas, et **choisit ses cibles dans la vue** au lieu de les
// coder en dur — un parcours qui suppose la fixture finit par prouver la
// fixture.
//
// Ce qu'il prouve : les gestes partent et reviennent dans WebKitGTK, chaque
// geste accepté est une étape d'undo, l'annulation restaure le payload à
// l'octet, et un refus laisse le document intact. Ce qu'il ne prouve pas :
// l'ergonomie, le clavier, le focus, le contraste, les gestes matériels.

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

// Deux images : la première rend la main à React, la seconde laisse le rendu
// suivant poser le pilote à jour. Lire avant cela rendrait l'état d'avant.
//
// Une fenêtre non composée — minimisée, occultée, ou ouverte dans une session
// sans compositeur qui la présente — **suspend** `requestAnimationFrame` sans
// erreur. Un parcours qui n'attendrait que des images s'arrêterait alors
// indéfiniment, à zéro pour cent de processeur, et passerait pour un blocage
// du code éprouvé. La minuterie est donc le filet, et le relevé dit laquelle
// des deux a gagné.
let suspendedFrames = 0;

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

async function waitForDriver(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.__atelier) return window.__atelier;
    await settle();
  }
  throw new Error("Le pilote de l'atelier n'est jamais apparu.");
}

function driver() {
  return window.__atelier;
}

// La lecture porte sur un payload **explicite**.
//
// Un geste accepté rend le projet qu'il vient de produire : c'est lui qui fait
// foi, et le lire évite que le parcours mesure le rythme de rendu de React au
// lieu du document. Le rattrapage du store est vérifié à part, une fois, par son
// propre pas.
async function readView(payload) {
  return invokeTauri('read_advanced_graph_view', { payload });
}

// Un pas du parcours : ce qu'on a demandé, ce qui est revenu, et ce que le
// document en dit. Aucun pas n'est réputé réussi : chacun porte son verdict.
function step(name, expectation, observed, extra = {}) {
  const held = expectation(observed);
  return { name, held, observed, ...extra };
}

function jsonDifferences(before, after, path = '', found = []) {
  if (found.length >= 20 || JSON.stringify(before) === JSON.stringify(after)) return found;
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
    found.push({ path: path || '/', before, after });
    return found;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    jsonDifferences(before[key], after[key], `${path}/${key}`, found);
    if (found.length >= 20) break;
  }
  return found;
}

// La capture vient du **moteur qui a peint le rendu**, jamais d'une capture
// d'écran : rien de ce qui se trouve à l'écran au même moment ne peut s'y
// retrouver. Cytoscape empile plusieurs calques ; ils sont recomposés dans
// l'ordre du DOM, sur le fond de la surface.
async function capture(name) {
  const host = document.querySelector('.advanced-canvas__host');
  const layers = [...(host?.querySelectorAll('canvas') ?? [])];
  if (layers.length === 0) return { name, written: false, reason: 'aucun calque peint' };
  const flat = document.createElement('canvas');
  flat.width = layers[0].width;
  flat.height = layers[0].height;
  const context = flat.getContext('2d');
  context.fillStyle = '#15181c';
  context.fillRect(0, 0, flat.width, flat.height);
  for (const layer of layers) context.drawImage(layer, 0, 0);
  const response = await fetch('/__bench/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, dataUrl: flat.toDataURL('image/png') }),
  });
  return { name, written: response.ok, width: flat.width, height: flat.height };
}

// Le payload courant du parcours : celui du dernier geste accepté, ou celui du
// store quand aucun geste n'est encore parti (ouverture, undo, redo).
let currentPayload = null;

// La capture du moteur ne montre que ce que le moteur peint : ni la barre, ni
// la liste de recherche, ni l'éditeur, qui sont du DOM. Leur texte est donc
// relevé à côté — et c'est une meilleure preuve qu'une image pour ce qu'ils
// portent : des libellés, des présences et des états.
function panelText() {
  const read = (selector) => document.querySelector(selector)?.innerText?.trim() ?? null;
  return {
    toolbar: read('.advanced-toolbar'),
    editor: read('.advanced-inspector--editor'),
    searchCount: read('.advanced-search__count'),
  };
}

async function runGesture(gesture) {
  const outcome = await driver().runGesture(gesture);
  if (outcome.status === 'applied') {
    const { readAuthoringPayload } = await import('../../src/store/projectModel/authoring.js');
    currentPayload = readAuthoringPayload(outcome.project);
  }
  await settle();
  return outcome;
}

function syncPayloadFromStore() {
  currentPayload = driver().payload();
  return currentPayload;
}

// ── Choix des cibles, dans la vue ────────────────────────────────────────────

function pickTargets(view) {
  const entryPath = view.entry?.stagePath ?? null;
  const stages = view.stages ?? [];
  const actions = view.actions ?? [];

  // Un Écran ordinaire : ni l'entrée, ni un identifiant dupliqué.
  const stage = stages.find((candidate) => candidate.path !== entryPath && candidate.uniqueId === true)
    ?? stages.find((candidate) => candidate.uniqueId === true);

  // Une Action dont la roue porte au moins deux occurrences, pour que la
  // permutation et le retrait aient un sens.
  const action = actions.find((candidate) => candidate.uniqueId === true
    && (candidate.options?.length ?? 0) >= 2);

  const entry = stages.find((candidate) => candidate.path === entryPath) ?? null;
  return { entry, stage, action };
}

// ── Parcours A : modifier un pack importé ────────────────────────────────────

async function parcoursA(report) {
  const before = await readView(syncPayloadFromStore());
  const { entry, stage, action } = pickTargets(before);
  const initialPayload = driver().payload();
  report.initialCanUndo = driver().canUndo();
  if (!stage || !action) throw new Error('La fixture ne porte ni Écran ni Action utilisables.');

  report.targets = {
    entryPath: entry?.path ?? null,
    stagePath: stage.path,
    actionPath: action.path,
    optionCount: action.options.length,
  };

  // 1. Un contrôle bouge seul, et la transition lui survit.
  const controlBefore = stage.controls?.pause ?? null;
  const wanted = !(controlBefore?.presence === 'value' && controlBefore.value === true);
  const controls = await runGesture({
    gesture: 'set-stage-controls',
    stageUuid: stage.uuid,
    update: { form: 'members', members: { pause: { form: 'set', value: wanted } } },
  });
  let view = await readView(currentPayload);
  let seen = view.stages.find((candidate) => candidate.path === stage.path);
  report.steps.push(step('contrôle modifié seul', (observed) => observed.applied
    && observed.pause?.presence === 'value'
    && observed.pause.value === wanted
    && JSON.stringify(observed.okTransition) === JSON.stringify(stage.okTransition), {
    applied: controls.status === 'applied',
    pause: seen?.controls?.pause ?? null,
    okTransition: seen?.okTransition ?? null,
  }));

  // 2. Une transition OK posée avec une Action **et** une sélection explicites.
  const transition = await runGesture({
    gesture: 'set-stage-transition',
    stageUuid: stage.uuid,
    slot: 'ok',
    update: { form: 'set', actionNode: action.id, optionIndex: 0 },
  });
  view = await readView(currentPayload);
  seen = view.stages.find((candidate) => candidate.path === stage.path);
  report.steps.push(step('transition OK posée', (observed) => observed.applied
    && observed.actionId === action.id
    && observed.selection?.kind === 'fixed'
    && observed.selection.index === 0, {
    applied: transition.status === 'applied',
    actionId: seen?.okTransition?.actionId ?? null,
    selection: seen?.okTransition?.selection ?? null,
  }));

  // 3. Insérer, permuter, puis retirer une occurrence avec sa décision.
  const firstTarget = action.options[0].target;
  const inserted = await runGesture({
    gesture: 'insert-action-option',
    actionId: action.id,
    index: 0,
    target: firstTarget.presence === 'value'
      ? { target: 'stage', uuid: firstTarget.stageUuid }
      : { target: 'null' },
  });
  view = await readView(currentPayload);
  let seenAction = view.actions.find((candidate) => candidate.path === action.path);
  report.steps.push(step('occurrence insérée au rang 0', (observed) => observed.applied
    && observed.count === action.options.length + 1, {
    applied: inserted.status === 'applied',
    count: seenAction?.options.length ?? 0,
  }));

  // La permutation transporte des **rangs**, jamais des cibles : deux
  // occurrences de même destination ne peuvent donc pas fusionner.
  const length = seenAction.options.length;
  const permutation = Array.from({ length }, (unused, rank) => rank);
  permutation[0] = 1;
  permutation[1] = 0;
  const targetsBefore = seenAction.options.map((option) => option.target.stageUuid);
  const reordered = await runGesture({
    gesture: 'reorder-action-options',
    actionId: action.id,
    newPositionOfOld: permutation,
  });
  view = await readView(currentPayload);
  seenAction = view.actions.find((candidate) => candidate.path === action.path);
  const targetsAfter = seenAction.options.map((option) => option.target.stageUuid);
  report.steps.push(step('permutation sans fusion', (observed) => observed.applied
    && observed.count === length
    && observed.swapped, {
    applied: reordered.status === 'applied',
    count: seenAction.options.length,
    swapped: targetsAfter[0] === targetsBefore[1] && targetsAfter[1] === targetsBefore[0],
    targetsBefore,
    targetsAfter,
  }));

  // Le retrait exige une décision pour chaque transition qu'il priverait de sa
  // destination. Le parcours les collecte comme le dialogue les collecte.
  const ordinal = 0;
  const remaining = seenAction.options.length - 1;
  const decisions = [];
  for (const stageView of view.stages) {
    for (const [slot, field] of [['ok', 'okTransition'], ['home', 'homeTransition']]) {
      const candidate = stageView[field];
      if (candidate?.presence !== 'value' || candidate.actionId !== action.id) continue;
      const selection = candidate.selection;
      const survives = selection?.kind === 'random'
        ? remaining > 0
        : selection?.index !== ordinal
          && (selection?.index > ordinal ? selection.index - 1 : selection.index) < remaining;
      if (!survives) {
        decisions.push({
          stageUuid: stageView.uuid,
          slot,
          resolution: remaining > 0
            ? { form: 'select', optionIndex: 0 }
            : { form: 'null' },
        });
      }
    }
  }
  const removed = await runGesture({
    gesture: 'remove-action-option',
    actionId: action.id,
    ordinal,
    selections: decisions,
  });
  view = await readView(currentPayload);
  seenAction = view.actions.find((candidate) => candidate.path === action.path);
  report.steps.push(step('occurrence retirée avec décision', (observed) => observed.applied
    && observed.count === remaining, {
    applied: removed.status === 'applied',
    count: seenAction?.options.length ?? 0,
    decisions: decisions.length,
  }));

  // 4. Un refus : l'entrée ne se retire pas, et le document reste intact.
  // Le store doit avoir rattrapé le dernier geste accepté avant qu'on juge un
  // refus sur ce qu'il porte. Ce pas le vérifie explicitement : sans lui, les
  // pas suivants reposeraient sur une hypothèse de rythme de rendu.
  const appliedPayload = currentPayload;
  while (driver().payload() !== appliedPayload && report.storeWaits < 40) {
    report.storeWaits += 1;
    await settle();
  }
  report.steps.push(step('le store porte le document du dernier geste', (observed) => observed.caughtUp, {
    caughtUp: driver().payload() === appliedPayload,
    waits: report.storeWaits,
  }));

  const payloadBeforeRefusal = driver().payload();
  const refused = entry
    ? await runGesture({ gesture: 'delete-stage', stageUuid: entry.uuid })
    : { status: 'skipped' };
  report.steps.push(step('retrait de l\'entrée refusé, document intact', (observed) => observed.refused
    && observed.code === 'SQUARE_ONE_REMOVAL'
    && observed.payloadUnchanged, {
    refused: refused.status === 'refused',
    code: refused.error?.code ?? null,
    payloadUnchanged: driver().payload() === payloadBeforeRefusal,
  }));

  // 5. Cinq gestes acceptés, cinq étapes d'undo : le payload de départ revient
  //    **à l'octet**, puis le redo le reprend.
  let undone = 0;
  while (driver().canUndo() && undone < 5) {
    driver().undo();
    await settle();
    undone += 1;
  }
  const restored = driver().payload();
  let redone = 0;
  while (driver().canRedo() && redone < 5) {
    driver().redo();
    await settle();
    redone += 1;
  }
  // Après l'aller-retour d'historique, le parcours repart de ce que le store
  // porte réellement : c'est lui qui a la main sur la valeur courante.
  syncPayloadFromStore();
  report.captures.push(await capture('atelier-parcours-a'));
  report.panels = { apresParcoursA: panelText() };
  report.steps.push(step('undo et redo traversent les cinq gestes', (observed) => observed.undone === 5
    && observed.redone === 5
    && observed.restoredToTheByte, {
    undone,
    redone,
    restoredToTheByte: restored === initialPayload,
    initialLength: initialPayload.length,
    restoredLength: restored.length,
    payloadDiff: restored === initialPayload
      ? []
      : jsonDifferences(JSON.parse(initialPayload), JSON.parse(restored)),
  }));
}

// ── Parcours B : créer, raccorder, transférer l'entrée, retirer ──────────────

async function parcoursB(report) {
  const created = await runGesture({
    gesture: 'create-stage',
    stage: {
      name: 'Écran du parcours',
      controls: { wheel: false, ok: true, home: false, pause: false, autoplay: false },
    },
  });
  const newStageUuid = created.report?.created?.stageUuid ?? null;
  let view = await readView(currentPayload);
  const createdStage = view.stages.find((candidate) => candidate.uuid === newStageUuid) ?? null;
  report.steps.push(step('Écran créé, détaché et non-entrée', (observed) => observed.applied
    && observed.exists
    && observed.squareOne === false
    && observed.detached, {
    applied: created.status === 'applied',
    exists: createdStage !== null,
    squareOne: createdStage?.squareOne?.value ?? null,
    detached: !(view.edges ?? []).some((edge) => edge.from === createdStage?.path
      || edge.to === createdStage?.path),
  }));

  const createdAction = await runGesture({
    gesture: 'create-action',
    action: { id: null, name: 'Action du parcours', options: [{ target: 'stage', uuid: newStageUuid }] },
  });
  const newActionId = createdAction.report?.created?.actionId ?? null;
  view = await readView(currentPayload);
  report.steps.push(step('Action créée, autonome', (observed) => observed.applied && observed.exists, {
    applied: createdAction.status === 'applied',
    exists: view.actions.some((candidate) => candidate.id === newActionId),
  }));

  // Le raccord est un geste **distinct** de la création.
  const previousEntry = view.stages.find((candidate) => candidate.path === view.entry?.stagePath);
  const wired = await runGesture({
    gesture: 'set-stage-transition',
    stageUuid: newStageUuid,
    slot: 'ok',
    update: { form: 'set', actionNode: newActionId, optionIndex: 0 },
  });
  view = await readView(currentPayload);
  report.steps.push(step('raccord posé par un geste distinct', (observed) => observed.applied
    && observed.wired, {
    applied: wired.status === 'applied',
    wired: (view.edges ?? []).some((edge) => edge.kind === 'stage-ok'
      && edge.from === createdStage?.path),
  }));

  // Transfert de l'entrée : exactement une, et l'identité du pack ne bouge pas.
  const identityBefore = JSON.stringify(view.packIdentity);
  const entryMoved = await runGesture({ gesture: 'set-square-one', stageUuid: newStageUuid });
  view = await readView(currentPayload);
  const entries = view.stages.filter((candidate) => candidate.squareOne?.value === true);
  report.steps.push(step('entrée transférée, identité inchangée', (observed) => observed.applied
    && observed.entryCount === 1
    && observed.entryIsNew
    && observed.identityUnchanged, {
    applied: entryMoved.status === 'applied',
    entryCount: entries.length,
    entryIsNew: entries[0]?.uuid === newStageUuid,
    identityUnchanged: JSON.stringify(view.packIdentity) === identityBefore,
  }));

  // Retrait de l'ancienne entrée : le refus inventorie d'abord, puis le plan
  // explicite passe en une seule transaction.
  const bare = await runGesture({ gesture: 'delete-stage', stageUuid: previousEntry.uuid });
  const references = bare.error?.references ?? [];
  report.steps.push(step('retrait refusé avec son inventaire', (observed) => observed.refused
    ? observed.references > 0
    : observed.applied, {
    refused: bare.status === 'refused',
    applied: bare.status === 'applied',
    code: bare.error?.code ?? null,
    references: references.length,
  }));

  if (bare.status === 'refused') {
    // Le plan est bâti sur `references`, dans la graphie d'`optionId` du DTO,
    // jamais en découpant la phrase du refus.
    const byOptionId = new Map();
    for (const candidate of view.actions) {
      for (const option of candidate.options ?? []) {
        byOptionId.set(option.optionId, { actionId: candidate.id, ordinal: option.ordinal });
      }
    }
    const options = references
      .map((reference) => byOptionId.get(reference))
      .filter(Boolean)
      .map((row) => ({ ...row, resolution: { form: 'null' } }));
    const planned = await runGesture({
      gesture: 'delete-stage',
      stageUuid: previousEntry.uuid,
      plan: { options, selections: [] },
    });
    view = await readView(currentPayload);
    report.steps.push(step('retrait appliqué en une transaction', (observed) => observed.applied
      && observed.gone
      && observed.entryCount === 1, {
      applied: planned.status === 'applied',
      code: planned.error?.code ?? null,
      planned: options.length,
      gone: !view.stages.some((candidate) => candidate.uuid === previousEntry.uuid),
      entryCount: view.stages.filter((candidate) => candidate.squareOne?.value === true).length,
    }));
  }

  report.finalCounts = view.counts;
  report.captures.push(await capture('atelier-parcours-b'));
  report.panels = { ...report.panels, apresParcoursB: panelText() };
}

// ── Parcours C : les gestes de surface du graphe à plat ──────────────────────
//
// Menu contextuel, bouton ▶ et choix de destination d'une écoute depuis une
// Action. Ces trois-là sont câblés dans `AdvancedWorkspace`, que la surface du
// banc de recette ne monte pas : ils n'étaient donc éprouvés que par des essais
// purs, alors que le rendu et les gestes doivent être vérifiés dans Tauri.
//
// Les événements sont **synthétiques**. Ils entrent par les mêmes gestionnaires
// que la souris réelle — et le criblage de Cytoscape leur répond, ce qui est
// précisément ce qui permet à `nodeAtPointer()` de désigner une cible — mais ce
// n'est pas la chaîne d'entrée du compositeur. Un défaut propre au matériel lui
// échappe, et le relevé le dit.

const $$ = (selector) => [...document.querySelectorAll(selector)];
const $1 = (selector) => document.querySelector(selector);

// Amener la scène à un zoom où les cartes sont peintes : la couche de
// surimpressions donne alors la position **écran** de chaque nœud, seule façon
// de viser une carte sans que le canvas expose quoi que ce soit au DOM.
async function zoomUntilCards(limit = 12) {
  $1('[aria-label="Cadrer tout le graphe"]')?.click();
  await settle();
  for (let attempt = 0; attempt < limit && $$('.advanced-node-overlay').length === 0; attempt += 1) {
    $1('[aria-label="Agrandir"]')?.click();
    await settle();
  }
  return $$('.advanced-node-overlay').length;
}

// Ouvrir le menu **par le clavier**, depuis la liste de résultats.
//
// La voie du pointeur a d'abord été essayée : déplacer le curseur sur la carte,
// puis émettre le clic droit. Elle ne marche pas depuis un script, et pour une
// raison qui n'est pas un défaut du produit : le canvas vise le nœud sous le
// pointeur en le demandant au moteur, et Cytoscape ne connaît de survol que
// celui qu'il dérive lui-même des mouvements d'une vraie souris. Un `mousemove`
// synthétique ne pose pas ce survol, `nodeAtPointer()` rend `null`, et aucun
// menu ne s'ouvre.
//
// Cette impasse a révélé mieux qu'une lacune de banc : **il n'existait aucune
// façon d'ouvrir le menu sans pointeur**. Le parcours clavier atteignait chaque
// nœud de la liste sans pouvoir rien en faire, alors que le menu doit être
// utilisable au clavier. La liste répond donc désormais à Shift+F10 et à
// la touche Menu, et c'est cette porte — celle d'un auteur au clavier — que le
// parcours emprunte.
async function openMenuFromList(rank = 0) {
  const rows = $$('.advanced-search__list [role="option"]');
  if (rows.length === 0) return null;
  const row = rows[Math.min(rank, rows.length - 1)];
  const targetPath = rowPath(row);
  row.click();                       // le nœud devient le courant de la liste
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await settle();
    if (rowPath($1('.advanced-search__list [data-focused="true"]')) === targetPath) break;
  }
  const list = $1('.advanced-search__list');
  list.focus();
  list.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  return row;
}

const menuLabels = () => $$('.ctx-menu .ctx-item .ctx-item-label').map((one) => one.textContent.trim());
const menuItem = (label) => $$('.ctx-menu .ctx-item')
  .find((one) => one.textContent.includes(label)) ?? null;
const rowPath = (row) => {
  const prefix = 'advanced-option-';
  return row?.id?.startsWith(prefix) ? decodeURIComponent(row.id.slice(prefix.length)) : null;
};

const buttonWithText = (label, root = document) => [...(root?.querySelectorAll('button') ?? [])]
  .find((button) => button.textContent.trim().includes(label)) ?? null;

function chooseSelect(select, value) {
  if (!select) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, String(value));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function overlayFor(path) {
  return $$('.advanced-node-overlay').find((overlay) => overlay.dataset.nodePath === path) ?? null;
}

function visibleLinkTargets(view) {
  const visible = new Set($$('.advanced-node-overlay').map((overlay) => overlay.dataset.nodePath));
  const stage = view.stages.find((candidate) => visible.has(candidate.path)
    && candidate.uniqueId === true
    && [candidate.controls?.ok, candidate.controls?.autoplay, candidate.controls?.home]
      .some((control) => control?.presence === 'value' && control.value === true));
  const action = view.actions.find((candidate) => visible.has(candidate.path) && candidate.uniqueId === true);
  return { stage, action };
}

async function selectGraphPath(path) {
  const row = $$('.advanced-search__list [role="option"]')
    .find((candidate) => rowPath(candidate) === path);
  row?.click();
  await settle();
  // La liste déplace le focus de lecture, sans modifier à elle seule la
  // sélection d'édition. L'ouverture clavier du menu fait volontairement du
  // nœud courant la sélection, exactement comme pour un auteur sans souris.
  const list = $1('.advanced-search__list');
  list?.focus();
  list?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  if ($1('.ctx-menu')) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
  }
  return Boolean(row);
}

function blankCanvasPoint() {
  const stage = $1('.advanced-canvas__stage');
  const bounds = stage?.getBoundingClientRect();
  if (!bounds) return null;
  const occupied = $$('.advanced-node-overlay').map((node) => node.getBoundingClientRect());
  for (let y = bounds.top + 70; y < bounds.bottom - 70; y += 60) {
    for (let x = bounds.left + 70; x < bounds.right - 70; x += 60) {
      const free = occupied.every((rect) => (
        x < rect.left - 24 || x > rect.right + 24 || y < rect.top - 24 || y > rect.bottom + 24
      ));
      if (free) return { x, y };
    }
  }
  return null;
}

async function dragLink({ sourcePath, portLabel, targetPath = null }) {
  if (!await selectGraphPath(sourcePath)) return { started: false, reason: 'source absente de la liste' };
  await settle();
  const port = $$('.advanced-node-overlay__ports button')
    .find((button) => button.getAttribute('aria-label')?.startsWith(portLabel));
  const target = targetPath ? overlayFor(targetPath) : null;
  const destination = targetPath ? target?.getBoundingClientRect() : blankCanvasPoint();
  if (!port || !destination) {
    return {
      started: false,
      reason: !port ? 'prise absente' : 'destination hors champ',
      sourceVisible: Boolean(overlayFor(sourcePath)),
      prises: $$('.advanced-node-overlay__ports button')
        .map((button) => button.getAttribute('aria-label')),
      selection: $$('.advanced-search__list [data-focused="true"]').map(rowPath),
    };
  }
  const start = port.getBoundingClientRect();
  const end = targetPath
    ? { x: destination.left + destination.width / 2, y: destination.top + destination.height / 2 }
    : destination;
  const pointerId = 41;
  port.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId,
    clientX: start.left + start.width / 2,
    clientY: start.top + start.height / 2,
  }));
  await settle();
  window.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId, clientX: end.x, clientY: end.y,
  }));
  window.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId, clientX: end.x, clientY: end.y,
  }));
  await settle();
  return { started: true, dialog: $1('.advanced-dialog')?.getAttribute('aria-label') ?? null };
}

async function parcoursC(report) {
  const cards = await zoomUntilCards();
  report.steps.push(step('graphe — des cartes sont peintes à un zoom de travail',
    (observed) => observed.cartes > 0, { cartes: cards }));
  if (cards === 0) return;

  // Les deux natures, prises dans la liste : c'est la porte clavier, et elle
  // atteint un nœud même s'il n'est pas dessiné au zoom courant.
  const rows = $$('.advanced-search__list [role="option"]');
  const currentView = await readView(syncPayloadFromStore());
  const uniqueStages = new Set(currentView.stages
    .filter((node) => node.uniqueId === true)
    .map((node) => node.path));
  const stageRank = rows.findIndex((one) => (
    one.dataset.kind === 'stage' && uniqueStages.has(rowPath(one))
  ));
  const actionRank = rows.findIndex((one) => one.dataset.kind === 'action');

  // 1. Le menu s'ouvre au clavier et y pose le focus.
  await openMenuFromList(stageRank < 0 ? 0 : stageRank);
  const opened = $1('.ctx-menu') !== null;
  const focused = document.activeElement?.classList?.contains('ctx-item') === true;
  report.steps.push(step('graphe — le menu s’ouvre au clavier et y pose le focus',
    (observed) => observed.ouvert && observed.focusDansLeMenu,
    { ouvert: opened, focusDansLeMenu: focused, entrees: menuLabels() }));

  // 2. Le menu reste court : le renommage vit au double-clic et dans
  // l'inspecteur ; connexions et palette partagée, elles, sont bien là.
  const written = menuLabels().join(' ').toLowerCase();
  const menuText = $1('.ctx-menu')?.textContent?.toLowerCase() ?? '';
  report.steps.push(step('graphe — menu court avec connexions et palette, sans doublon de renommage',
    (observed) => !observed.renommer && observed.connexions && observed.couleur,
    {
      renommer: written.includes('renommer'),
      connexions: written.includes('voir les connexions'),
      couleur: menuText.includes('couleur'),
      entrees: menuLabels(),
    }));

  report.captures.push(await capture('graphe-menu-contextuel'));

  // 3. Échap referme.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  report.steps.push(step('graphe — Échap referme le menu',
    (observed) => observed.ferme, { ferme: $1('.ctx-menu') === null }));

  // 4. La palette part réellement par le geste natif, puis l'undo remet le
  // document dans son état de départ pour ne pas influencer les pas suivants.
  await openMenuFromList(stageRank < 0 ? 0 : stageRank);
  const colorButton = $1('.ctx-color-dot');
  const coloredPath = rowPath($$('.advanced-search__list [role="option"]')[stageRank < 0 ? 0 : stageRank]);
  const chosenColor = colorButton?.getAttribute('title') ?? null;
  colorButton?.click();
  await driver().whenIdle?.();
  await settle();
  let coloredView = await readView(syncPayloadFromStore());
  const coloredNode = [...coloredView.stages, ...coloredView.actions]
    .find((node) => node.path === coloredPath);
  report.steps.push(step('graphe — la couleur choisie est écrite dans le document avancé',
    (observed) => observed.couleur !== null && observed.couleur === observed.attendue,
    { couleur: coloredNode?.personalColor ?? null, attendue: chosenColor }));
  driver().undo();
  await settle();
  syncPayloadFromStore();

  // 5. Le champ Nom de l'inspecteur confirme au flou, puis l'undo restaure le
  // nom. Le double-clic ne peut pas être visé synthétiquement sans vrai survol
  // du canvas ; sa porte moteur reste couverte par les tests de frontière.
  $$('.advanced-search__list [role="option"]')[stageRank < 0 ? 0 : stageRank]?.click();
  await settle();
  const nameInput = $1('.advanced-field__name-input');
  const formerName = nameInput?.value ?? '';
  const nextName = `${formerName || 'Écran'} · recette`;
  if (nameInput && !nameInput.disabled) {
    nameInput.focus();
    nameInput.select();
    const insertedLikeTyping = document.execCommand?.('insertText', false, nextName) === true;
    if (!insertedLikeTyping) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nameInput._valueTracker?.setValue(formerName);
      setter?.call(nameInput, nextName);
      nameInput.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: nextName,
      }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await settle();
    await settle();
    $1('.advanced-field__name-input')?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    await driver().whenIdle?.();
    await settle();
  }
  const renamedView = await readView(syncPayloadFromStore());
  const renamedNode = renamedView.stages.find((node) => node.path === coloredPath);
  report.steps.push(step('graphe — le nom se confirme depuis l’inspecteur',
    (observed) => observed.desactive || observed.nom === observed.attendu,
    { desactive: nameInput?.disabled === true, nom: renamedNode?.name?.value ?? null, attendu: nextName }));
  if (nameInput && !nameInput.disabled && renamedNode?.name?.value === nextName) {
    driver().undo();
    await settle();
    syncPayloadFromStore();
  }

  // 6. Le voisinage immédiat atténue le reste, s'étend d'un niveau et revient
  // explicitement à la vue complète sans écrire dans le document.
  await openMenuFromList(stageRank < 0 ? 0 : stageRank);
  menuItem('Voir les connexions')?.click();
  await settle();
  await settle();
  const levelOne = $1('.advanced-graph-presentation')?.textContent ?? '';
  const dimmedOne = $$('.advanced-node-overlay.is-dimmed').length;
  $1('.advanced-graph-presentation button')?.click();
  await settle();
  const levelTwo = $1('.advanced-graph-presentation')?.textContent ?? '';
  const dimmedTwo = $$('.advanced-node-overlay.is-dimmed').length;
  report.steps.push(step('graphe — les connexions s’affichent et s’étendent par niveau',
    (observed) => observed.niveau1 && observed.niveau2 && observed.resteAttenue
      && observed.attenuationNonCroissante,
    {
      niveau1: levelOne.includes('niveau 1'),
      niveau2: levelTwo.includes('niveau 2'),
      resteAttenue: dimmedOne > 0,
      attenuationNonCroissante: dimmedTwo <= dimmedOne,
      attenuesNiveau1: dimmedOne,
      attenuesNiveau2: dimmedTwo,
    }));
  const fullView = $$('.advanced-graph-presentation button')
    .find((button) => button.textContent.includes('Vue complète'));
  fullView?.click();
  await settle();
  report.steps.push(step('graphe — « Vue complète » retire l’atténuation',
    (observed) => observed.barreFermee && observed.attenues === 0,
    {
      barreFermee: $1('.advanced-graph-presentation') === null,
      attenues: $$('.advanced-node-overlay.is-dimmed').length,
    }));

  // 7. « Définir comme entrée » part réellement, et l'entrée du pack bouge.
  const beforeEntry = (await readView(syncPayloadFromStore())).entry?.stagePath ?? null;
  await openMenuFromList(stageRank < 0 ? 0 : stageRank);
  const setEntry = menuItem('Définir comme entrée');
  const wasDisabled = setEntry?.getAttribute('aria-disabled') === 'true';
  if (setEntry && !wasDisabled) {
    setEntry.click();
    await settle();
    await settle();
    await driver().whenIdle?.();
    await settle();
  }
  const afterEntry = (await readView(syncPayloadFromStore())).entry?.stagePath ?? null;
  report.steps.push(step('graphe — « Définir comme entrée » déplace l’entrée du pack',
    (observed) => observed.desactive || observed.avant !== observed.apres,
    { avant: beforeEntry, apres: afterEntry, desactive: wasDisabled }));

  // 8. Sur une Action, l'écoute ouvre un **choix** et ne lance rien.
  if (actionRank >= 0) {
    await openMenuFromList(actionRank);
    const listen = menuItem('Écouter depuis cette Action');
    const listenDisabled = listen?.getAttribute('aria-disabled') === 'true';
    report.steps.push(step('graphe — l’écoute d’une Action est offerte, ou refusée avec sa raison',
      (observed) => observed.presente,
      {
        presente: listen !== null,
        desactive: listenDisabled,
        raison: listen?.getAttribute('title') ?? null,
        entrees: menuLabels(),
      }));
    if (listen && !listenDisabled) {
      listen.click();
      await settle();
      await settle();
      const choices = $$('.advanced-listen-choice');
      const checked = $$('.advanced-listen-choice input[type="radio"]')
        .filter((one) => one.checked).length;
      report.steps.push(step('graphe — le choix de destination s’ouvre, sans présélection',
        (observed) => observed.choix > 0 && observed.preselection === 0,
        { choix: choices.length, preselection: checked }));
      report.captures.push(await capture('graphe-ecoute-depuis-action'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      report.steps.push(step('graphe — Échap referme le choix sans rien jouer',
        (observed) => observed.ferme && !observed.simulateur,
        {
          ferme: $$('.advanced-listen-choice').length === 0,
          simulateur: $1('.floating-simulator') !== null,
        }));
    }
  } else {
    report.steps.push(step('graphe — une Action figure dans la liste', () => true,
      { actionsListees: 0 }, { sansObjet: 'aucune Action dans les résultats courants' }));
  }

  // 9. Le ▶ suit la nature du nœud courant : présent sur un Écran, absent sur
  //    une Action, qui exige d'abord une destination.
  await openMenuFromList(stageRank < 0 ? 0 : stageRank);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  const onStage = $$('.advanced-graph-locate__listen').length;
  if (actionRank >= 0) {
    $$('.advanced-search__list [role="option"]')[actionRank].click();
    await settle();
    await settle();
  }
  const onAction = $$('.advanced-graph-locate__listen').length;
  report.steps.push(step('graphe — le ▶ suit la nature du nœud courant',
    (observed) => observed.surEcran === 1 && (observed.rangAction < 0 || observed.surAction === 0),
    { surEcran: onStage, surAction: onAction, rangAction: actionRank }));

  // 10. Une écoute lancée depuis l'Écran active le parcours suivi. Le suivi de
  // caméra se désactive sans toucher à la sélection d'édition.
  await openMenuFromList(stageRank < 0 ? 0 : stageRank);
  menuItem('Écouter depuis cet Écran')?.click();
  await settle();
  await settle();
  const playbackBar = $1('.advanced-graph-presentation');
  const follow = playbackBar?.querySelector('input[type="checkbox"]') ?? null;
  const played = $$('.advanced-node-overlay.is-played').length;
  const followInitially = follow?.checked === true;
  follow?.click();
  await settle();
  report.steps.push(step('graphe — l’écoute marque le nœud joué et laisse couper le suivi caméra',
    (observed) => observed.parcours && observed.joue === 1
      && observed.suiviInitial && !observed.suiviApres,
    {
      parcours: playbackBar?.textContent?.includes('Parcours suivi') === true,
      joue: played,
      suiviInitial: followInitially,
      suiviApres: follow?.checked ?? null,
    }));
  $1('.advanced-review-banner button')?.click();
  await settle();
  report.steps.push(step('graphe — fermer l’écoute nettoie la trace',
    (observed) => observed.simulateurFerme && observed.traceFermee && observed.joue === 0,
    {
      simulateurFerme: $1('.floating-simulator') === null,
      traceFermee: $1('.advanced-graph-presentation') === null,
      joue: $$('.advanced-node-overlay.is-played').length,
    }));

  // 11. Une disposition est une proposition réversible. L'essai conserve
  // ensuite une seconde proposition dans la vue, vérifie la décision séparée
  // de promotion auteur, puis annule le geste pour laisser la suite propre.
  const layoutTrigger = $1('.advanced-layout-control__trigger');
  layoutTrigger?.click();
  await settle();
  const beforeLayout = Object.fromEntries($$('.advanced-node-overlay')
    .map((node) => [node.dataset.nodePath, node.style.transform]));
  $1('.advanced-layout-control__choices [aria-label="Cercle"]')?.click();
  await settle();
  const previewNote = $1('.advanced-layout-control__note')?.textContent ?? '';
  buttonWithText('Annuler', $1('.advanced-layout-control__menu'))?.click();
  await settle();
  await settle();
  const afterCancel = Object.fromEntries($$('.advanced-node-overlay')
    .map((node) => [node.dataset.nodePath, node.style.transform]));
  const restoredPaths = Object.keys(beforeLayout).filter((path) => afterCancel[path] === beforeLayout[path]);
  report.steps.push(step('graphe — une disposition est prévisualisée puis annulée exactement',
    (observed) => observed.apercu && observed.restauree,
    {
      apercu: previewNote.includes('Aperçu seulement'),
      restauree: restoredPaths.length === Object.keys(beforeLayout).length
        && Object.keys(afterCancel).length === Object.keys(beforeLayout).length,
      avant: Object.keys(beforeLayout).length,
      apres: Object.keys(afterCancel).length,
      restaurees: restoredPaths.length,
    }));

  const payloadBeforeLayout = driver().payload();
  $1('.advanced-layout-control__choices [aria-label="Grille"]')?.click();
  await settle();
  buttonWithText('Conserver la vue', $1('.advanced-layout-control__menu'))?.click();
  await driver().whenIdle?.();
  await settle();
  syncPayloadFromStore();
  const promotionText = $1('.advanced-layout-control__promotion')?.textContent ?? '';
  report.steps.push(step('graphe — conserver la vue reste distinct de la position d’auteur',
    (observed) => observed.geste && observed.promotionSeparee,
    {
      geste: driver().payload() !== payloadBeforeLayout,
      promotionSeparee: promotionText.includes('seconde décision'),
    }));
  buttonWithText('Terminer', $1('.advanced-layout-control__menu'))?.click();
  driver().undo();
  await settle();
  await settle();
  syncPayloadFromStore();

  // 12. Les deux sens de raccord direct passent réellement par les prises
  // d'icônes, le fil provisoire et le dialogue. Chaque essai est ensuite
  // annulé par l'historique pour garder des cibles stables.
  let linkView = await readView(currentPayload);
  let { stage: linkStage, action: linkAction } = visibleLinkTargets(linkView);
  if (linkStage && linkAction) {
    const activeSlot = linkStage.controls?.ok?.value === true || linkStage.controls?.autoplay?.value === true
      ? 'ok'
      : 'home';
    const portLabel = activeSlot === 'home' ? 'Raccorder par HOME' : 'Raccorder par OK';
    const drag = await dragLink({
      sourcePath: linkStage.path,
      portLabel,
      targetPath: linkAction.path,
    });
    chooseSelect($1('#graph-link-selection'), '0');
    buttonWithText('Raccorder', $1('.advanced-dialog'))?.click();
    await driver().whenIdle?.();
    await settle();
    syncPayloadFromStore();
    linkView = await readView(currentPayload);
    const linkedStage = linkView.stages.find((candidate) => candidate.path === linkStage.path);
    const transition = activeSlot === 'home' ? linkedStage?.homeTransition : linkedStage?.okTransition;
    report.steps.push(step('graphe — Écran vers Action se raccorde depuis une prise',
      (observed) => observed.dialogue && observed.raccorde,
      {
        dialogue: drag.dialog,
        raccorde: transition?.presence === 'value'
          && transition.actionPath === linkAction.path
          && transition.selection?.kind === 'fixed'
          && transition.selection.index === 0,
      }));
    driver().undo();
    await settle();
    await settle();
    syncPayloadFromStore();

    linkView = await readView(currentPayload);
    ({ stage: linkStage, action: linkAction } = visibleLinkTargets(linkView));
    const formerCount = linkAction?.options.length ?? 0;
    const reverseDrag = linkStage && linkAction
      ? await dragLink({
        sourcePath: linkAction.path,
        portLabel: 'Ajouter une destination',
        targetPath: linkStage.path,
      })
      : { dialog: null };
    buttonWithText('Raccorder', $1('.advanced-dialog'))?.click();
    await driver().whenIdle?.();
    await settle();
    syncPayloadFromStore();
    linkView = await readView(currentPayload);
    const linkedAction = linkView.actions.find((candidate) => candidate.path === linkAction?.path);
    report.steps.push(step('graphe — Action vers Écran ajoute la destination à la fin par défaut',
      (observed) => observed.dialogue && observed.ajoutee && observed.aLaFin,
      {
        dialogue: reverseDrag.dialog,
        raison: reverseDrag.reason ?? null,
        sourceVisible: reverseDrag.sourceVisible ?? null,
        prises: reverseDrag.prises ?? null,
        selection: reverseDrag.selection ?? null,
        ajoutee: linkedAction?.options.length === formerCount + 1,
        aLaFin: linkedAction?.options.at(-1)?.target?.stagePath === linkStage?.path,
      }));
    driver().undo();
    await settle();
    await settle();
    syncPayloadFromStore();
  } else {
    report.steps.push(step('graphe — des cibles visibles permettent les deux raccords directs',
      (observed) => observed.stage && observed.action,
      { stage: Boolean(linkStage), action: Boolean(linkAction) }));
  }

  // 13. Déposer dans le vide crée le nœud opposé et le raccord dans une seule
  // transaction native. Le dialogue expose bien « À la fin » en premier.
  linkView = await readView(currentPayload);
  ({ stage: linkStage, action: linkAction } = visibleLinkTargets(linkView));
  if (linkAction) {
    const beforeCounts = linkView.counts;
    const emptyDrag = await dragLink({
      sourcePath: linkAction.path,
      portLabel: 'Ajouter une destination',
    });
    const insertion = $1('#graph-linked-rank');
    const firstChoice = insertion?.options?.[0]?.textContent ?? null;
    buttonWithText('Créer et raccorder', $1('.advanced-dialog'))?.click();
    await driver().whenIdle?.();
    await settle();
    syncPayloadFromStore();
    const createdView = await readView(currentPayload);
    const changedAction = createdView.actions.find((candidate) => candidate.path === linkAction.path);
    report.steps.push(step('graphe — déposer une Action dans le vide crée et raccorde un Écran atomiquement',
      (observed) => observed.dialogue && observed.premierChoix && observed.unEcran
        && observed.uneDestination && observed.aLaFin,
      {
        dialogue: emptyDrag.dialog,
        premierChoix: firstChoice === 'À la fin',
        unEcran: createdView.counts.stages === beforeCounts.stages + 1,
        uneDestination: changedAction?.options.length === linkAction.options.length + 1,
        aLaFin: changedAction?.options.at(-1)?.target?.presence === 'value',
      }));
    driver().undo();
    await settle();
    await settle();
    syncPayloadFromStore();
  }

  // 14. Une prise inactive ne fabrique aucun raccord. Elle reste une icône
  // grise d'explication et conduit au réglage qui l'activerait.
  linkView = await readView(currentPayload);
  const visiblePaths = new Set($$('.advanced-node-overlay').map((node) => node.dataset.nodePath));
  const inactiveStage = linkView.stages.find((candidate) => {
    if (!visiblePaths.has(candidate.path) || candidate.uniqueId !== true) return false;
    const okActive = candidate.controls?.ok?.value === true
      || candidate.controls?.autoplay?.value === true;
    const homeActive = candidate.controls?.home?.value === true;
    return !okActive || !homeActive;
  });
  if (inactiveStage) {
    await selectGraphPath(inactiveStage.path);
    const inactivePort = $$('.advanced-node-overlay__ports button.is-inactive')[0] ?? null;
    const iconOnly = inactivePort?.textContent.trim() === '' && inactivePort?.querySelector('svg') !== null;
    inactivePort?.click();
    await settle();
    report.steps.push(step('graphe — une prise inactive reste une icône explicative vers les contrôles',
      (observed) => observed.iconeSeule && observed.reglageMontre && !observed.dialogue,
      {
        iconeSeule: iconOnly,
        reglageMontre: $1('.advanced-field[data-highlight="true"]') !== null,
        dialogue: $1('.advanced-dialog') !== null,
      }));
  } else {
    report.steps.push(step('graphe — un Écran visible porte une prise inactive explicative',
      (observed) => observed.trouve, { trouve: false }));
  }
}

export async function runWorkspaceParcours({ profile }) {
  await waitForDriver();
  // La première lecture peut encore être en vol au montage : attendre qu'un
  // payload soit lisible évite de mesurer l'installation au lieu du parcours.
  while (!driver().payload()) await settle();
  syncPayloadFromStore();

  const report = {
    runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-atelier-${profile}`,
    label: 'atelier-g1-05',
    profile,
    userAgent: navigator.userAgent,
    startedAt: new Date().toISOString(),
    steps: [],
    captures: [],
    storeWaits: 0,
  };
  try {
    await parcoursA(report);
    await parcoursB(report);
    await parcoursC(report);
    report.status = 'terminé';
  } catch (error) {
    report.status = 'interrompu';
    report.error = String(error?.message ?? error);
  }
  report.finishedAt = new Date().toISOString();
  // Le relevé dit si la fenêtre peignait réellement : un parcours mené sur des
  // minuteries reste exact, mais il n'a rien mesuré de l'affichage.
  report.framesSuspended = suspendedFrames;
  report.held = report.steps.every((row) => row.held);
  report.failed = report.steps.filter((row) => !row.held).map((row) => row.name);

  await fetch('/__bench/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  // Le verdict est aussi visible à l'écran : un parcours qui n'écrirait que
  // dans un fichier laisserait croire qu'il a réussi parce qu'il s'est terminé.
  const banner = document.createElement('p');
  banner.setAttribute('role', 'status');
  banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;margin:0;padding:8px 12px;'
    + `font:13px system-ui;color:#fff;background:${report.held ? '#1e5e3a' : '#7a2016'};z-index:9999`;
  banner.textContent = report.held
    ? `Parcours ${profile} : ${report.steps.length} pas tenus.`
    : `Parcours ${profile} : ${report.failed.length} pas non tenus — ${report.failed.join(', ')}`;
  document.body.append(banner);
  return report;
}
