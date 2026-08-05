export const SILENCE_ISSUE_CODES = Object.freeze({
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
