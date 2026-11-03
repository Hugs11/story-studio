import { formatLufs, formatPeak, formatSeconds } from './packCheckerFormat.js';
import { translateChecker as t } from '../../i18n/checkerPresentation.js';
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
  const message = issue.message || '';
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
