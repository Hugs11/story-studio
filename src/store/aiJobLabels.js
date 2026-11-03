import { aiRef, presentAi } from '../i18n/aiPresentation.js';
function getEntryName(projectIndex, entryId, fallback) {
  const entry = projectIndex?.entryById?.get?.(entryId);
  const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
  return name || fallback;
}

function fromContextLabel(context) {
  const label = typeof context?.targetLabel === 'string' ? context.targetLabel.trim() : '';
  if (label) return label;
  const regeneratedLabel = typeof context?.regenerateJob?.targetLabel === 'string'
    ? context.regenerateJob.targetLabel.trim()
    : '';
  if (regeneratedLabel) return regeneratedLabel;
  const imageLabel = typeof context?.currentImageLabel === 'string' ? context.currentImageLabel.trim() : '';
  return imageLabel && imageLabel !== 'image actuelle' ? imageLabel : '';
}

export function getImageJobTargetRef(context = null, projectIndex = null) {
  const explicitLabel = context?.targetLabelRef ?? context?.regenerateJob?.targetLabelRef ?? fromContextLabel(context);
  const fieldId = typeof context?.fieldId === 'string'
    ? context.fieldId
    : (typeof context?.regenerateJob?.fieldId === 'string' ? context.regenerateJob.fieldId : '');
  if (!fieldId) return explicitLabel;

  if (fieldId === 'root:coverImage') return aiRef("ai:target.root.cover");
  if (fieldId === 'root:rootImage') return aiRef("ai:target.root.image");
  if (fieldId === 'root:thumbnailImage') return aiRef("ai:target.root.thumbnail");

  const homeStepSuffix = ':homeStep:image';
  if (fieldId.endsWith(homeStepSuffix)) {
    const entryId = fieldId.slice(0, -homeStepSuffix.length);
    return aiRef("ai:target.story.home", { name: getEntryName(projectIndex, entryId, aiRef("ai:target.node.story")) });
  }

  if (fieldId.startsWith('stage:') && fieldId.endsWith(':image')) {
    const stageId = fieldId.slice('stage:'.length, -':image'.length);
    return aiRef("ai:target.stage.image", { id: stageId || "?" });
  }

  const [entryId, field] = fieldId.split(':');
  if (field === 'itemImage') {
    return aiRef("ai:target.story.selection", { name: getEntryName(projectIndex, entryId, aiRef("ai:target.node.story")) });
  }
  if (field === 'image') {
    return aiRef("ai:target.folder.image", { name: getEntryName(projectIndex, entryId, aiRef("ai:target.node.folder")) });
  }

  return explicitLabel || fieldId;
}

// Compatibilité des consommateurs purs : traduction au moment de la lecture.
export function getImageJobTargetLabel(context = null, projectIndex = null) {
  return presentAi(getImageJobTargetRef(context, projectIndex));
}
