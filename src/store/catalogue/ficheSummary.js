import { durationCell, storiesCell } from './detailsRow.js';
import { representativeExemplar } from './pipeline.js';

/** Header figures always belong to the newest version, without older-value fallback. */
export function latestExemplarFigures(card) {
  const latest = representativeExemplar(card.exemplars ?? []);
  return [storiesCell(latest?.storyCount), durationCell(latest?.durationSeconds)]
    .filter(value => value.kind !== 'missing');
}

/** Card metadata uses the newest exemplar, even when its duration is absent. */
export function latestExemplarDuration(card) {
  return durationCell(representativeExemplar(card.exemplars ?? [])?.durationSeconds);
}

