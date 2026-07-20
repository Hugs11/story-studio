const INLINE_RENAME_TYPES = new Set(['menu', 'story']);

export function canInlineRenameTreeNode(type) {
  return INLINE_RENAME_TYPES.has(type);
}

export function getInlineRenameFields(originalName, draftName) {
  const nextName = String(draftName ?? '');
  return nextName === String(originalName ?? '') ? null : { name: nextName };
}
