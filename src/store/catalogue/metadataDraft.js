/* This Source Code Form is subject to the Mozilla Public License, v. 2.0.
 * https://mozilla.org/MPL/2.0/
 * Contracts/cases adapted from STUdio Perso utils/overridesDraft.js and tests:
 * three states, explicit reset, keep user edits when rebasing. No bulk copy.
 */
import { fieldId } from './cardModel.js';
const NUMERIC = new Set(['ageMin', 'ageMax', 'versionDeclared', 'storyCount']);
export function valueText(field, value) {
  if (value == null) return '';
  if (field === 'durationSeconds') return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  if (field === 'keywords') return Array.isArray(value) ? value.join(', ') : String(value);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function entry(field) {
  return { field: field.field, language: field.language ?? '', state: ['defined', 'cleared'].includes(field.correction.state) ? field.correction.state : 'source',
    sourceValue: field.referenceValue?.value ?? field.derived?.value ?? (!['correction', 'cleared'].includes(field.effective.origin) ? field.effective.value : null),
    value: valueText(field.field, field.correction.value), effective: field.effective.value, referenceValue: field.referenceValue?.value ?? null };
}
export function createDraft(card) {
  const original = Object.fromEntries(card.fields.map(f => [fieldId(f), entry(f)]));
  return { ficheId: card.ficheId, ficheRevision: card.ficheRevision, catalogueRevision: card.catalogueRevision, original, entries: structuredClone(original), conflicts: {} };
}
function same(a, b) { return a?.state === b?.state && (a?.state !== 'defined' || (String(a.value).trim() === String(b.value).trim() && a.coverStagingId === b.coverStagingId)); }
export function dirtyDraft(draft) { return !!draft && Object.entries(draft.entries).some(([id, value]) => !same(value, draft.original[id])); }
export function durationValue(text) { const match = /^(\d+):([0-5]\d)$/.exec(text.trim()); return match ? Number(match[1]) * 60 + Number(match[2]) : NaN; }
export function validateDraft(draft, { singleAge = false } = {}) {
  const errors = {};
  for (const [id, e] of Object.entries(draft?.entries ?? {})) {
    if (e.state !== 'defined') continue;
    const raw = e.value.trim();
    let valid = !!raw;
    if (NUMERIC.has(e.field)) valid = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= 2147483647 && (e.field !== 'storyCount' || Number(raw) > 0);
    else if (e.field === 'durationSeconds') valid = Number.isSafeInteger(durationValue(raw)) && durationValue(raw) > 0 && durationValue(raw) <= 2147483647;
    else if (e.field === 'language') valid = /^[a-z]{2,3}$/.test(raw);
    else if (e.field === 'cover') valid = !!e.coverStagingId || same(e, draft.original[id]);
    else if (e.field === 'keywords') valid = raw.split(',').length <= 100 && raw.split(',').every(v => v.trim().length > 0 && v.trim().length <= 200);
    else valid = valid && [...raw].length <= (e.field === 'description' ? 20000 : 2000);
    if (singleAge && e.field === 'ageMin') valid = valid && Number(raw) <= 18;
    if (!valid) errors[id] = 'catalogue:fiche.edit.invalid';
  }
  const age = field => {
    const e = draft.entries[fieldId({ field })];
    return e?.state === 'cleared' ? null : e?.state === 'defined' ? Number(e.value) : e?.referenceValue;
  };
  if (!singleAge && draft && age('ageMin') != null && age('ageMax') != null && age('ageMin') > age('ageMax')) {
    errors[fieldId({ field: 'ageMin' })] = 'catalogue:fiche.edit.ageInterval';
    errors[fieldId({ field: 'ageMax' })] = 'catalogue:fiche.edit.ageInterval';
  }
  return errors;
}
export function draftChanges(draft, { singleAge = false } = {}) {
  const changes = Object.entries(draft.entries).filter(([id, e]) => !same(e, draft.original[id])).map(([, e]) => {
    const change = { field: e.field, ...(e.language ? { language: e.language } : {}), state: e.state };
    if (e.state === 'defined') {
      if (e.field === 'cover') change.coverStagingId = e.coverStagingId;
      else change.value = NUMERIC.has(e.field) ? Number(e.value) : e.field === 'durationSeconds' ? durationValue(e.value) : e.field === 'keywords' ? e.value.split(',').map(v => v.trim()) : e.value.trim();
    }
    return change;
  });
  if (!singleAge && changes.some(c => c.field === 'ageMin' || c.field === 'ageMax')) {
    for (const field of ['ageMin', 'ageMax']) {
      if (!changes.some(c => c.field === field)) {
        const e = draft.entries[fieldId({ field })];
        changes.push({ field, state: e.state, ...(e.state === 'defined' ? { value: Number(e.value) } : {}) });
      }
    }
  }
  return changes;
}
export function mergeDraft(draft, card) {
  const next = createDraft(card);
  for (const [id, ours] of Object.entries(draft.entries)) {
    const inherited = { field: ours.field, language: ours.language, state: 'source', value: '', effective: null, referenceValue: null };
    const old = draft.original[id] ?? inherited;
    const theirs = next.original[id] ?? inherited;
    next.original[id] = theirs;
    next.entries[id] = theirs;
    if (same(ours, old)) continue;
    next.entries[id] = ours;
    if ((!same(old, theirs) || JSON.stringify(old?.referenceValue) !== JSON.stringify(theirs?.referenceValue) || JSON.stringify(old?.effective) !== JSON.stringify(theirs?.effective)) && !same(ours, theirs)) next.conflicts[id] = { ours, theirs };
    if (draft.conflicts[id] && !next.conflicts[id]) next.conflicts[id] = draft.conflicts[id];
  }
  return next;
}
export function draftReducer(state, action) {
  if (action.type === 'load') return !state || state.ficheId !== action.card.ficheId ? createDraft(action.card) : mergeDraft(state, action.card);
  if (action.type === 'saved') return createDraft(action.card);
  if (!state) return state;
  if (action.type === 'edit') return { ...state, entries: { ...state.entries, [action.id]: { ...state.entries[action.id], ...action.patch } } };
  if (action.type === 'conflict') {
    const conflicts = { ...state.conflicts }; delete conflicts[action.id];
    return { ...state, conflicts, entries: { ...state.entries, [action.id]: action.keep === 'server' ? state.original[action.id] : state.entries[action.id] } };
  }
  if (action.type === 'addLanguage' && /^[a-z]{2,3}$/.test(action.language)) {
    const entries = { ...state.entries }; const original = { ...state.original };
    for (const field of ['title', 'description', 'bonus', 'keywords']) {
      const id = fieldId({ field, language: action.language });
      if (!entries[id]) entries[id] = original[id] = { field, language: action.language, state: 'source', value: '', effective: null, referenceValue: null };
    }
    return { ...state, entries, original };
  }
  return state;
}

// Same protection for a close button, Escape and departure to simulation.
export async function protectDraft(draft, { busy = false, ask, save }) {
  if (busy) return false;
  if (!dirtyDraft(draft)) return true;
  const choice = await ask();
  return choice === 'discard' || (choice === 'save' && await save());
}

// Shared by dialog buttons and exemplar/tag menus before leaving the card.
export async function beforeFicheAbandon(guard, action) {
  if (!guard.current || await guard.current()) return action();
}
