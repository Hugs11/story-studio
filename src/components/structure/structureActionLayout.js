export const STRUCTURE_ACTIONS_COMPACT_WIDTH = 300;

export function partitionStructureActions(actions, {
  variant = 'floating',
  inlineSize = null,
} = {}) {
  const compact = variant === 'panel'
    && (!Number.isFinite(inlineSize) || inlineSize < STRUCTURE_ACTIONS_COMPACT_WIDTH);

  if (!compact) {
    return {
      directActions: actions,
      overflowActions: [],
    };
  }

  return {
    directActions: actions.filter((action) => action.priority === 'primary'),
    overflowActions: actions.filter((action) => action.priority !== 'primary'),
  };
}
