import { KEYS } from '../persistentSettings.js';

export const LIST_COLUMNS = Object.freeze([
  { id: 'cover', labelKey: 'catalogue:details.column.cover', defaultWidth: 56 },
  { id: 'title', labelKey: 'catalogue:details.column.title', defaultWidth: 240 },
  { id: 'age', labelKey: 'catalogue:details.column.age', defaultWidth: 110 },
  { id: 'duration', labelKey: 'catalogue:details.column.duration', defaultWidth: 90 },
  { id: 'formats', labelKey: 'catalogue:details.column.formats', defaultWidth: 140 },
  { id: 'tags', labelKey: 'catalogue:tags.title', defaultWidth: 180 },
  { id: 'summary', labelKey: 'catalogue:details.column.summary', defaultWidth: 300 },
  { id: 'stories', labelKey: 'catalogue:details.column.stories', defaultWidth: 100 },
  { id: 'language', labelKey: 'catalogue:details.column.language', defaultWidth: 100 },
  { id: 'author', labelKey: 'catalogue:details.column.author', defaultWidth: 160 },
  { id: 'producer', labelKey: 'catalogue:fiche.edit.field.producer', defaultWidth: 160 },
  { id: 'bonus', labelKey: 'catalogue:fiche.edit.field.bonus', defaultWidth: 180 },
]);

export const CATALOGUE_COLUMNS = Object.freeze({
  columns: LIST_COLUMNS,
  widthsKey: KEYS.CATALOGUE_COL_WIDTHS,
  visibleKey: KEYS.CATALOGUE_VISIBLE_COLS,
  defaultVisible: ['cover', 'title', 'age', 'duration', 'formats', 'tags', 'language', 'author', 'producer', 'bonus'],
  required: ['title'],
});
