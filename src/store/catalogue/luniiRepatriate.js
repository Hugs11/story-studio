import { luniiWriteRefusal } from './luniiDevices.js';

/** A Lunii story can be brought back only when it is a listed creation the catalogue does not hold yet. */
export const repatriableStory = story => !story.orphan && !story.sending && story.kind !== 'official' && !story.catalogueFicheId;

/**
 * What dropping (or choosing) these stories for repatriation would do: how many
 * qualify and, when none does, why. `refusal` is `write` (device refuses, see
 * `writeCode`), `official`, `present` (already in the catalogue) or `orphan`.
 */
export function repatriatePlan(device, stories) {
  const eligible = stories.filter(repatriableStory);
  const writeCode = luniiWriteRefusal(device, 'repatriateMany');
  let refusal = null;
  if (writeCode) refusal = 'write';
  else if (!eligible.length) {
    refusal = stories.some(s => s.kind === 'official') ? 'official' : stories.some(s => !s.orphan && s.catalogueFicheId) ? 'present' : 'orphan';
  }
  return { eligible: refusal ? [] : eligible, total: stories.length, refusal, writeCode };
}
