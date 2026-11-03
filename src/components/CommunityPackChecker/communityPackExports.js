import { presentCheckerReport } from '../../i18n/checkerMessages.js';
import { measuredIssueSummary, saturatedSummary, silenceSummaryParts, volumeSummary } from './packCheckerIssueClassification.js';
import { getIntlLocale } from '../../i18n/language.js';
import { translateChecker as t } from '../../i18n/checkerPresentation.js';
import {
  audioMeasureRows,
  cleanLabel,
  expectedImageOk,
  formatLufs,
  formatSeconds,
  imageMeasureRows,
  isConforming,
  structureConforming,
  titleConforming,
} from './packCheckerFormat.js';
import { formatPackAudioEdgeSilence } from '../../config/audioProcessing.js';
import {
  issueHasMeasure,
  isAudioFormatIssue,
  isSaturatedIssue,
  hasMeasureIssue as hasMeasureIssues,
  automaticCorrectionCount,
  categoryConformanceStats,
  isAutomaticSilenceIssue,
  isAutomaticVolumeIssue,
  isOptionalSilenceIssue,
  packCorrectionCounts,
} from './packCheckerIssueClassification.js';

// Tous les libellés sont résolus à l'export, dans la langue active au clic.
function severityLabel(severity) {
  switch (severity) {
    case 'error':
      return t('checker:severity.error.label');
    case 'warning':
      return t('checker:severity.warning.label');
    case 'info':
      return t('checker:severity.info.label');
    case 'ok':
      return t('checker:severity.ok.label');
    default:
      return severity || t('checker:severity.info.label');
  }
}

function verdictLabel(verdict) {
  switch (verdict) {
    case 'valid':
      return t('checker:verdict.conform.title');
    case 'validWithWarnings':
      return t('checker:report.verdict.warnings');
    case 'needsFix':
      return t('checker:report.verdict.needsFix');
    case 'invalid':
      return t('checker:report.verdict.invalid');
    default:
      return t('checker:report.pack.analyzed');
  }
}

// Phrase du catalogue portant des balises <strong> nommées : tout est échappé,
// puis seules ces balises sont rétablies.
function richHtml(text) {
  return escapeHtml(text).replace(/&lt;(\/?)strong&gt;/g, '<$1strong>');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function html(strings, ...values) {
  return strings.reduce((output, chunk, index) => (
    `${output}${chunk}${values[index] ?? ''}`
  ), '');
}

const ICONS = {
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M10 14h4"/><path d="M10 18h2"/></svg>',
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L5 21"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 1 0 9 7.4A8.5 8.5 0 1 1 12 3z"/></svg>',
  network: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M12 8v4"/><path d="M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/></svg>',
  package: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5"/><path d="M12 12v9"/></svg>',
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 10 18H2z"/><path d="M12 9v5"/><path d="M12 18h.01"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.8-2.8z"/></svg>',
};

function icon(name) {
  return ICONS[name] || ICONS.info;
}

function hasMeasureIssue(issues, key) {
  return hasMeasureIssues(issues, key);
}

function itemMap(report) {
  const map = new Map();
  for (const item of report?.audioItems || []) map.set(item.filePath, { kind: 'audio', item });
  for (const item of report?.imageItems || []) map.set(item.filePath, { kind: 'image', item });
  return map;
}

function issuesByFilePath(report) {
  const map = new Map();
  for (const issue of report?.issues || []) {
    if (!issue.filePath) continue;
    if (!map.has(issue.filePath)) map.set(issue.filePath, []);
    map.get(issue.filePath).push(issue);
  }
  return map;
}

function uniqueIssueKey(issue) {
  return issue.filePath || `${issue.category}:${issue.code ?? ''}:${issue.label}`;
}

// Clés de présentation ; le classement reste porté par category/code (`match`).
const PROBLEM_SECTIONS = [
  {
    id: 'quality',
    titleKey: 'checker:issue.saturated.title',
    badgeKey: 'checker:issue.badge.source',
    bucket: 'listen',
    icon: 'warning',
    actionKey: 'checker:issue.saturated.exportAction',
    match: (issue) => (
      issue.category === 'audio'
      && !issue.autoFixAvailable
      && isSaturatedIssue(issue)
    ),
  },
  {
    id: 'listen',
    titleKey: 'checker:issue.listen.title',
    badgeKey: 'checker:issue.badge.manual',
    bucket: 'listen',
    icon: 'info',
    actionKey: 'checker:issue.listen.action',
    match: (issue) => !isOptionalSilenceIssue(issue) && !issue.autoFixAvailable && issue.category !== 'structure' && issue.category !== 'title',
  },
  {
    id: 'silence',
    titleKey: 'checker:issue.silence.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    icon: 'wrench',
    actionKey: 'checker:issue.silence.action',
    match: isAutomaticSilenceIssue,
  },
  {
    id: 'optionalSilence',
    titleKey: 'checker:issue.optionalSilence.title',
    badgeKey: 'checker:issue.badge.optional',
    bucket: 'optional',
    icon: 'info',
    actionKey: 'checker:issue.optionalSilence.exportAction',
    match: isOptionalSilenceIssue,
  },
  {
    id: 'volume',
    titleKey: 'checker:issue.volume.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    icon: 'audio',
    actionKey: 'checker:issue.volume.action',
    match: isAutomaticVolumeIssue,
  },
  {
    id: 'audioFormat',
    titleKey: 'checker:issue.audioFormat.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    icon: 'wrench',
    actionKey: 'checker:issue.audioFormat.action',
    match: isAudioFormatIssue,
  },
  {
    id: 'image',
    titleKey: 'checker:issue.imageCorrection.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    icon: 'image',
    actionKey: 'checker:issue.image.action',
    match: (issue) => issue.autoFixAvailable && issue.category === 'image',
  },
  {
    id: 'title',
    titleKey: 'checker:issue.packName.title',
    badgeKey: 'checker:issue.badge.assisted',
    bucket: 'fix',
    icon: 'file',
    actionKey: 'checker:issue.packName.exportAction',
    match: (issue) => issue.category === 'title',
  },
  {
    id: 'structure',
    titleKey: 'checker:issue.structure.title',
    badgeKey: 'checker:issue.badge.manual',
    bucket: 'listen',
    icon: 'network',
    actionKey: 'checker:issue.structure.action',
    match: (issue) => issue.category === 'structure',
  },
];

function buildProblemGroups(report) {
  if (!report) return [];
  const byFile = issuesByFilePath(report);
  const files = itemMap(report);
  const used = new Set();
  const relevantIssues = (report.issues || []).filter((issue) => (
    issue.severity === 'error' || issue.severity === 'warning' || isOptionalSilenceIssue(issue)
  ));

  return PROBLEM_SECTIONS.map((section) => {
    const records = [];
    const seen = new Set();
    for (const issue of relevantIssues) {
      if (used.has(issue) || !section.match(issue)) continue;
      used.add(issue);
      const key = section.id === 'optionalSilence'
        ? `${uniqueIssueKey(issue)}:${issue.code}`
        : uniqueIssueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      const fileIssues = issue.filePath ? (byFile.get(issue.filePath) || [issue]) : [issue];
      const fileEntry = issue.filePath ? files.get(issue.filePath) : null;
      records.push({
        id: `${section.id}:${key}`,
        issue,
        issues: fileIssues,
        sectionIssues: fileIssues.filter((candidate) => section.match(candidate)),
        item: fileEntry?.item || null,
        kind: fileEntry?.kind || issue.category,
      });
    }
    return {
      ...section,
      records,
      count: records.length,
      fixCount: section.id === 'title'
        ? records.length
        : records.reduce((sum, record) => sum + automaticCorrectionCount(record), 0),
      optionalCount: section.id === 'optionalSilence' ? records.length : 0,
    };
  }).filter((group) => group.count > 0);
}

function recordProblemSummary(record) {
  const scopedIssues = record.sectionIssues?.length ? record.sectionIssues : [record.issue];
  if (record.kind === 'audio') {
    if (scopedIssues.some((issue) => isSaturatedIssue(issue))) {
      return saturatedSummary(record.item?.truePeakDb);
    }
    const silenceIssues = scopedIssues.filter((issue) => (issueHasMeasure(issue, 'silenceStart') || issueHasMeasure(issue, 'silenceEnd')));
    if (silenceIssues.length > 0) {
      const parts = silenceSummaryParts(silenceIssues, record.item);
      if (parts.length > 0) return parts.join(' | ');
    }
    if (scopedIssues.some((issue) => (issueHasMeasure(issue, 'volume') && issue.code !== 'CHECKER_AUDIO_NEAR_MUTE'))) {
      return volumeSummary(record.item?.integratedLufs);
    }
  }
  if (record.kind === 'image') {
    return scopedIssues.map((issue) => measuredIssueSummary(issue, record.item, record.kind)).filter(Boolean).join(' · ');
  }
  return scopedIssues.map((issue) => measuredIssueSummary(issue, record.item, record.kind)).filter(Boolean).join(' · ');
}

function saturatedFileCount(groups) {
  return groups
    .filter((group) => group.id === 'quality')
    .reduce((sum, group) => sum + group.count, 0);
}

function summarizeGroups(groups, report) {
  const listenCount = groups
    .filter((group) => group.bucket === 'listen')
    .reduce((sum, group) => sum + group.count, 0);
  const fixCount = groups
    .filter((group) => group.bucket === 'fix')
    .reduce((sum, group) => sum + group.fixCount, 0);
  const optionalCount = groups
    .filter((group) => group.bucket === 'optional')
    .reduce((sum, group) => sum + group.optionalCount, 0);
  const saturatedCount = saturatedFileCount(groups);
  const hasBlocking = report?.verdict === 'invalid' || groups.some((group) => (
    group.bucket === 'listen' && group.records.some((record) => record.issue.severity === 'error')
  ));

  const verdict = (tone, icon, titleKey, subtitleKey, count) => ({
    tone, icon, title: t(titleKey, { count }), subtitle: t(subtitleKey), listenCount, fixCount, optionalCount,
  });
  if (!groups.length) return verdict('ok', 'check', 'checker:verdict.conform.title', 'checker:verdict.conform.subtitle');
  if (hasBlocking) return verdict('listen', 'warning', 'checker:verdict.blocking.title', 'checker:verdict.blocking.subtitle');
  if (saturatedCount > 0) {
    return fixCount > 0
      ? verdict('quality', 'warning', 'checker:verdict.saturatedFixable.title', 'checker:verdict.saturatedFixable.subtitle')
      : verdict('quality', 'warning', 'checker:verdict.saturated.title', 'checker:verdict.saturated.subtitle');
  }
  if (listenCount > 0) return verdict('listen', 'info', 'checker:verdict.listen.title', 'checker:verdict.listen.subtitle', listenCount);
  if (fixCount === 0 && listenCount === 0 && optionalCount > 0) {
    return verdict('ok', 'check', 'checker:verdict.optional.title', 'checker:verdict.optional.subtitle', optionalCount);
  }
  return verdict('fix', 'wrench', 'checker:verdict.fixable.title', 'checker:verdict.fixable.subtitle');
}

function fileSummary(kind, item) {
  if (kind === 'audio') {
    return t('checker:conform.audio.summary', { leading: formatSeconds(item?.leadingSilenceSecs), trailing: formatSeconds(item?.trailingSilenceSecs), loudness: formatLufs(item?.integratedLufs) });
  }
  const dimensions = item?.width && item?.height ? `${item.width}×${item.height}` : t('checker:conform.dimensions.unknown');
  return `${dimensions} · ${item?.format || t('checker:conform.format.unknown')}`;
}

function roleLabel(kind) {
  if (kind === 'audio') return t('checker:file.role.audio');
  if (kind === 'image') return t('checker:file.role.image');
  return t('checker:file.label.fallback');
}

function measureRowsHtml(rows, badKeys = new Set(), infoKeys = new Set()) {
  return rows.map((row) => {
    const status = infoKeys.has(row.key) ? 'info' : (badKeys.has(row.key) ? 'bad' : 'ok');
    return html`<div class="measure measure--${status}">
      <span>${icon(status === 'bad' ? 'warning' : (status === 'info' ? 'info' : 'check'))}${escapeHtml(row.label)}</span>
      <strong>${escapeHtml(row.value)}</strong>
    </div>`;
  }).join('');
}

function recordDetailHtml(record) {
  const item = record.item;
  let rows = [];
  if (record.kind === 'audio') rows = audioMeasureRows(item);
  else if (record.kind === 'image') rows = [...imageMeasureRows(item), { key: 'expected', label: t('checker:detail.expected.label'), value: '320×240' }];
  else rows = [{ key: 'category', label: t('checker:detail.category.label'), value: record.issue.category || t('checker:severity.info.label') }];
  const scopedIssues = record.sectionIssues?.length ? record.sectionIssues : record.issues;
  const flaggedKeys = new Set(rows.filter((row) => hasMeasureIssue(scopedIssues, row.key)).map((row) => row.key));
  const optional = record.issue.fixDisposition === 'optional';
  const badKeys = optional ? new Set() : flaggedKeys;
  const infoKeys = optional ? flaggedKeys : new Set();
  return html`<div class="tech-detail">
    <div>
      <div class="tech-title">${escapeHtml(t('checker:detail.measures.title'))}</div>
      ${measureRowsHtml(rows, badKeys, infoKeys)}
    </div>
    <div>
      <div class="tech-title">${escapeHtml(t('checker:detail.proposed.title'))}</div>
      ${(record.sectionIssues?.length ? record.sectionIssues : record.issues).map((issue) => html`<div class="tech-action">
        ${icon(issue.autoFixAvailable ? 'wrench' : 'info')}
        <div>
          <strong>${escapeHtml(issue.autoFixDescription || issue.message)}</strong>
          ${issue.technicalDetails ? `<span>${escapeHtml(issue.technicalDetails)}</span>` : ''}
        </div>
      </div>`).join('')}
    </div>
  </div>`;
}

function problemGroupHtml(group, open = false) {
  return html`<details class="group group--${group.bucket} group--${group.id}" ${open ? 'open' : ''}>
    <summary class="group-head">
      <span class="group-icon">${icon(group.icon)}</span>
      <span class="group-copy">
        <span class="group-title-row">
          <strong>${escapeHtml(t(group.titleKey))}</strong>
          <span class="group-badge">${escapeHtml(t(group.badgeKey))}</span>
        </span>
        <span>${escapeHtml(t(group.actionKey, { duration: formatPackAudioEdgeSilence() }))}</span>
      </span>
      <span class="group-count"><strong>${group.count}</strong><small>${escapeHtml(group.bucket === 'optional' ? t('checker:group.count.suggestions', { count: group.count }) : t('checker:group.count.files', { count: group.count }))}</small></span>
    </summary>
    <div class="group-body">
      <div class="mini-list">
        ${group.records.map((record) => {
          const firstIssue = record.issue;
          return html`<details class="mini-file">
            <summary class="mini-file-row">
              <span class="role">${escapeHtml(roleLabel(record.kind))}</span>
              <span class="mini-name" title="${escapeHtml(firstIssue.filePath || firstIssue.label)}">${escapeHtml(cleanLabel(firstIssue.label))}</span>
              <span class="mini-problem">${escapeHtml(recordProblemSummary(record))}</span>
              <span class="mini-severity mini-severity--${escapeHtml(firstIssue.severity)}">${escapeHtml(severityLabel(firstIssue.severity))}</span>
            </summary>
            ${recordDetailHtml(record)}
          </details>`;
        }).join('')}
      </div>
    </div>
  </details>`;
}

function buildConformingGroups(report) {
  if (!report) return [];
  const groups = [];
  const audioFiles = (report.audioItems || []).filter((item) => isConforming(item.status));
  if (audioFiles.length) {
    groups.push({
      id: 'audio',
      title: t('checker:conform.audio.title'),
      subtitle: t('checker:conform.audio.subtitle'),
      icon: 'audio',
      mode: 'files',
      kind: 'audio',
      files: audioFiles,
      metricStrong: String(audioFiles.length),
      metricSmall: t('checker:group.count.files', { count: audioFiles.length }),
    });
  }
  const imageFiles = (report.imageItems || []).filter((item) => isConforming(item.status));
  if (imageFiles.length) {
    groups.push({
      id: 'image',
      title: t('checker:conform.images.title'),
      subtitle: t('checker:conform.images.subtitle'),
      icon: 'image',
      mode: 'files',
      kind: 'image',
      files: imageFiles,
      metricStrong: String(imageFiles.length),
      metricSmall: t('checker:group.count.files', { count: imageFiles.length }),
    });
  }
  if (titleConforming(report)) {
    groups.push({
      id: 'title',
      title: t('checker:summary.packName.title'),
      subtitle: t('checker:conform.packName.subtitle'),
      icon: 'file',
      mode: 'facts',
      metricStrong: t('checker:summary.packName.valid'),
      metricSmall: t('checker:summary.packName.conventionOk'),
      facts: [
        { key: 'name', label: t('checker:conform.fact.name'), value: report.packName || '—' },
        { key: 'title', label: t('checker:conform.fact.title'), value: report.packTitle || '—' },
        { key: 'version', label: t('home:packName.version.label'), value: String(report.packVersion ?? '—') },
      ],
    });
  }
  if (structureConforming(report)) {
    const structure = report.structureSummary || {};
    groups.push({
      id: 'structure',
      title: t('checker:summary.structure.title'),
      subtitle: t('checker:conform.structure.subtitle'),
      icon: 'network',
      mode: 'facts',
      metricStrong: t('checker:summary.structure.correct'),
      metricSmall: t('checker:summary.structure.steps', { count: structure.stageCount ?? 0 }),
      facts: [
        { key: 'lunii', label: t('checker:conform.fact.lunii'), value: structure.luniiCompatible ? t('checker:fact.value.yes') : t('checker:fact.value.no') },
        { key: 'editable', label: t('checker:conform.fact.editable'), value: structure.storyStudioEditable ? t('checker:fact.value.yes') : t('checker:fact.value.no') },
        { key: 'stories', label: t('checker:conform.fact.stories'), value: String(structure.storyCount ?? 0) },
        { key: 'stages', label: t('checker:conform.fact.stages'), value: String(structure.stageCount ?? 0) },
        { key: 'actions', label: t('checker:conform.fact.actions'), value: String(structure.actionCount ?? 0) },
        { key: 'refAudio', label: t('checker:conform.fact.refAudio'), value: String(structure.referencedAudioCount ?? 0) },
        { key: 'refImage', label: t('checker:conform.fact.refImage'), value: String(structure.referencedImageCount ?? 0) },
      ],
    });
  }
  const nightDetected = Boolean(report.nightMode?.detected);
  groups.push({
    id: 'night',
    title: t('checker:summary.nightMode.title'),
    subtitle: nightDetected ? t('checker:conform.nightMode.detected') : t('checker:conform.nightMode.absent'),
    icon: 'moon',
    mode: 'facts',
    metricStrong: nightDetected ? t('checker:summary.nightMode.available') : t('checker:summary.nightMode.absent'),
    metricSmall: t('checker:summary.nightMode.notBlocking'),
    facts: [
      { key: 'detected', label: t('checker:summary.nightMode.title'), value: nightDetected ? t('checker:summary.nightMode.available') : t('checker:summary.nightMode.absent') },
      { key: 'blocking', label: t('checker:conform.fact.blocking'), value: t('checker:fact.value.no') },
    ],
  });
  return groups;
}

function conformingGroupHtml(group, open = false) {
  return html`<details class="group group--ok group--${group.id}" ${open ? 'open' : ''}>
    <summary class="group-head">
      <span class="group-icon">${icon(group.icon)}</span>
      <span class="group-copy">
        <span class="group-title-row">
          <strong>${escapeHtml(group.title)}</strong>
          <span class="group-badge">${escapeHtml(t('checker:conform.badge'))}</span>
        </span>
        <span>${escapeHtml(group.subtitle)}</span>
      </span>
      <span class="group-count"><strong>${escapeHtml(group.metricStrong)}</strong><small>${escapeHtml(group.metricSmall)}</small></span>
    </summary>
    <div class="group-body">
      ${group.mode === 'files' ? html`<div class="mini-list">
        ${group.files.map((item) => {
          const rows = group.kind === 'audio'
            ? audioMeasureRows(item)
            : [...imageMeasureRows(item), { key: 'expected', label: t('checker:detail.expected.label'), value: expectedImageOk(item) ? '320×240' : '320×240' }];
          return html`<details class="mini-file">
            <summary class="mini-file-row">
              <span class="role">${escapeHtml(roleLabel(group.kind))}</span>
              <span class="mini-name" title="${escapeHtml(item.filePath || item.label)}">${escapeHtml(cleanLabel(item.label))}</span>
              <span class="mini-problem">${escapeHtml(fileSummary(group.kind, item))}</span>
              <span class="mini-severity mini-severity--ok">${escapeHtml(t('checker:severity.ok.label'))}</span>
            </summary>
            <div class="tech-detail tech-detail--facts">
              <div>
                <div class="tech-title">${escapeHtml(t('checker:detail.measures.title'))}</div>
                ${measureRowsHtml(rows)}
              </div>
            </div>
          </details>`;
        }).join('')}
      </div>` : html`<div class="tech-detail tech-detail--facts">
        <div>
          <div class="tech-title">${escapeHtml(t('checker:detail.facts.title'))}</div>
          ${measureRowsHtml(group.facts)}
        </div>
      </div>`}
    </div>
  </details>`;
}

function summaryTileHtml({ title, iconName, tone, strong, small, split }) {
  return html`<div class="summary-tile summary-tile--${tone}">
    <div class="summary-head">${icon(iconName)}<span>${escapeHtml(title)}</span></div>
    ${split ? html`<div class="split-stat">
      <span class="split-ok">${richHtml(t('checker:summary.split.ok', { value: split.ok }))}</span>
      <span class="split-fix ${split.needsFix === 0 ? 'is-clean' : ''}">${richHtml(t('checker:summary.split.fix', { value: split.needsFix }))}</span>
    </div>` : html`<div class="single-stat"><strong>${escapeHtml(strong)}</strong><span>${escapeHtml(small)}</span></div>`}
  </div>`;
}

function reportStyles() {
  // eslint-disable-next-line i18next/no-literal-string -- Formats et I/O : feuille CSS de l'export, sans prose.
  return `
    :root {
      color-scheme: light;
      --bg0: #f3f6fb;
      --bg1: #ffffff;
      --bg2: #f7f9fc;
      --bg3: #edf2f7;
      --text: #1f2430;
      --muted: #748095;
      --border: #dfe6ef;
      --borderLt: #cfd8e7;
      --success-bg: #e8f7ee;
      --success-border: #76c795;
      --success-text: #21824b;
      --warning-bg: #fff5d8;
      --warning-border: #e3b84a;
      --warning-text: #9a6b00;
      --danger-bg: #ffe9e9;
      --danger-border: #f19a9a;
      --danger-text: #b03636;
      --listen-bg: #efedff;
      --listen-border: #aaa3f2;
      --listen-text: #6157cf;
      --font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #edf1f7 0, #f8fafc 280px);
      color: var(--text);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.45;
    }
    svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2;
    }
    .document {
      width: min(1040px, calc(100vw - 32px));
      margin: 24px auto 36px;
      overflow: hidden;
      border: 1px solid var(--borderLt);
      border-radius: 12px;
      background: var(--bg1);
      box-shadow: 0 24px 70px rgba(37, 45, 64, 0.15);
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .drop-icon,
    .report-orb,
    .group-icon {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      border: 1px solid #9b8fec;
      border-radius: 9px;
      background: #efeaff;
      color: #695bd6;
    }
    .drop-icon { width: 34px; height: 34px; }
    .modal-title strong { display: block; font-size: 14px; font-weight: 750; }
    .modal-title span {
      display: block;
      max-width: 760px;
      overflow: hidden;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .print-button {
      flex: 0 0 auto;
      padding: 7px 12px;
      border: 1px solid var(--borderLt);
      border-radius: 8px;
      background: var(--bg2);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 650;
    }
    .print-button:hover { border-color: #9b8fec; background: #f1edff; }
    .report { display: flex; flex-direction: column; min-width: 0; }
    .report-verdict {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      padding: 16px 18px;
      border-bottom: 1px solid var(--border);
    }
    .report-verdict--ok .report-orb { background: var(--success-bg); border-color: var(--success-border); color: var(--success-text); }
    .report-verdict--fix .report-orb { background: var(--warning-bg); border-color: var(--warning-border); color: var(--warning-text); }
    .report-verdict--listen .report-orb { background: var(--listen-bg); border-color: var(--listen-border); color: var(--listen-text); }
    .report-verdict--quality .report-orb { background: var(--danger-bg); border-color: var(--danger-border); color: var(--danger-text); }
    .report-orb { width: 40px; height: 40px; border-radius: 999px; }
    .report-copy { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
    .pack-name {
      overflow: hidden;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .report-copy strong { font-size: 16px; line-height: 1.15; }
    .report-copy span:not(.pack-name) { color: var(--muted); font-size: 12px; }
    .report-callout {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 0 0 auto;
      padding: 7px 12px;
      border: 1px solid var(--listen-border);
      border-radius: 8px;
      background: var(--listen-bg);
      font-size: 12px;
    }
    .report-callout svg { color: var(--listen-text); }
    .summary-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      padding: 14px 18px 0;
    }
    .summary-tile {
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg2);
    }
    .summary-tile--ok { border-color: var(--success-border); background: var(--success-bg); }
    .summary-tile--fix { border-color: var(--warning-border); background: var(--warning-bg); }
    .summary-tile--listen { border-color: var(--listen-border); background: var(--listen-bg); }
    .summary-tile--danger { border-color: var(--danger-border); background: var(--danger-bg); }
    .summary-head {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 750;
    }
    .summary-head svg { width: 15px; height: 15px; }
    .summary-tile--ok .summary-head { color: var(--success-text); }
    .summary-tile--fix .summary-head { color: var(--warning-text); }
    .summary-tile--listen .summary-head { color: var(--listen-text); }
    .summary-tile--danger .summary-head { color: var(--danger-text); }
    .split-stat {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 8px;
    }
    .split-stat span,
    .single-stat {
      min-width: 0;
      padding: 7px 8px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.58);
      color: var(--muted);
      font-size: 10px;
      line-height: 1.2;
    }
    .split-stat strong,
    .single-stat strong {
      color: var(--text);
      font-family: var(--mono);
      font-size: 15px;
      line-height: 1;
    }
    .split-ok strong,
    .split-fix.is-clean strong { color: var(--success-text); }
    .split-fix strong { color: var(--warning-text); }
    .single-stat {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
    }
    .single-stat span {
      min-width: 0;
      overflow: hidden;
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty,
    .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 14px 18px 0;
      color: var(--success-text);
      font-size: 12px;
      font-weight: 750;
    }
    .empty {
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--bg2);
      font-weight: 500;
    }
    .groups {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 18px;
    }
    .group {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg1);
      page-break-inside: avoid;
    }
    .group[open] { background: var(--bg2); }
    .group--fix[open] { border-color: var(--warning-border); }
    .group--listen[open] { border-color: var(--listen-border); }
    .group--quality[open] { border-color: var(--danger-border); }
    .group--optional[open] { border-color: var(--success-border); }
    .group--ok[open] { border-color: var(--success-border); }
    .group-head {
      display: flex;
      align-items: center;
      gap: 13px;
      min-width: 0;
      padding: 13px 14px;
      cursor: pointer;
      list-style: none;
    }
    .group-head::-webkit-details-marker,
    .mini-file-row::-webkit-details-marker { display: none; }
    .group-icon { width: 40px; height: 40px; border-radius: 10px; }
    .group--listen .group-icon,
    .group--listen .group-badge { background: var(--listen-bg); color: var(--listen-text); border-color: var(--listen-border); }
    .group--fix .group-icon,
    .group--fix .group-badge { background: var(--warning-bg); color: var(--warning-text); border-color: var(--warning-border); }
    .group--quality .group-icon,
    .group--quality .group-badge { background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger-border); }
    .group--optional .group-icon,
    .group--optional .group-badge { background: var(--success-bg); color: var(--success-text); border-color: var(--success-border); }
    .group--ok .group-icon,
    .group--ok .group-badge { background: var(--success-bg); color: var(--success-text); border-color: var(--success-border); }
    .group-copy {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .group-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .group-title-row strong {
      overflow: hidden;
      font-size: 14px;
      font-weight: 750;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-title-row + span { color: var(--muted); font-size: 12px; line-height: 1.35; }
    .group-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 0 8px;
      border: 1px solid;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 750;
      white-space: nowrap;
    }
    .group-count {
      display: flex;
      align-items: flex-end;
      flex: 0 0 auto;
      flex-direction: column;
      gap: 1px;
      min-width: 54px;
    }
    .group-count strong { font-family: var(--mono); font-size: 22px; line-height: 1; }
    .group--fix .group-count strong { color: var(--warning-text); }
    .group--listen .group-count strong { color: var(--listen-text); }
    .group--quality .group-count strong { color: var(--danger-text); }
    .group--optional .group-count strong { color: var(--success-text); }
    .group--ok .group-count strong { color: var(--success-text); }
    .group-count small { color: var(--muted); font-size: 10px; }
    .group-body { padding: 0 14px 12px; }
    .mini-file { border-top: 1px solid var(--border); }
    .mini-file-row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-width: 0;
      padding: 8px 4px;
      cursor: pointer;
      list-style: none;
    }
    .role {
      flex: 0 0 auto;
      padding: 2px 5px;
      border-radius: 4px;
      background: var(--bg3);
      color: var(--muted);
      font-size: 9px;
      font-weight: 750;
      text-transform: uppercase;
    }
    .mini-name {
      flex: 1 1 34%;
      min-width: 0;
      overflow: hidden;
      font-size: 12px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mini-problem {
      flex: 1.2 1 42%;
      min-width: 150px;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mini-severity {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 10px;
      font-weight: 750;
    }
    .mini-severity--error { color: var(--danger-text); }
    .mini-severity--warning { color: var(--warning-text); }
    .mini-severity--ok { color: var(--success-text); }
    .tech-detail {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 2px 28px;
      margin: 2px 0 12px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg1);
    }
    .tech-detail--facts { grid-template-columns: 1fr; }
    .tech-title {
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 750;
      text-transform: uppercase;
    }
    .measure {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      padding: 4px 0;
      border-bottom: 1px solid var(--border);
    }
    .measure span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .measure svg { width: 12px; height: 12px; }
    .measure--ok svg { color: var(--success-text); }
    .measure--bad svg { color: var(--danger-text); }
    .measure--info svg { color: var(--success-text); }
    .measure strong {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 650;
    }
    .tech-action {
      display: flex;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px solid var(--border);
    }
    .tech-action svg {
      width: 14px;
      height: 14px;
      margin-top: 1px;
      color: #695bd6;
    }
    .tech-action div {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .tech-action strong { font-size: 12px; font-weight: 650; }
    .tech-action span { color: var(--muted); font-size: 10px; line-height: 1.35; }
    .technical-log {
      margin: 0 18px 18px;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg2);
    }
    .technical-log summary {
      padding: 9px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 750;
    }
    .technical-log pre {
      max-height: 360px;
      margin: 0;
      padding: 10px;
      overflow: auto;
      border-top: 1px solid var(--border);
      color: #3e495b;
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    @media (max-width: 720px) {
      .document { width: 100%; margin: 0; border-radius: 0; }
      .modal-header,
      .report-verdict { align-items: stretch; flex-direction: column; }
      .modal-title span { max-width: 100%; }
      .summary-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .report-callout { width: fit-content; }
      .group-head { align-items: flex-start; }
      .mini-file-row { align-items: flex-start; flex-wrap: wrap; }
      .mini-problem { order: 3; flex-basis: 100%; min-width: 0; }
      .tech-detail { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: 480px) {
      .summary-tiles { grid-template-columns: minmax(0, 1fr); }
    }
    @media print {
      body { background: #fff; }
      .document {
        width: 100%;
        margin: 0;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .print-button { display: none; }
      .technical-log pre { max-height: none; }
      details { break-inside: avoid; }
      details:not([open]) > *:not(summary) { display: block; }
    }
  `;
}

// Nom de fichier proposé au dialogue d'export ; le repli suit la langue active.
export function reportBaseName(report) {
  return String(report?.packName || t('checker:export.file.fallbackName'))
    .replace(/\.(zip|7z)$/i, '')
    .replace(/[<>:"/\\|?*\[\]+]/g, '_')
    .trim() || t('checker:export.file.fallbackName');
}

export function formatTechnicalLog(report) {
  report = presentCheckerReport(report);
  return (report?.technicalLog || []).join('\n');
}

export function formatDiagnosticJson(report) {
  return JSON.stringify(presentCheckerReport(report), null, 2);
}

export function formatHtmlReport(report) {
  report = presentCheckerReport(report);
  if (!report) return '';
  const groups = buildProblemGroups(report);
  const summary = summarizeGroups(groups, report);
  const correctionCounts = packCorrectionCounts(report);
  const saturatedCount = saturatedFileCount(groups);
  const conformingGroups = buildConformingGroups(report);
  const audio = categoryConformanceStats(report.audioSummary);
  const images = categoryConformanceStats(report.imageSummary);
  const title = categoryConformanceStats(report.titleSummary);
  const titleOk = title.total > 0 && title.needsFix === 0;
  const structureOk = report.structureSummary?.luniiCompatible && report.structureSummary?.storyStudioEditable;
  const nightMode = Boolean(report.nightMode?.detected);
  const generatedAt = new Date().toLocaleString(getIntlLocale());
  const titleText = t('checker:export.html.title', { name: report.packName || t('checker:export.pack.fallback') });
  const analyzedName = report.packName || t('checker:report.pack.analyzed');
  const documentLanguage = getIntlLocale().slice(0, 2);

  return html`<!doctype html>
<html lang="${escapeHtml(documentLanguage)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(titleText)}</title>
  <style>${reportStyles()}</style>
</head>
<body>
  <main class="document">
    <header class="modal-header">
      <div class="modal-title">
        <span class="drop-icon">${icon('package')}</span>
        <div>
          <strong>${escapeHtml(t('home:modeSelector.checker.entryLabel'))}</strong>
          <span title="${escapeHtml(report.packName || '')}">${escapeHtml(analyzedName)} · ${escapeHtml(generatedAt)}</span>
        </div>
      </div>
      <button class="print-button" type="button" onclick="window.print()">${escapeHtml(t('checker:export.html.print'))}</button>
    </header>
    <section class="report" aria-label="${escapeHtml(t('checker:export.html.aria'))}">
      <div class="report-verdict report-verdict--${summary.tone}">
        <span class="report-orb">${icon(summary.icon)}</span>
        <div class="report-copy">
          <span class="pack-name">${escapeHtml(analyzedName)}</span>
          <strong>${escapeHtml(summary.title)}</strong>
          <span>${escapeHtml(summary.subtitle)}</span>
        </div>
        <div class="report-callout">
          ${icon('info')}
          <span>${richHtml(t('checker:report.callout.listen', { count: summary.listenCount }))} · ${richHtml(t('checker:report.callout.automatic', { count: correctionCounts.automatic }))} · ${richHtml(t('checker:report.callout.optional', { count: correctionCounts.optional }))}</span>
        </div>
      </div>
      <div class="summary-tiles" aria-label="${escapeHtml(t('checker:summary.tiles.aria'))}">
        ${summaryTileHtml({
          title: t('checker:summary.audio.title'),
          iconName: 'audio',
          tone: saturatedCount > 0 ? 'danger' : (audio.needsFix > 0 ? 'fix' : 'ok'),
          split: audio,
        })}
        ${summaryTileHtml({
          title: t('checker:summary.images.title'),
          iconName: 'image',
          tone: images.needsFix ? 'fix' : 'ok',
          split: images,
        })}
        ${summaryTileHtml({
          title: t('checker:summary.packName.title'),
          iconName: 'file',
          tone: titleOk ? 'ok' : 'fix',
          strong: titleOk ? t('checker:summary.packName.valid') : t('checker:summary.packName.toFix'),
          small: titleOk ? t('checker:summary.packName.conventionOk') : t('checker:summary.packName.metadata'),
        })}
        ${summaryTileHtml({
          title: t('checker:summary.structure.title'),
          iconName: 'network',
          tone: structureOk ? 'ok' : 'listen',
          strong: structureOk ? t('checker:summary.structure.correct') : t('checker:summary.structure.manual'),
          small: t('checker:summary.structure.steps', { count: report.structureSummary?.stageCount ?? 0 }),
        })}
        ${summaryTileHtml({
          title: t('checker:summary.nightMode.title'),
          iconName: 'moon',
          tone: nightMode ? 'ok' : 'neutral',
          strong: nightMode ? t('checker:summary.nightMode.available') : t('checker:summary.nightMode.absent'),
          small: nightMode ? t('checker:summary.nightMode.detected') : t('checker:summary.nightMode.notBlocking'),
        })}
      </div>
      ${groups.length === 0 ? html`<div class="empty">${icon('check')}${escapeHtml(t('checker:report.empty'))}</div>` : html`<div class="groups">
        ${groups.map((group, index) => problemGroupHtml(group, index === 0)).join('')}
      </div>`}
      ${conformingGroups.length ? html`<div class="section-head">${icon('check')}${escapeHtml(t('checker:conform.section.title'))}</div>
      <div class="groups">
        ${conformingGroups.map((group, index) => conformingGroupHtml(group, groups.length === 0 && index === 0)).join('')}
      </div>` : ''}
      <details class="technical-log">
        <summary>${escapeHtml(t('checker:log.technical.title'))}</summary>
        <pre>${escapeHtml(formatTechnicalLog(report))}</pre>
      </details>
    </section>
  </main>
</body>
</html>`;
}

export function formatReadableReport(report) {
  report = presentCheckerReport(report);
  if (!report) return '';
  const lines = [];
  const yesNo = (value) => (value ? t('checker:markdown.value.yes') : t('checker:markdown.value.no'));
  lines.push(`# ${t('checker:markdown.title')}`);
  lines.push('');
  lines.push(t('checker:markdown.pack.analyzed', { name: String(report.packName) }));
  lines.push(t('checker:markdown.verdict.line', { verdict: verdictLabel(report.verdict) }));
  lines.push('');
  lines.push(`- ${t('checker:markdown.count.errors', { value: report.summary?.errors ?? 0 })}`);
  lines.push(`- ${t('checker:markdown.count.warnings', { value: report.summary?.warnings ?? 0 })}`);
  lines.push(`- ${t('checker:markdown.count.infos', { value: report.summary?.infos ?? 0 })}`);
  lines.push(`- ${t('checker:markdown.count.ok', { value: report.summary?.ok ?? 0 })}`);
  const correctionCounts = packCorrectionCounts(report);
  lines.push(`- ${t('checker:markdown.count.automatic', { value: correctionCounts.automatic })}`);
  lines.push(`- ${t('checker:markdown.count.optional', { value: correctionCounts.optional })}`);
  lines.push('');
  lines.push(`## ${t('checker:markdown.summary.title')}`);
  lines.push('');
  const audio = categoryConformanceStats(report.audioSummary);
  const images = categoryConformanceStats(report.imageSummary);
  lines.push(`- ${t('checker:markdown.summary.audio', { ok: audio.ok, total: audio.total })}`);
  lines.push(`- ${t('checker:markdown.summary.images', { ok: images.ok, total: images.total })}`);
  lines.push(`- ${report.structureSummary?.luniiCompatible ? t('checker:markdown.structure.valid') : t('checker:markdown.structure.toFix')}`);
  lines.push(`- ${report.structureSummary?.storyStudioEditable ? t('checker:markdown.editing.supported') : t('checker:markdown.editing.unsupported')}`);
  lines.push(`- ${report.nightMode?.detected ? t('checker:markdown.nightMode.detected') : t('checker:markdown.nightMode.absent')}`);
  lines.push('');
  lines.push(`## ${t('checker:markdown.issues.title')}`);
  lines.push('');
  const issues = report.issues || [];
  if (issues.length === 0) {
    lines.push(t('checker:markdown.issues.none'));
  } else {
    for (const issue of issues) {
      lines.push(`- ${t('checker:markdown.issue.line', { severity: severityLabel(issue.severity), label: String(issue.label), message: String(issue.message) })}`);
      if (issue.filePath) lines.push(`  ${t('checker:markdown.issue.file', { path: issue.filePath })}`);
      if (issue.technicalDetails) lines.push(`  ${t('checker:markdown.issue.detail', { detail: issue.technicalDetails })}`);
      if (issue.autoFixDescription) {
        lines.push(`  ${isOptionalSilenceIssue(issue)
          ? t('checker:markdown.issue.suggestion', { description: issue.autoFixDescription })
          : t('checker:markdown.issue.correction', { description: issue.autoFixDescription })}`);
      }
    }
  }
  lines.push('');
  lines.push(`## ${t('checker:conform.section.title')}`);
  lines.push('');
  const measure = (row) => t('checker:markdown.measure.pair', { label: row.label, value: row.value });
  const conformingAudio = (report.audioItems || []).filter((item) => isConforming(item.status));
  if (conformingAudio.length) {
    lines.push(`### ${t('checker:markdown.conform.audio', { total: conformingAudio.length })}`);
    for (const item of conformingAudio) {
      const measures = audioMeasureRows(item).map(measure).join(' · ');
      lines.push(`- ${cleanLabel(item.label)} — ${measures}`);
    }
    lines.push('');
  }
  const conformingImages = (report.imageItems || []).filter((item) => isConforming(item.status));
  if (conformingImages.length) {
    lines.push(`### ${t('checker:markdown.conform.images', { total: conformingImages.length })}`);
    for (const item of conformingImages) {
      const measures = imageMeasureRows(item).map(measure).join(' · ');
      lines.push(`- ${cleanLabel(item.label)} — ${measures}`);
    }
    lines.push('');
  }
  if (titleConforming(report)) {
    lines.push(`### ${t('checker:summary.packName.title')}`);
    lines.push(`- ${t('checker:markdown.fact.name', { value: report.packName || '—' })}`);
    lines.push(`- ${t('checker:markdown.fact.title', { value: report.packTitle || '—' })}`);
    lines.push(`- ${t('checker:markdown.fact.version', { value: report.packVersion ?? '—' })}`);
    lines.push('');
  }
  if (structureConforming(report)) {
    const structure = report.structureSummary || {};
    lines.push(`### ${t('checker:summary.structure.title')}`);
    lines.push(`- ${t('checker:markdown.fact.lunii', { value: yesNo(structure.luniiCompatible) })}`);
    lines.push(`- ${t('checker:markdown.fact.editable', { value: yesNo(structure.storyStudioEditable) })}`);
    lines.push(`- ${t('checker:markdown.fact.stories', { value: structure.storyCount ?? 0 })}`);
    lines.push(`- ${t('checker:markdown.fact.stages', { value: structure.stageCount ?? 0 })}`);
    lines.push(`- ${t('checker:markdown.fact.actions', { value: structure.actionCount ?? 0 })}`);
    lines.push(`- ${t('checker:markdown.fact.refAudio', { value: structure.referencedAudioCount ?? 0 })}`);
    lines.push(`- ${t('checker:markdown.fact.refImage', { value: structure.referencedImageCount ?? 0 })}`);
    lines.push('');
  }
  lines.push(`### ${t('checker:summary.nightMode.title')}`);
  lines.push(`- ${report.nightMode?.detected ? t('checker:markdown.nightMode.available') : t('checker:markdown.nightMode.absent')}`);
  lines.push(`- ${t('checker:markdown.fact.blocking')}`);
  lines.push('');
  lines.push(`## ${t('checker:log.technical.title')}`);
  lines.push('');
  lines.push('```text');
  lines.push(formatTechnicalLog(report));
  lines.push('```');
  return lines.join('\n');
}
