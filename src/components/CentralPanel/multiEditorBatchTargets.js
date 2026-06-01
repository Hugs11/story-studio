export function isTextImageBatchTarget(node) {
  if (!node) return false;
  if (node.type === 'story') return true;
  if (node.type === 'menu') return !node.autoBlackImage;
  return false;
}

export function blocksTextImageBatchAction(node) {
  if (!node) return false;
  if (node.type === 'zip') return false;
  if (node.type === 'menu') return !!node.autoBlackImage;
  return !isTextImageBatchTarget(node);
}

export function getTextImageBatchTargets(nodes) {
  return nodes.filter(isTextImageBatchTarget);
}

export function canShowTextImageBatchAction(nodes) {
  return getTextImageBatchTargets(nodes).length > 0
    && !nodes.some(blocksTextImageBatchAction);
}
