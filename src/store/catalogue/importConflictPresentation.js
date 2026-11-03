// Presentation only; all matching and merge decisions remain in Rust.
export function importFieldLabel(t, field) {
  const labels = {
    title: t('catalogue:fiche.edit.field.title'), description: t('catalogue:fiche.edit.field.description'),
    versionDeclared: t('catalogue:fiche.edit.field.versionDeclared'), cover: t('catalogue:fiche.edit.field.cover'),
    ageMin: t('catalogue:fiche.edit.field.ageMin'), ageMax: t('catalogue:fiche.edit.field.ageMax'),
    language: t('catalogue:fiche.edit.field.language'), author: t('catalogue:fiche.edit.field.author'),
    producer: t('catalogue:fiche.edit.field.producer'), bonus: t('catalogue:fiche.edit.field.bonus'),
    keywords: t('catalogue:fiche.edit.field.keywords'), durationSeconds: t('catalogue:fiche.edit.field.durationSeconds'),
    storyCount: t('catalogue:fiche.edit.field.storyCount'),
  };
  return labels[field] ?? t('catalogue:details.value.notProvided');
}
export function importKindLabel(t, kind, key = '') {
  switch (kind) {
    case 'ageRange': case 'pendingAgeRange': return t('catalogue:backupImport.ageRange');
    case 'membership': return t('catalogue:backupImport.membershipLabel');
    case 'reconcile': return t('catalogue:backupImport.reconcileLabel');
    case 'corrections': case 'pendingCorrections':
    case 'referenceValues': case 'pendingLuniiValue': return importFieldLabel(t, key.split(':')[0]);
    case 'favorite': case 'pendingFavorite': return t('catalogue:backupImport.favoriteLabel');
    case 'referenceBundle': case 'pendingReferenceBundle': return t('catalogue:backupImport.referenceLabel');
    case 'forgotten': case 'pendingForgotten': return t('catalogue:backupImport.forgottenLabel');
    case 'tag': return t('catalogue:backupImport.tagLabel');
    case 'group': return t('catalogue:backupImport.groupLabel');
    case 'convergence': return t('catalogue:backupImport.convergenceLabel');
    default: return t('catalogue:backupImport.details');
  }
}
// Why a conflict is excluded from the global choice (`individualChoiceReason`).
export function importIndividualChoiceNotice(t, reason) {
  switch (reason) {
    case 'ageInterval': return t('catalogue:backupImport.ageIntervalChoice');
    case 'forgetRefused': return t('catalogue:backupImport.coveredForgetting');
    default: return t('catalogue:backupImport.activeReferenceReplacement');
  }
}
function scalar(t, value) {
  if (value === null || value === undefined) return t('catalogue:details.value.notProvided');
  if (typeof value === 'boolean') return value ? t('catalogue:backupImport.yes') : t('catalogue:backupImport.no');
  if (Array.isArray(value)) return value.map(v => scalar(t, v)).join(', ');
  if (typeof value === 'object') return t('catalogue:backupImport.imageIncluded');
  return String(value);
}
export function importValueLines(t, kind, value, local = false) {
  if (['favorite', 'pendingFavorite', 'forgotten', 'pendingForgotten'].includes(kind)) return [value ? t('catalogue:backupImport.yes') : t('catalogue:backupImport.no')];
  if (kind === 'membership') return [scalar(t, value.label), t('catalogue:toolbar.count.fiches', { count: value.count })];
  if (kind === 'reconcile') return [t('catalogue:backupImport.reconcileLabel')];
  if (['ageRange', 'pendingAgeRange'].includes(kind)) return ['ageMin', 'ageMax'].flatMap(field => value[field] ? importValueLines(t, 'corrections', value[field], local) : []);
  if (value?.values) return [local && typeof value.source === 'string' ? t('catalogue:backupImport.referenceLabel') : t('catalogue:backupImport.referenceUnavailable'), ...value.values.flatMap(row => importValueLines(t, 'corrections', row, local))];
  if (value?.field) {
    const content = value.state === 'cleared' ? t('catalogue:fiche.edit.mode.cleared')
      : value.state === 'source' ? t('catalogue:fiche.edit.mode.source')
        : value.imageSha256 ? t('catalogue:backupImport.imageIncluded') : scalar(t, value.value);
    const field = importFieldLabel(t, value.field);
    return [value.language ? t('catalogue:backupImport.fieldLanguageValue', { field, language: value.language, value: content })
      : t('catalogue:backupImport.fieldValue', { field, value: content })];
  }
  if (kind === 'group') return [value === false ? t('catalogue:backupImport.no') : t('catalogue:backupImport.groupMembers', { members: value.members.length })];
  if (kind === 'convergence') return [t('catalogue:backupImport.identityValue', { uuid: value.packUuid })];
  return [scalar(t, value)];
}
