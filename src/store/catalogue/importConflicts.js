// Conflict decisions are valid only for the exact values reviewed by the user.
export const conflictFingerprint = conflict => JSON.stringify([conflict.target, conflict.local, conflict.incoming]);
export function conflictChoice(state, conflict) {
  const saved = state.choices[conflict.id];
  return saved?.fingerprint === conflictFingerprint(conflict) ? saved.choice : conflict.target.requiresIndividualChoice ? 'local' : state.globalChoice;
}
export function reusableChoices(choices, conflicts) {
  return Object.fromEntries(conflicts.filter(c => choices[c.id]?.fingerprint === conflictFingerprint(c)).map(c => [c.id, choices[c.id]]));
}
export function choicePayload(state, conflicts) {
  return Object.fromEntries(conflicts.map(c => [c.id, conflictChoice(state, c)]));
}
