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

export function getImageJobTargetLabel(context = null, projectIndex = null) {
  const explicitLabel = fromContextLabel(context);
  const fieldId = typeof context?.fieldId === 'string'
    ? context.fieldId
    : (typeof context?.regenerateJob?.fieldId === 'string' ? context.regenerateJob.fieldId : '');
  if (!fieldId) return explicitLabel;

  if (fieldId === 'root:coverImage') return 'Menu racine - image Lunii + catalogue';
  if (fieldId === 'root:rootImage') return 'Menu racine - image Lunii';
  if (fieldId === 'root:thumbnailImage') return 'Menu racine - vignette catalogue';

  const homeStepSuffix = ':homeStep:image';
  if (fieldId.endsWith(homeStepSuffix)) {
    const entryId = fieldId.slice(0, -homeStepSuffix.length);
    return `${getEntryName(projectIndex, entryId, 'Histoire')} - image reaction Accueil`;
  }

  if (fieldId.startsWith('stage:') && fieldId.endsWith(':image')) {
    const stageId = fieldId.slice('stage:'.length, -':image'.length);
    return `Graphe natif - stage ${stageId || '?'}`;
  }

  const [entryId, field] = fieldId.split(':');
  if (field === 'itemImage') {
    return `${getEntryName(projectIndex, entryId, 'Histoire')} - image de selection`;
  }
  if (field === 'image') {
    return `${getEntryName(projectIndex, entryId, 'Dossier')} - image du dossier`;
  }

  return explicitLabel || fieldId;
}
