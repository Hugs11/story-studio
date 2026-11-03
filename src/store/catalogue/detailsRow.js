// Cellules présentées d'une fiche (vue Détails, vue Liste, fiche complète) et
// d'un exemplaire (tableau des exemplaires, menus). Chaque cellule est typée :
// - `text` : donnée de l'utilisateur, affichée telle quelle, jamais traduite ;
// - `line` : clé de traduction et paramètres ;
// - `date` / `bytes` : valeur localisée à l'affichage ;
// - `missing` : « — » (une donnée absente n'est jamais inventée).

import { descriptionText } from './descriptionText.js';
import { exemplarStateLabelKey, formatLabelKey } from './labels.js';
import { baseName, containerName, parentPath } from './formatTag.js';

export const NOT_PROVIDED = Object.freeze({ kind: 'missing', key: 'catalogue:details.value.notProvided', params: {} });

export function textCell(value) {
  return typeof value === 'string' && value.trim() ? { kind: 'text', value } : NOT_PROVIDED;
}

function line(key, params = {}) {
  return { kind: 'line', key, params };
}

/** Âge présenté : tranche, borne seule, inconnu (« — ») ou invalide. */
export function ageCell(age) {
  return Number.isInteger(age?.min) && age.min >= 0
    ? line('catalogue:details.age.from', { count: age.min }) : NOT_PROVIDED;
}

/** Durée en minutes arrondies ; seulement une valeur publiée par le moteur. */
export function durationCell(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return NOT_PROVIDED;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return line('catalogue:details.duration.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60
    ? line('catalogue:details.duration.hoursMinutes', { count: hours, minutes: String(minutes % 60).padStart(2, '0') })
    : line('catalogue:details.duration.hours', { count: hours });
}

export function storiesCell(count) {
  return Number.isInteger(count) && count >= 0 ? line('catalogue:details.stories.count', { count }) : NOT_PROVIDED;
}

export function versionCell(version) {
  return Number.isInteger(version) ? line('catalogue:details.version.value', { version }) : NOT_PROVIDED;
}

export function dateCell(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0 ? { kind: 'date', value: timestamp } : NOT_PROVIDED;
}

export function bytesCell(bytes) {
  return Number.isInteger(bytes) && bytes >= 0 ? { kind: 'bytes', value: bytes } : NOT_PROVIDED;
}

/**
 * Cellules d'une fiche pour les vues Liste et Détails. Version et date sont
 * celles de l'exemplaire représentatif (le même pour les trois vues).
 */
export function detailsRow(card, representative = null) {
  return {
    id: card.id,
    title: textCell(card.displayTitle ?? card.title),
    titleMissing: !card.title,
    summary: textCell(descriptionText(card.description)),
    age: ageCell(card.age),
    language: textCell(card.language),
    duration: durationCell(card.durationSeconds),
    stories: storiesCell(card.storyCount),
    author: textCell(card.author),
    producer: textCell(card.producer),
    bonus: textCell(card.bonus),
    version: versionCell(representative?.versionDeclared ?? null),
    modifiedAt: dateCell(representative?.modifiedAt ?? null),
  };
}

/**
 * Ligne d'un exemplaire : format, nom, dossier (ou archive), version, date,
 * taille et état. Le chemin complet reste consultable (fiche, infobulle).
 */
export function exemplarRow(exemplar) {
  const archive = containerName(exemplar);
  return {
    id: exemplar.id,
    format: exemplar.format,
    formatKey: formatLabelKey(exemplar.format),
    name: textCell(exemplar.fileName ?? baseName(exemplar.path)),
    // Un enfant d'archive se situe par son archive, pas par un dossier.
    folder: archive ? line('catalogue:exemplar.location.inArchive', { archive }) : textCell(parentPath(exemplar.namedPath ?? exemplar.path)),
    path: textCell(exemplar.path),
    member: exemplar.member ? textCell(exemplar.member) : null,
    version: versionCell(exemplar.versionDeclared),
    modifiedAt: dateCell(exemplar.modifiedAt),
    size: bytesCell(exemplar.sizeBytes),
    state: line(exemplar.available ? 'catalogue:exemplar.state.available' : exemplarStateLabelKey(exemplar.state === 'available' ? 'unavailable' : exemplar.state)),
    available: exemplar.available,
  };
}
