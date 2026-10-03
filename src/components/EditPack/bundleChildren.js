/**
 * Les règles de l'écran de choix d'une archive enveloppe, séparées de son
 * rendu : ce qui est sélectionnable, ce qu'on peut continuer, et comment un
 * verdict se dit à l'auteur.
 *
 * Ces règles ne jugent rien par elles-mêmes. Le verdict vient du classifieur
 * Rust, le même que pour un pack déposé seul ; ici on ne fait que le présenter.
 */
import { presentImportError } from './importErrorPresentation.js';

/** Ce que le backend rend comme verdict d'un enfant. */
export const BUNDLE_CHILD_STATUS = {
  editable: 'editable',
  readOnly: 'read-only',
  unsupported: 'unsupported',
  error: 'error',
};

const VERDICT_LABELS = {
  [BUNDLE_CHILD_STATUS.editable]: 'Modifiable',
  [BUNDLE_CHILD_STATUS.readOnly]: 'Lecture seule',
  [BUNDLE_CHILD_STATUS.unsupported]: 'Non supporté',
  [BUNDLE_CHILD_STATUS.error]: 'Illisible',
};

export function isChildSelectable(child) {
  return !!child && child.selectable === true;
}

export function selectableChildren(children) {
  return (children ?? []).filter(isChildSelectable);
}

/**
 * Continuer n'est actif qu'avec un enfant sélectionné, et seulement si cet
 * enfant est toujours celui que la liste propose. Une liste rafraîchie ne doit
 * pas laisser une ancienne sélection ouvrir un pack qui n'y est plus.
 */
export function canContinueWithChild(children, selectedChildId) {
  if (!selectedChildId) return false;
  return selectableChildren(children).some((child) => child.childId === selectedChildId);
}

/** Le verdict tel qu'il s'affiche, et la raison quand elle apporte quelque chose. */
const REASON_CONTEXTS = {
  [BUNDLE_CHILD_STATUS.readOnly]: 'readOnly',
  [BUNDLE_CHILD_STATUS.unsupported]: 'unsupported',
};

export function describeChildVerdict(child) {
  const status = child?.status ?? BUNDLE_CHILD_STATUS.error;
  const rawReason = status === BUNDLE_CHILD_STATUS.editable ? '' : (child?.reason ?? '');
  // Le motif du classifieur est un diagnostic : l'auteur lit le message
  // public, le texte brut reste consultable en infobulle.
  const presented = rawReason
    ? presentImportError(rawReason, REASON_CONTEXTS[status] ?? 'open')
    : { message: '', technicalDetail: '' };
  return {
    status,
    label: VERDICT_LABELS[status] ?? VERDICT_LABELS[BUNDLE_CHILD_STATUS.error],
    reason: presented.message,
    technicalDetail: presented.technicalDetail,
  };
}

/** Taille lisible, sans dépendance : un ordre de grandeur suffit pour choisir. */
export function formatChildSize(sizeBytes) {
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * L'avancement de l'examen, borné et monotone à l'affichage : un évènement
 * tardif ou hors bornes ne doit pas faire reculer la barre ni la faire sortir
 * de [0, 1].
 */
export function inspectionProgressRatio(done, total) {
  const doneCount = Number(done);
  const totalCount = Number(total);
  if (!Number.isFinite(totalCount) || totalCount <= 0) return null;
  if (!Number.isFinite(doneCount) || doneCount < 0) return 0;
  return Math.min(1, doneCount / totalCount);
}
