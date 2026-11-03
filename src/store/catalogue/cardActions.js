import { trashAvailability } from './trashPlan.js';
import { checkerAvailability, isCheckablePack } from './duplicateModel.js';
// Commands retain explicit exemplar targets and permanent unavailability reasons.
// Card-wide editing asks when several exemplars exist; simulation asks when
// several are suitable. Generation enters a project’s native editor first.

import { dataActions } from './dataActions.js';
import { clipboardText, pathText } from './clipboardText.js';
import { CHOICE_POLICIES, choiceDecision } from './exemplarChoice.js';
import { containerName } from './formatTag.js';
import { simulationAvailability } from './simulationAvailability.js';


const LABELS = Object.freeze({
  openFiche: 'catalogue:actions.openFiche.label',
  edit: 'catalogue:actions.edit.label',
  openProject: 'catalogue:actions.openProject.label',
  editPack: 'catalogue:actions.editPack.label',
  simulate: 'catalogue:actions.simulate.label',
  openAndGenerate: 'catalogue:actions.openAndGenerate.label',
  reveal: 'catalogue:actions.reveal.label',
  copyUuid: 'catalogue:actions.copyUuid.label',
  copyTitle: 'catalogue:actions.copyTitle.label',
  checkPack: 'catalogue:diagnostics.checker',
});


function action(id, { enabled = true, reasonKey = null, reasonParams, hint = null, choice = false, labelKey = LABELS[id] } = {}) {
  return { id, labelKey, enabled, reasonKey: enabled ? null : reasonKey, ...(!enabled && reasonParams ? { reasonParams } : {}), hint, choice };
}

/** Raison d'une ouverture impossible pour un exemplaire. */
function editorAvailability(exemplar) { return simulationAvailability(exemplar); }

/**
 * Actions d'un exemplaire (menu contextuel, tableau des exemplaires, choix
 * d'exemplaire). Un projet s'ouvre dans son éditeur ; un pack se modifie par
 * le parcours « Modifier un pack ».
 */
export function exemplarActions(card, exemplar) {
  const open = exemplar.format === 'project'
    ? [
      action('openProject', editorAvailability(exemplar)),
      action('simulate', simulationAvailability(exemplar)),
      action('openAndGenerate', editorAvailability(exemplar)),
    ]
    : [
      action('editPack', editorAvailability(exemplar)),
      action('simulate', simulationAvailability(exemplar)),
    ];
  const archive = containerName(exemplar);
  const path = pathText(exemplar);
  const uuid = clipboardText('copyUuid', card, exemplar);
  return [
    ...open,
    action('checkPack', checkerAvailability(exemplar)),
    action('trash', { ...trashAvailability(exemplar), labelKey: 'catalogue:trash.title' }),
    // Un fichier disparu reste révélable : son dossier parent est ouvert.
    action('reveal', {
      enabled: path.enabled,
      reasonKey: path.reasonKey,
      hint: archive ? { key: 'catalogue:actions.reveal.archiveHint', params: { archive } } : null,
    }),
    action('copyUuid', { enabled: uuid.enabled, reasonKey: uuid.reasonKey }),
  ];
}

/**
 * « Simuler » au niveau d'une fiche (menu de la carte, fiche complète) : le
 * seul exemplaire qui convient est lancé directement (`exemplarId`) ;
 * plusieurs demandent le choix (`choice`) ; aucun : désactivé avec sa raison.
 */
export function simulateCommand(card, exemplars) {
  const decision = choiceDecision(exemplars, { policy: CHOICE_POLICIES.simulate, availability: simulationAvailability });
  if (decision.kind === 'unavailable') return action('simulate', { enabled: false, reasonKey: decision.reasonKey });
  if (decision.kind === 'direct') return { ...action('simulate'), exemplarId: decision.exemplarId };
  return action('simulate', { choice: true, labelKey: 'catalogue:actions.simulate.choose' });
}

/** Generation enters the native project editor, then its normal production command. */
export function generateCommand(card, exemplars) {
  const projects = (exemplars ?? []).filter(exemplar => exemplar.format === 'project');
  const decision = choiceDecision(projects, { policy: CHOICE_POLICIES.edit, availability: editorAvailability });
  return { ...action('openAndGenerate', { enabled: decision.kind !== 'unavailable', reasonKey: decision.reasonKey, choice: decision.kind === 'choose' }), exemplarId: decision.exemplarId ?? null, purpose: 'editAndGenerate' };
}

/**
 * Actions du menu contextuel d'une carte. Une action d'exemplaire ne vise
 * jamais implicitement « le plus récent » : avec plusieurs exemplaires, elle
 * demande d'abord lequel.
 * @param {Array} exemplars exemplaires présentés de la fiche
 */
export function cardMenuActions(card, exemplars) {
  const list = Array.isArray(exemplars) ? exemplars : [];
  const fileCommand = id => {
    const candidates = list.map(exemplar => ({ exemplar, action: exemplarActions(card, exemplar).find(item => item.id === id) }));
    const single = candidates.length === 1 ? candidates[0] : null;
    const enabled = candidates.some(item => item.action?.enabled);
    return { ...action(id, { enabled, choice: list.length > 1, reasonKey: candidates.find(item => item.action?.reasonKey)?.action.reasonKey ?? 'catalogue:actions.reason.noExemplar' }),
      ...(single ? { exemplarId: single.exemplar.id } : {}) };
  };
  const data = dataActions(card ? [card] : []);
  const uuid = clipboardText('copyUuid', card);
  return [
    simulateCommand(card, list),
    data.find(item => item.id === 'tags'),
    data.find(item => item.id === 'favorite'),
    fileCommand('reveal'),
    { ...action('edit'), ...editButton(card, list), labelKey: 'catalogue:fiche.inline.openEditor' },
    // Aucun exemplaire de format vérifiable (projet seul) : l'entrée n'a pas lieu d'être.
    ...(list.some(isCheckablePack) ? [fileCommand('checkPack')] : []),
    action('copyUuid', { enabled: uuid.enabled, reasonKey: uuid.reasonKey }),
    action('removeFromCatalogue', { labelKey: 'catalogue:actions.removeFromCatalogue.label' }),
  ];
}

/**
 * Bouton principal « Modifier » d'une carte ou d'une ligne : disponible selon l’état observé de ses exemplaires. `choice` dit déjà s'il demandera l'exemplaire (plusieurs cibles).
 */
export function editButton(card, exemplars) {
  const decision = choiceDecision(exemplars, { policy: CHOICE_POLICIES.edit, availability: editorAvailability });
  return { enabled: decision.kind !== 'unavailable', reasonKey: decision.reasonKey ?? null, choice: decision.kind === 'choose', exemplarId: decision.exemplarId ?? null };
}

/** Annonce après « Afficher dans l'explorateur » (repli sur le dossier parent expliqué). */
export function revealLine(result, path) {
  return result?.fallbackParentOpened
    ? { key: 'catalogue:actions.reveal.fallback', params: { path: path ?? '' } }
    : { key: 'catalogue:actions.reveal.done', params: {} };
}

/** Choix d’exemplaire partagé : chaque ligne conserve sa cible ; aucune cible implicite. */
export function exemplarChoices(card, exemplars, command = 'edit') {
  return exemplars.map((exemplar) => {
    const id = command === 'edit' ? (exemplar.format === 'project' ? 'openProject' : 'editPack') : command;
    return { key: `${exemplar.id}:${command}`, exemplar, action: exemplarActions(card, exemplar).find((item) => item.id === id) };
  });
}

/**
 * Entrées du menu ouvert, à plat (navigation au clavier sur toute la liste).
 * - `card` : actions de la fiche, ou, après une action à choix, les
 *   exemplaires candidats précédés d'un retour.
 * @returns {Array<{key: string, exemplar: object|null, action: object, back?: boolean}>}
 */
export function menuEntries(menu, card, exemplars) {
  if (!menu?.open || !card) return [];
  const list = Array.isArray(exemplars) ? exemplars : [];
  if (menu.step) {
    const back = { key: 'back', exemplar: null, back: true, action: { id: 'back', labelKey: 'catalogue:menu.back.label', enabled: true, reasonKey: null, hint: null } };
    return [back, ...exemplarChoices(card, list, menu.step.action)];
  }
  return cardMenuActions(card, list).map((item) => ({
    key: item.id,
    exemplar: item.exemplarId ? list.find((exemplar) => exemplar.id === item.exemplarId) ?? null : null,
    action: item,
  }));
}

/** Une action de ligne ne doit jamais se rabattre sur une autre version. */
export function ficheOpenRequest(card, command, revision, returnFocusId = null) {
  const exemplar = command.exemplarId ? card.exemplars.find(item => item.id === command.exemplarId) : null;
  if (command.exemplarId && !exemplar) throw { code: 'CATALOG_TARGET_REVISION_STALE' };
  return { card, exemplar, revision, returnFocusId };
}
