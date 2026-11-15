import { formatLufs, formatPeak, formatSeconds } from './packCheckerFormat.js';
import { translateChecker as t } from '../../i18n/checkerPresentation.js';
import { checkerDecimalSeparator } from '../../i18n/checkerPresentation.js';
import { isRustMessageCode, presentUserMessage } from '../../i18n/userMessage.js';

export function isGraphEditorInformation(issue) {
  return issue?.code === 'CHECKER_AUTHORING_CLASSIFICATION_REFUSED';
}

export function isMissingPackTitle(issue) {
  return issue?.code === 'CHECKER_STORY_FIELD_MISSING' && issue.messageParams?.field === 'title';
}

// La validation du document et celle du nom signalent le même titre absent.
export function reportDisplayIssues(report) {
  const issues = report?.issues || [];
  const hasTitleIssue = issues.some((issue) => issue.code === 'CHECKER_PACK_TITLE_EMPTY');
  return issues.filter((issue) => !hasTitleIssue || !isMissingPackTitle(issue)).map((issue) =>
    isMissingPackTitle(issue) ? { ...issue, category: 'title', code: 'CHECKER_PACK_TITLE_EMPTY',
      message: presentUserMessage({ code: 'CHECKER_PACK_TITLE_EMPTY', params: {} }).message } : issue);
}

export function reportStructureOk(report) {
  const issues = report?.issues || [];
  const structural = issues.filter((issue) => issue.category === 'structure'
    && !isGraphEditorInformation(issue) && ['error', 'warning'].includes(issue.severity));
  return Boolean(report?.structureSummary?.luniiCompatible)
    || (structural.length > 0 && structural.every(isMissingPackTitle));
}

export function reportHasBlockingVerdict(report) {
  const issues = report?.issues || [];
  return report?.verdict === 'invalid' && (!issues.some(isMissingPackTitle)
    || issues.some((issue) => issue.severity === 'error' && issue.category !== 'title' && !isMissingPackTitle(issue)));
}

// Les mesures rédigées par le moteur suivent la même notation que les tableaux.
export function issueDisplayText(issue, field = 'message') {
  if (isGraphEditorInformation(issue)) return field === 'technicalDetails' ? '' : t('checker:structure.graphEditor');
  const text = String(issue?.[field] || '').replace(/([.!?])\s*,\s*/g, '$1 ');
  return issue?.category === 'audio'
    ? text.replace(/(-?\d+)[.,](\d+)(?=\s*(?:%|s\b|LUFS\b|dBTP\b|dB\b|kHz\b|(?:à|to|a)\s+-?\d))/g, `$1${checkerDecimalSeparator()}$2`)
    : text;
}

export function issueRoleLabel(record) {
  const role = record.item?.itemType || record.issue?.itemType;
  if (isRustMessageCode(role)) return presentUserMessage({ code: role, params: {} }).message;
  switch (record.issue?.category || record.kind) {
    case 'title': return t('checker:summary.packName.title');
    case 'structure': return t('checker:summary.structure.title');
    case 'audio': return role && role !== 'audio' ? role : t('checker:file.role.audio');
    case 'image': return role && role !== 'image' ? role : t('checker:file.role.image');
    default: return t('checker:file.label.fallback');
  }
}

export function issueDisplaySeverity(issue) {
  if (isGraphEditorInformation(issue)) return 'info';
  return issue?.autoFixAvailable && issue.fixDisposition !== 'optional' ? 'warning' : issue?.severity;
}

// Un seul calcul pour le bandeau, le verdict et les exports. Le nom du pack
// demande une saisie : son compte reste distinct des corrections automatiques.
export function reportPresentationCounts(report) {
  const issues = reportDisplayIssues(report).filter((issue) =>
    !isGraphEditorInformation(issue) && ['error', 'warning'].includes(issue.severity));
  const countFiles = (predicate) => new Set(issues.filter(predicate).map((issue) =>
    issue.filePath || `${issue.category}:${issue.code}:${issue.label}:${issue.message}`)).size;
  return {
    automatic: issues.filter((issue) => issue.category !== 'title' && issue.fixDisposition === 'automatic').length,
    optional: optionalSilenceIssues(report).length,
    assisted: countFiles((issue) => issue.category === 'title'),
    listen: countFiles((issue) => issue.category === 'audio' && !issue.autoFixAvailable),
    review: countFiles((issue) => issue.category !== 'audio' && issue.category !== 'title' && !issue.autoFixAvailable),
  };
}
const SILENCE_ISSUE_CODES = Object.freeze({
  leadingShort: 'audioLeadingSilenceTooShort',
  trailingShort: 'audioTrailingSilenceTooShort',
  leadingLong: 'audioLeadingSilenceLong',
  trailingLong: 'audioTrailingSilenceLong',
});

const SHORT_CODES = new Set([
  SILENCE_ISSUE_CODES.leadingShort,
  SILENCE_ISSUE_CODES.trailingShort,
]);

const LONG_CODES = new Set([
  SILENCE_ISSUE_CODES.leadingLong,
  SILENCE_ISSUE_CODES.trailingLong,
]);

export function isAutomaticSilenceIssue(issue) {
  return issue?.category === 'audio'
    && issue?.fixDisposition === 'automatic'
    && SHORT_CODES.has(issue?.code);
}

export function isOptionalSilenceIssue(issue) {
  return issue?.category === 'audio'
    && issue?.severity === 'info'
    && issue?.fixDisposition === 'optional'
    && LONG_CODES.has(issue?.code);
}

export function isAutomaticVolumeIssue(issue) {
  return issue?.category === 'audio'
    && issue?.autoFixAvailable === true
    && ['CHECKER_AUDIO_VOLUME', 'CHECKER_AUDIO_NEAR_MUTE'].includes(issue?.code);
}

export function silenceEdgeForIssue(issue) {
  if (issue?.code === SILENCE_ISSUE_CODES.leadingShort || issue?.code === SILENCE_ISSUE_CODES.leadingLong) {
    return 'leading';
  }
  if (issue?.code === SILENCE_ISSUE_CODES.trailingShort || issue?.code === SILENCE_ISSUE_CODES.trailingLong) {
    return 'trailing';
  }
  return null;
}

export function optionalSilenceIssues(report) {
  return (report?.issues || []).filter(isOptionalSilenceIssue);
}

export function optionalSilenceSelectionKey(issueOrSelection) {
  const edge = issueOrSelection?.edge || silenceEdgeForIssue(issueOrSelection);
  return edge && issueOrSelection?.filePath ? `${issueOrSelection.filePath}\u0000${edge}` : '';
}

export function serializeOptionalSilenceSelection(report, selectedKeys) {
  const keys = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  return optionalSilenceIssues(report)
    .map((issue) => ({ filePath: issue.filePath, edge: silenceEdgeForIssue(issue) }))
    .filter((selection) => keys.has(optionalSilenceSelectionKey(selection)));
}

export function packCorrectionCounts(report) {
  return {
    automatic: report?.correctionsAvailable ?? 0,
    optional: report?.optionalCorrectionsAvailable ?? optionalSilenceIssues(report).length,
  };
}

export function categoryConformanceStats(summary) {
  const total = summary?.total ?? 0;
  const conforming = Math.min(total, (summary?.ok ?? 0) + (summary?.infos ?? 0));
  return {
    total,
    ok: conforming,
    needsFix: Math.max(0, total - conforming),
  };
}

export function automaticCorrectionCount(record) {
  const scopedIssues = record?.sectionIssues?.length
    ? record.sectionIssues
    : (record?.issues || []);
  return scopedIssues.filter((issue) => issue.fixDisposition === 'automatic').length;
}

const MEASURE_CODES = {
  format: ['CHECKER_AUDIO_FORMAT', 'CHECKER_AUDIO_CHANNELS'],
  sampleRate: ['CHECKER_AUDIO_SAMPLE_RATE'],
  silenceStart: ['audioLeadingSilenceTooShort', 'audioLeadingSilenceLong', 'CHECKER_AUDIO_LEADING_UNMEASURABLE'],
  silenceEnd: ['audioTrailingSilenceTooShort', 'audioTrailingSilenceLong', 'CHECKER_AUDIO_TRAILING_UNMEASURABLE'],
  volume: ['CHECKER_AUDIO_VOLUME', 'CHECKER_AUDIO_NEAR_MUTE', 'CHECKER_AUDIO_VOLUME_UNMEASURABLE'],
  peak: ['CHECKER_AUDIO_CLIPPED', 'CHECKER_AUDIO_VOLUME'],
  dimensions: ['CHECKER_IMAGE_DIMENSIONS', 'CHECKER_IMAGE_FORMAT_DIMENSIONS'],
  imageFormat: ['CHECKER_IMAGE_FORMAT', 'CHECKER_IMAGE_FORMAT_DIMENSIONS'],
};
export function issueHasMeasure(issue, key) {
  const category = ['dimensions', 'imageFormat'].includes(key) ? 'image' : 'audio';
  return issue?.category === category && (MEASURE_CODES[key] ?? []).includes(issue?.code);
}
export function hasMeasureIssue(issues, key) {
  return (issues ?? []).some((issue) => issueHasMeasure(issue, key));
}
export function isAudioFormatIssue(issue) {
  return issue?.autoFixAvailable && (issueHasMeasure(issue, 'format') || issueHasMeasure(issue, 'sampleRate'));
}
export function isSaturatedIssue(issue) { return issue?.category === 'audio' && issue?.code === 'CHECKER_AUDIO_CLIPPED'; }

export function measuredIssueSummary(issue, item, kind) {
  const message = issueDisplayText(issue);
  if (kind === 'audio') {
    if (issueHasMeasure(issue, 'silenceStart') || issueHasMeasure(issue, 'silenceEnd')) {
      const sides = silenceSummaryParts([issue], item);
      return sides.length ? sides.join(' | ') : message;
    }
    if (issueHasMeasure(issue, 'volume') && issue.code !== 'CHECKER_AUDIO_NEAR_MUTE') {
      return volumeSummary(item?.integratedLufs);
    }
    if (issueHasMeasure(issue, 'sampleRate')) {
      return t('checker:summary.sampleRate.incorrect', { value: item?.sampleRate ? `${item.sampleRate} Hz` : t('checker:summary.value.unmeasured') });
    }
    if (issue.code === 'CHECKER_AUDIO_CHANNELS' && issue.category === 'audio') {
      return t('checker:summary.channels.notMono', { value: item?.channels || t('checker:summary.channels.unmeasured') });
    }
    if (issueHasMeasure(issue, 'format')) {
      return t('checker:summary.audioFormat.incorrect', { value: item?.codec || t('checker:summary.format.unmeasured') });
    }
  }
  if (kind === 'image') {
    const dimensions = item?.width && item?.height ? `${item.width}×${item.height}` : t('checker:summary.dimensions.unmeasured');
    const format = item?.format || t('checker:summary.format.unmeasured');
    if (issueHasMeasure(issue, 'imageFormat')) return t('checker:summary.imageFormat.incorrect', { value: format });
    if (issueHasMeasure(issue, 'dimensions')) return t('checker:summary.dimensions.incorrect', { value: dimensions });
    return t('checker:summary.image.incorrect', { dimensions, format });
  }
  return message;
}

// Sens du niveau lu sur la mesure (seuil -10 LUFS), jamais sur le texte du message.
export function volumeSummary(lufs) {
  return typeof lufs === 'number' && lufs > -10
    ? t('checker:summary.volume.high', { value: formatLufs(lufs) })
    : t('checker:summary.volume.low', { value: formatLufs(lufs) });
}

// Fichier saturé : crête mesurée, ou source seule quand la mesure manque.
export function saturatedSummary(peak) {
  return typeof peak === 'number' ? t('checker:summary.saturated.peak', { value: formatPeak(peak) }) : t('checker:summary.saturated.source');
}

export function silenceSummaryParts(issues, item) {
  const hasStart = issues.some((issue) => {
    if (silenceEdgeForIssue(issue) === 'leading') return true;
    return issueHasMeasure(issue, 'silenceStart');
  });
  const hasEnd = issues.some((issue) => (
    silenceEdgeForIssue(issue) === 'trailing'
    || issueHasMeasure(issue, 'silenceEnd')
  ));
  const parts = [];
  if (hasStart) parts.push(t('checker:summary.silenceStart.value', { value: formatSeconds(item?.leadingSilenceSecs) }));
  if (hasEnd) parts.push(t('checker:summary.silenceEnd.value', { value: formatSeconds(item?.trailingSilenceSecs) }));
  return parts;
}
