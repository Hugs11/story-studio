import { measuredIssueSummary, saturatedSummary, silenceSummaryParts, volumeSummary } from './packCheckerIssueClassification.js';
import { CheckerTrans, useCheckerTranslation } from '../../i18n/useCheckerTranslation.js';
import { translateChecker } from '../../i18n/checkerPresentation.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../common/Button';
import { CommunityPackMetadataModal } from './CommunityPackMetadataModal';
import {
  Check,
  ChevronDown,
  CircleCheck,
  Download,
  FilePen,
  Image,
  Info,
  Loader2,
  Moon,
  Music,
  Network,
  Scissors,
  TriangleAlert,
  Wrench,
} from '../icons/LucideLocal';
import {
  Measure,
  audioMeasureRows,
  cleanLabel,
  expectedImageOk,
  imageMeasureRows,
} from './packCheckerMeasures';
import { ConformingSection } from './CommunityPackConforming';
import { formatPackAudioEdgeSilence } from '../../config/audioProcessing';
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
  optionalSilenceSelectionKey,
} from './packCheckerIssueClassification';
import './CommunityPackChecker.css';

// Sections : clés de présentation, résolues à l'affichage ; le classement reste
// porté par category/code (`match`), jamais par le texte.
const PROBLEM_SECTIONS = [
  {
    id: 'quality',
    titleKey: 'checker:issue.saturated.title',
    badgeKey: 'checker:issue.badge.source',
    bucket: 'listen',
    Icon: TriangleAlert,
    explanationKey: 'checker:issue.saturated.explanation',
    actionKey: 'checker:issue.saturated.action',
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
    Icon: Info,
    explanationKey: 'checker:issue.listen.explanation',
    actionKey: 'checker:issue.listen.action',
    match: (issue) => !isOptionalSilenceIssue(issue) && !issue.autoFixAvailable && issue.category !== 'structure' && issue.category !== 'title',
  },
  {
    id: 'silence',
    titleKey: 'checker:issue.silence.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    Icon: Scissors,
    explanationKey: 'checker:issue.silence.explanation',
    actionKey: 'checker:issue.silence.action',
    match: isAutomaticSilenceIssue,
  },
  {
    id: 'optionalSilence',
    titleKey: 'checker:issue.optionalSilence.title',
    badgeKey: 'checker:issue.badge.optional',
    bucket: 'optional',
    Icon: Scissors,
    explanationKey: 'checker:issue.optionalSilence.explanation',
    actionKey: 'checker:issue.optionalSilence.action',
    match: isOptionalSilenceIssue,
  },
  {
    id: 'volume',
    titleKey: 'checker:issue.volume.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    Icon: Music,
    explanationKey: 'checker:issue.volume.explanation',
    actionKey: 'checker:issue.volume.action',
    match: isAutomaticVolumeIssue,
  },
  {
    id: 'audioFormat',
    titleKey: 'checker:issue.audioFormat.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    Icon: Wrench,
    explanationKey: 'checker:issue.audioFormat.explanation',
    actionKey: 'checker:issue.audioFormat.action',
    match: isAudioFormatIssue,
  },
  {
    id: 'image',
    titleKey: 'checker:issue.imageCorrection.title',
    badgeKey: 'checker:issue.badge.auto',
    bucket: 'fix',
    Icon: Image,
    explanationKey: 'checker:issue.image.explanation',
    actionKey: 'checker:issue.image.action',
    match: (issue) => issue.autoFixAvailable && issue.category === 'image',
  },
  {
    id: 'title',
    titleKey: 'checker:issue.packName.title',
    badgeKey: 'checker:issue.badge.assisted',
    bucket: 'fix',
    Icon: FilePen,
    explanationKey: 'checker:issue.packName.explanation',
    actionKey: 'checker:issue.packName.action',
    match: (issue) => issue.category === 'title',
  },
  {
    id: 'structure',
    titleKey: 'checker:issue.structure.title',
    badgeKey: 'checker:issue.badge.manual',
    bucket: 'listen',
    Icon: Network,
    explanationKey: 'checker:issue.structure.explanation',
    actionKey: 'checker:issue.structure.action',
    match: (issue) => issue.category === 'structure',
  },
];

function IconFrame({ Icon }) {
  return <Icon className="checker-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function severityLabel(severity) {
  switch (severity) {
    case 'error':
      return translateChecker('checker:severity.error.label');
    case 'warning':
      return translateChecker('checker:severity.warning.label');
    case 'info':
      return translateChecker('checker:severity.info.label');
    case 'ok':
      return translateChecker('checker:severity.ok.label');
    default:
      return severity || translateChecker('checker:severity.info.label');
  }
}

// Texte affiché d'une section : résolu au rendu, dans la langue active.
function sectionText(group) {
  const key = group.bucket === 'fix' ? group.actionKey : group.explanationKey;
  return translateChecker(key, { duration: formatPackAudioEdgeSilence() });
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
    return scopedIssues
      .map((issue) => measuredIssueSummary(issue, record.item, record.kind))
      .filter(Boolean)
      .join(' · ');
  }

  return scopedIssues
    .map((issue) => measuredIssueSummary(issue, record.item, record.kind))
    .filter(Boolean)
    .join(' · ');
}

function hasMeasureIssue(record, key) {
  const issues = record.sectionIssues?.length ? record.sectionIssues : record.issues;
  return hasMeasureIssues(issues, key);
}

function roleLabel(record) {
  const raw = record.item?.itemType || record.issue?.itemType || record.issue?.category || translateChecker('checker:file.label.fallback');
  if (raw === 'image') return translateChecker('checker:file.role.image');
  if (raw === 'audio') return translateChecker('checker:file.role.audio');
  return raw;
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

function buildItemMap(report) {
  const map = new Map();
  for (const item of report?.audioItems || []) {
    map.set(item.filePath, { kind: 'audio', item });
  }
  for (const item of report?.imageItems || []) {
    map.set(item.filePath, { kind: 'image', item });
  }
  return map;
}

function uniqueIssueKey(issue) {
  return issue.filePath || `${issue.category}:${issue.code ?? issue.label}`;
}

function buildProblemGroups(report) {
  if (!report) return [];
  const itemMap = buildItemMap(report);
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
      const itemEntry = issue.filePath ? itemMap.get(issue.filePath) : null;
      const allFileIssues = issue.filePath ? (issuesByFilePath(report).get(issue.filePath) || [issue]) : [issue];
      records.push({
        id: `${section.id}:${key}`,
        issue,
        issues: allFileIssues,
        sectionIssues: allFileIssues.filter((candidate) => section.match(candidate)),
        item: itemEntry?.item || null,
        kind: itemEntry?.kind || issue.category,
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

  // Titre et sous-titre : clés et compte, résolus au rendu (changement de langue à chaud).
  const verdict = (tone, Icon, titleKey, subtitleKey, titleCount) => ({
    tone, Icon, titleKey, subtitleKey, titleCount, listenCount, fixCount, optionalCount,
  });
  if (!groups.length) {
    return verdict('ok', CircleCheck, 'checker:verdict.conform.title', 'checker:verdict.conform.subtitle');
  }
  if (hasBlocking) {
    return verdict('listen', TriangleAlert, 'checker:verdict.blocking.title', 'checker:verdict.blocking.subtitle');
  }
  // Audio saturé : défaut de qualité que la correction ne résout pas → on ne
  // promet jamais « corrigeable en un clic », on conseille de repartir d'une
  // source propre.
  if (saturatedCount > 0) {
    return fixCount > 0
      ? verdict('quality', TriangleAlert, 'checker:verdict.saturatedFixable.title', 'checker:verdict.saturatedFixable.subtitle')
      : verdict('quality', TriangleAlert, 'checker:verdict.saturated.title', 'checker:verdict.saturated.subtitle');
  }
  if (listenCount > 0) {
    return verdict('listen', Info, 'checker:verdict.listen.title', 'checker:verdict.listen.subtitle', listenCount);
  }
  if (fixCount === 0 && listenCount === 0 && optionalCount > 0) {
    return verdict('ok', CircleCheck, 'checker:verdict.optional.title', 'checker:verdict.optional.subtitle', optionalCount);
  }
  return verdict('fix', Wrench, 'checker:verdict.fixable.title', 'checker:verdict.fixable.subtitle');
}

export function titleNeedsCorrection(report) {
  return (report?.titleSummary?.warnings || 0) > 0 || (report?.titleSummary?.errors || 0) > 0;
}

function SummaryTile({ title, Icon, tone = 'neutral', children }) {
  return (
    <div className={`checker-summary-tile checker-summary-tile--${tone}`}>
      <div className="checker-summary-tile-head">
        <IconFrame Icon={Icon} />
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

const STRONG = { strong: <strong /> };

function SplitStat({ ok, needsFix }) {
  return (
    <div className="checker-split-stat">
      <span className="checker-split-stat-ok"><CheckerTrans i18nKey="checker:summary.split.ok" values={{ value: ok }} components={STRONG} /></span>
      <span className={`checker-split-stat-fix ${needsFix === 0 ? 'is-clean' : ''}`}>
        <CheckerTrans i18nKey="checker:summary.split.fix" values={{ value: needsFix }} components={STRONG} />
      </span>
    </div>
  );
}

function SummaryTiles({ report, saturatedCount = 0 }) {
  const { t } = useCheckerTranslation();
  const audio = categoryConformanceStats(report.audioSummary);
  const images = categoryConformanceStats(report.imageSummary);
  const title = categoryConformanceStats(report.titleSummary);
  const titleOk = title.total > 0 && title.needsFix === 0;
  const structureOk = report.structureSummary?.luniiCompatible && report.structureSummary?.storyStudioEditable;
  const nightMode = Boolean(report.nightMode?.detected);
  return (
    <div className="checker-summary-tiles" aria-label={t('checker:summary.tiles.aria')}>
      <SummaryTile title={t('checker:summary.audio.title')} Icon={Music} tone={saturatedCount > 0 ? 'danger' : (audio.needsFix > 0 ? 'fix' : 'ok')}>
        <SplitStat ok={audio.ok} needsFix={audio.needsFix} />
      </SummaryTile>
      <SummaryTile title={t('checker:summary.images.title')} Icon={Image} tone={images.needsFix ? 'fix' : 'ok'}>
        <SplitStat ok={images.ok} needsFix={images.needsFix} />
      </SummaryTile>
      <SummaryTile title={t('checker:summary.packName.title')} Icon={FilePen} tone={titleOk ? 'ok' : 'fix'}>
        <div className="checker-single-stat">
          <strong>{titleOk ? t('checker:summary.packName.valid') : t('checker:summary.packName.toFix')}</strong>
          <span>{titleOk ? t('checker:summary.packName.conventionOk') : t('checker:summary.packName.metadata')}</span>
        </div>
      </SummaryTile>
      <SummaryTile title={t('checker:summary.structure.title')} Icon={Network} tone={structureOk ? 'ok' : 'listen'}>
        <div className="checker-single-stat">
          <strong>{structureOk ? t('checker:summary.structure.correct') : t('checker:summary.structure.manual')}</strong>
          <span>{t('checker:summary.structure.steps', { count: report.structureSummary?.stageCount ?? 0 })}</span>
        </div>
      </SummaryTile>
      <SummaryTile title={t('checker:summary.nightMode.title')} Icon={Moon} tone={nightMode ? 'ok' : 'neutral'}>
        <div className="checker-single-stat">
          <strong>{nightMode ? t('checker:summary.nightMode.available') : t('checker:summary.nightMode.absent')}</strong>
          <span>{nightMode ? t('checker:summary.nightMode.detected') : t('checker:summary.nightMode.notBlocking')}</span>
        </div>
      </SummaryTile>
    </div>
  );
}

function TechnicalDetail({ record }) {
  const { t } = useCheckerTranslation();
  const item = record.item;
  return (
    <div className="checker-tech-detail">
      <div>
        <div className="checker-tech-title">{t('checker:detail.measures.title')}</div>
        {record.kind === 'audio' ? (
          audioMeasureRows(item).map((row) => (
            <Measure
              key={row.key}
              label={row.label}
              value={row.value}
              status={hasMeasureIssue(record, row.key)
                ? (record.issue.fixDisposition === 'optional' ? 'info' : 'bad')
                : 'ok'}
            />
          ))
        ) : record.kind === 'image' ? (
          <>
            {imageMeasureRows(item).map((row) => (
              <Measure
                key={row.key}
                label={row.label}
                value={row.value}
                status={hasMeasureIssue(record, row.key) ? 'bad' : 'ok'}
              />
            ))}
            <Measure label={t('checker:detail.expected.label')} value="320×240" status={expectedImageOk(item) ? 'ok' : 'bad'} />
          </>
        ) : (
          <Measure label={t('checker:detail.category.label')} value={record.issue.category} status={record.issue.severity === 'ok' ? 'ok' : 'bad'} />
        )}
      </div>
      <div>
        <div className="checker-tech-title">{t('checker:detail.actions.title')}</div>
        {(record.sectionIssues?.length ? record.sectionIssues : record.issues).map((issue, index) => (
          <div className="checker-tech-action" key={`${issue.message}-${index}`}>
            <IconFrame Icon={issue.autoFixAvailable ? Wrench : Info} />
            <div>
              <strong>{issue.autoFixDescription || issue.message}</strong>
              {issue.technicalDetails ? <span>{issue.technicalDetails}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniFile({ record, open, onToggle }) {
  useCheckerTranslation();
  const firstIssue = record.issue;
  const issueSummary = recordProblemSummary(record);
  return (
    <div className="checker-mini-file">
      <button type="button" className="checker-mini-file-button" onClick={onToggle}>
        <span className="checker-role">{roleLabel(record)}</span>
        <span className="checker-mini-name" title={firstIssue.filePath || firstIssue.label}>
          {cleanLabel(firstIssue.label)}
        </span>
        <span className="checker-mini-problem" title={issueSummary}>
          {issueSummary}
        </span>
        <span className={`checker-mini-severity checker-mini-severity--${firstIssue.severity}`}>
          {severityLabel(firstIssue.severity)}
        </span>
        <ChevronDown className={`checker-mini-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open ? <TechnicalDetail record={record} /> : null}
    </div>
  );
}

function ProblemGroupCard({
  group,
  expanded,
  onToggle,
  countValue = group.count,
  countLabel = null,
  selectedOptionalSilences = new Set(),
  onToggleOptionalSilence,
}) {
  const { t } = useCheckerTranslation();
  const [openFile, setOpenFile] = useState(null);
  const Icon = group.Icon;
  const displayedCountLabel = countLabel || t('checker:group.count.files', { count: countValue });
  return (
    <div className={`checker-group checker-group--${group.bucket} checker-group--${group.id} ${expanded ? 'is-expanded' : ''}`}>
      <button type="button" className="checker-group-head" onClick={onToggle}>
        <span className="checker-group-icon"><IconFrame Icon={Icon} /></span>
        <span className="checker-group-copy">
          <span className="checker-group-title-row">
            <strong>{t(group.titleKey)}</strong>
            <span className="checker-group-badge">{t(group.badgeKey)}</span>
          </span>
          <span>{sectionText(group)}</span>
        </span>
        <span className="checker-group-count">
          <strong>{countValue}</strong>
          <small>{displayedCountLabel}</small>
        </span>
        <ChevronDown className="checker-group-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="checker-group-body">
          <div className="checker-mini-list">
            {group.records.map((record) => (
              <div key={record.id} className="checker-optional-record">
                {group.bucket === 'optional' ? (
                  <label className="checker-optional-choice">
                    <input
                      type="checkbox"
                      checked={selectedOptionalSilences.has(optionalSilenceSelectionKey(record.issue))}
                      onChange={() => onToggleOptionalSilence?.(record.issue)}
                    />
                    <span>{record.issue.autoFixDescription || t('checker:group.optional.choice', { duration: formatPackAudioEdgeSilence() })}</span>
                  </label>
                ) : null}
                <MiniFile
                  record={record}
                  open={openFile === record.id}
                  onToggle={() => setOpenFile(openFile === record.id ? null : record.id)}
                />
              </div>
            ))}
          </div>
          {group.bucket === 'listen' ? (
            <div className="checker-group-help">
              <IconFrame Icon={Info} />
              {t('checker:group.listen.help')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FixableCorrectionsList({ report, selectedOptionalSilences, onToggleOptionalSilence }) {
  const { t } = useCheckerTranslation();
  const groups = useMemo(
    () => buildProblemGroups(report).filter((group) => group.bucket === 'fix' || group.bucket === 'optional'),
    [report],
  );

  if (!groups.length) {
    return (
      <div className="checker-empty checker-empty--success">
        <IconFrame Icon={Check} />
        {t('checker:corrections.empty')}
      </div>
    );
  }

  return (
    <div className="checker-groups checker-groups--preview">
      {groups.map((group) => (
        <ProblemGroupCard
          key={group.id}
          group={group}
          expanded
          onToggle={() => {}}
          countValue={group.bucket === 'optional' ? group.count : group.fixCount}
          countLabel={group.bucket === 'optional'
            ? t('checker:group.count.suggestions', { count: group.count })
            : t('checker:group.count.corrections', { count: group.fixCount })}
          selectedOptionalSilences={selectedOptionalSilences}
          onToggleOptionalSilence={onToggleOptionalSilence}
        />
      ))}
    </div>
  );
}

export function ReportView({
  report,
  busy,
  canFix,
  onExportReport,
  onFixPack,
  onStartFix,
  showFixButton = true,
  selectedOptionalSilences,
  onToggleOptionalSilence,
}) {
  const { t } = useCheckerTranslation();
  const groups = useMemo(() => buildProblemGroups(report), [report]);
  const summary = useMemo(() => summarizeGroups(groups, report), [groups, report]);
  const saturatedCount = useMemo(() => saturatedFileCount(groups), [groups]);
  const [expanded, setExpanded] = useState(groups[0]?.id || null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  if (!report) return null;
  const SummaryIcon = summary.Icon;

  function startFixFlow() {
    if (onStartFix) {
      onStartFix();
      return;
    }
    setMetadataOpen(true);
  }

  return (
    <div className="checker-report">
      <div className={`checker-report-verdict checker-report-verdict--${summary.tone}`}>
        <span className="checker-report-orb"><IconFrame Icon={SummaryIcon} /></span>
        <div className="checker-report-copy">
          <div className="checker-pack-name" title={report.packName}>{report.packName}</div>
          <strong>{t(summary.titleKey, { count: summary.titleCount })}</strong>
          <span>{t(summary.subtitleKey)}</span>
        </div>
        <div className="checker-report-callout">
          <Info className="checker-icon" aria-hidden="true" />
          <span>
            <CheckerTrans i18nKey="checker:report.callout.listen" count={summary.listenCount} components={STRONG} />
            {' · '}
            <CheckerTrans i18nKey="checker:report.callout.automatic" count={summary.fixCount} components={STRONG} />
            {' · '}
            <CheckerTrans i18nKey="checker:report.callout.optional" count={summary.optionalCount} components={STRONG} />
          </span>
        </div>
      </div>

      <SummaryTiles report={report} saturatedCount={saturatedCount} />

      {groups.length === 0 ? (
        <div className="checker-empty checker-empty--success">
          <IconFrame Icon={Check} />
          {t('checker:report.empty')}
        </div>
      ) : (
        <div className="checker-groups">
          {groups.map((group) => (
            <ProblemGroupCard
              key={group.id}
              group={group}
              expanded={expanded === group.id}
              onToggle={() => setExpanded(expanded === group.id ? null : group.id)}
              selectedOptionalSilences={selectedOptionalSilences}
              onToggleOptionalSilence={onToggleOptionalSilence}
            />
          ))}
        </div>
      )}

      <ConformingSection report={report} />

      <div className="checker-report-footer">
        <span>
          <CheckerTrans i18nKey="checker:report.footer.ready" count={summary.fixCount} components={STRONG} />
          {' · '}
          <CheckerTrans i18nKey="checker:report.footer.suggestions" count={summary.optionalCount} components={STRONG} />
        </span>
        <Button size="sm" onClick={() => onExportReport('report')}>
          <Download className="checker-button-icon" aria-hidden="true" />
          {t('checker:report.export.action')}
        </Button>
        {showFixButton ? (
          <button
            type="button"
            className="chrome-toolbar-cta checker-correction-cta"
            onClick={startFixFlow}
            disabled={!canFix || busy}
          >
            {busy ? t('checker:fix.busy.label') : t('checker:fix.start.action')}
          </button>
        ) : null}
      </div>

      {metadataOpen && !onStartFix ? (
        <CommunityPackMetadataModal
          report={report}
          busy={busy}
          onCancel={() => setMetadataOpen(false)}
          onSubmit={(metadataPatch) => {
            setMetadataOpen(false);
            onFixPack(metadataPatch);
          }}
        />
      ) : null}
    </div>
  );
}

export function TechnicalLog({ report, onCopyLog, onExportLog, onExportJson }) {
  const { t } = useCheckerTranslation();
  if (!report) return null;
  return (
    <details className="checker-log">
      <summary>{t('checker:log.technical.title')}</summary>
      <div className="checker-log-actions">
        <Button size="sm" onClick={onCopyLog}>{t('checker:log.copy.action')}</Button>
        <Button size="sm" onClick={() => onExportLog('log')}>{t('checker:log.export.action')}</Button>
        <Button size="sm" onClick={() => onExportJson('json')}>{t('checker:log.exportJson.action')}</Button>
      </div>
      <pre>{(report.technicalLog || []).join('\n')}</pre>
    </details>
  );
}

export function ProcessLog({ status, lines }) {
  const { t } = useCheckerTranslation();
  const linesRef = useRef(null);
  useEffect(() => {
    const node = linesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  if (!lines?.length) return null;
  const title = status === 'fixing'
    ? t('checker:process.fixing.title')
    : status === 'analyzing'
      ? t('checker:process.analyzing.title')
      : t('checker:process.recent.title');
  return (
    <div className={`checker-process-log ${status === 'idle' ? 'is-idle' : 'is-active'}`}>
      <div className="checker-process-log-head">
        {status !== 'idle' ? <IconFrame Icon={Loader2} /> : <IconFrame Icon={CircleCheck} />}
        <strong>{title}</strong>
      </div>
      <div className="checker-process-log-lines" ref={linesRef} aria-live="polite">
        {lines.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}
