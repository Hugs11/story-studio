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
  formatLufs,
  formatPeak,
  formatSeconds,
  imageMeasureRows,
} from './packCheckerMeasures';
import { ConformingSection } from './CommunityPackConforming';
import { formatPackAudioEdgeSilence } from '../../config/audioProcessing';
import './CommunityPackChecker.css';

const EDGE_SILENCE_LABEL = formatPackAudioEdgeSilence();

const PROBLEM_SECTIONS = [
  {
    id: 'quality',
    title: 'Audio de mauvaise qualité (source saturée)',
    badge: 'Source',
    bucket: 'listen',
    Icon: TriangleAlert,
    explanation: "La saturation est présente dans le fichier d'origine : aucune correction ne la rattrape. Reprends le pack depuis une meilleure source.",
    action: 'Reprends le pack depuis une meilleure source.',
    match: (issue) => (
      issue.category === 'audio'
      && !issue.autoFixAvailable
      && (issue.message || '').toLowerCase().includes('satur')
    ),
  },
  {
    id: 'listen',
    title: 'À écouter',
    badge: 'Manuel',
    bucket: 'listen',
    Icon: Info,
    explanation: "L'outil ne sait pas corriger ce point tout seul.",
    action: "Écoute ou vérifie ces fichiers avant de valider le pack.",
    match: (issue) => !issue.autoFixAvailable && issue.category !== 'structure' && issue.category !== 'title',
  },
  {
    id: 'silence',
    title: 'Silence début / fin incorrect',
    badge: 'Auto',
    bucket: 'fix',
    Icon: Scissors,
    explanation: 'Le blanc avant ou après la voix sort de la fenêtre attendue.',
    action: `On ajuste le silence vers ${EDGE_SILENCE_LABEL}.`,
    match: (issue) => issue.autoFixAvailable && issue.category === 'audio' && issue.message.toLowerCase().includes('silence'),
  },
  {
    id: 'volume',
    title: 'Niveau sonore incorrect',
    badge: 'Auto',
    bucket: 'fix',
    Icon: Music,
    explanation: 'Le niveau moyen est trop faible ou trop fort par rapport au reste.',
    action: 'On normalise le volume au bon niveau.',
    match: (issue) => issue.autoFixAvailable && issue.category === 'audio' && issue.message.toLowerCase().includes('volume'),
  },
  {
    id: 'audioFormat',
    title: 'Format audio à convertir',
    badge: 'Auto',
    bucket: 'fix',
    Icon: Wrench,
    explanation: "L'audio n'est pas dans le format attendu.",
    action: 'On reconvertit en MP3 mono 44,1 kHz.',
    match: (issue) => {
      const message = issue.message.toLowerCase();
      return issue.autoFixAvailable && issue.category === 'audio' && (
        message.includes('format') || message.includes('fréquence') || message.includes('mono')
      );
    },
  },
  {
    id: 'image',
    title: 'Image à corriger',
    badge: 'Auto',
    bucket: 'fix',
    Icon: Image,
    explanation: "L'image n'a pas le format ou la taille attendue.",
    action: 'On convertit ou redimensionne en 320×240.',
    match: (issue) => issue.autoFixAvailable && issue.category === 'image',
  },
  {
    id: 'title',
    title: 'Nom du pack à corriger',
    badge: 'Assisté',
    bucket: 'fix',
    Icon: FilePen,
    explanation: 'Le nom ou la convention du pack demande une correction.',
    action: 'On ouvre les métadonnées avant de créer le ZIP corrigé.',
    match: (issue) => issue.category === 'title',
  },
  {
    id: 'structure',
    title: 'Structure à vérifier',
    badge: 'Manuel',
    bucket: 'listen',
    Icon: Network,
    explanation: 'Un lien, une référence ou un champ du pack demande une vérification.',
    action: 'Vérifie la navigation ou les fichiers référencés.',
    match: (issue) => issue.category === 'structure',
  },
];

function IconFrame({ Icon }) {
  return <Icon className="checker-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function severityLabel(severity) {
  switch (severity) {
    case 'error':
      return 'Erreur';
    case 'warning':
      return 'Avertissement';
    case 'info':
      return 'Info';
    case 'ok':
      return 'OK';
    default:
      return severity || 'Info';
  }
}

function measuredIssueSummary(issue, item, kind) {
  const message = issue.message || '';
  const lower = message.toLowerCase();
  if (kind === 'audio') {
    if (lower.includes('silence')) {
      const sides = silenceSummaryParts([issue], item);
      return sides.length ? sides.join(' | ') : message;
    }
    if (lower.includes('volume')) {
      const lufs = item?.integratedLufs;
      const direction = typeof lufs === 'number' && lufs > -10
        ? 'trop haut'
        : 'trop bas';
      return `Niveau sonore ${direction} (${formatLufs(lufs)})`;
    }
    if (lower.includes('fréquence')) {
      return `Échantillonnage incorrect (${item?.sampleRate ? `${item.sampleRate} Hz` : 'non mesuré'})`;
    }
    if (lower.includes('mono')) {
      return `Audio non mono (${item?.channels || 'canaux non mesurés'})`;
    }
    if (lower.includes('format')) {
      return `Mauvais format audio (${item?.codec || 'format non mesuré'})`;
    }
  }
  if (kind === 'image') {
    const dimensions = item?.width && item?.height ? `${item.width}×${item.height}` : 'dimensions non mesurées';
    const format = item?.format || 'format non mesuré';
    if (lower.includes('format')) return `Mauvais format image (${format})`;
    if (lower.includes('dimension') || lower.includes('taille')) return `Dimensions incorrectes (${dimensions})`;
    return `Image incorrecte (${dimensions} · ${format})`;
  }
  return message;
}

function silenceSummaryParts(issues, item) {
  const hasStart = issues.some((issue) => {
    const message = (issue.message || '').toLowerCase();
    return message.includes('début') || message.includes('debut');
  });
  const hasEnd = issues.some((issue) => (issue.message || '').toLowerCase().includes('fin'));
  const parts = [];
  if (hasStart) parts.push(`Silence début = ${formatSeconds(item?.leadingSilenceSecs)}`);
  if (hasEnd) parts.push(`Silence fin = ${formatSeconds(item?.trailingSilenceSecs)}`);
  return parts;
}

function recordProblemSummary(record) {
  const scopedIssues = record.sectionIssues?.length ? record.sectionIssues : [record.issue];
  if (record.kind === 'audio') {
    if (scopedIssues.some((issue) => (issue.message || '').toLowerCase().includes('satur'))) {
      const peak = record.item?.truePeakDb;
      return typeof peak === 'number' ? `Saturé · crête ${formatPeak(peak)}` : 'Saturé (source)';
    }
    const silenceIssues = scopedIssues.filter((issue) => (issue.message || '').toLowerCase().includes('silence'));
    if (silenceIssues.length > 0) {
      const parts = silenceSummaryParts(silenceIssues, record.item);
      if (parts.length > 0) return parts.join(' | ');
    }

    if (scopedIssues.some((issue) => (issue.message || '').toLowerCase().includes('volume'))) {
      const lufs = record.item?.integratedLufs;
      const direction = typeof lufs === 'number' && lufs > -10 ? 'trop haut' : 'trop bas';
      return `Niveau sonore ${direction} (${formatLufs(lufs)})`;
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

function issueText(issue) {
  return `${issue.message || ''} ${issue.autoFixDescription || ''} ${issue.technicalDetails || ''}`.toLowerCase();
}

function hasMeasureIssue(record, key) {
  const messages = record.issues.map(issueText);
  switch (key) {
    case 'format':
      return messages.some((message) => message.includes('format') || message.includes('mono'));
    case 'sampleRate':
      return messages.some((message) => (
        message.includes('fréquence') || message.includes('frequence') || message.includes('échantillonnage')
      ));
    case 'silenceStart':
      return messages.some((message) => message.includes('silence') && (message.includes('début') || message.includes('debut')));
    case 'silenceEnd':
      return messages.some((message) => message.includes('silence') && message.includes('fin'));
    case 'volume':
      return messages.some((message) => message.includes('volume') || message.includes('niveau sonore'));
    case 'peak':
      return messages.some((message) => message.includes('crête') || message.includes('crete') || message.includes('satur') || message.includes('clipping'));
    case 'dimensions':
      return messages.some((message) => message.includes('dimension') || message.includes('taille'));
    case 'imageFormat':
      return messages.some((message) => message.includes('format'));
    default:
      return false;
  }
}

function roleLabel(record) {
  const raw = record.item?.itemType || record.issue?.itemType || record.issue?.category || 'Fichier';
  if (raw === 'image') return 'Image';
  if (raw === 'audio') return 'Audio';
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
  return issue.filePath || `${issue.category}:${issue.label}:${issue.message}`;
}

function buildProblemGroups(report) {
  if (!report) return [];
  const itemMap = buildItemMap(report);
  const used = new Set();
  const relevantIssues = (report.issues || []).filter((issue) => (
    issue.severity === 'error' || issue.severity === 'warning'
  ));

  return PROBLEM_SECTIONS.map((section) => {
    const records = [];
    const seen = new Set();
    for (const issue of relevantIssues) {
      if (used.has(issue) || !section.match(issue)) continue;
      used.add(issue);
      const key = uniqueIssueKey(issue);
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
        : records.reduce((sum, record) => (
          sum + record.issues.filter((issue) => issue.autoFixAvailable).length
        ), 0),
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
  const saturatedCount = saturatedFileCount(groups);
  const hasBlocking = report?.verdict === 'invalid' || groups.some((group) => (
    group.bucket === 'listen' && group.records.some((record) => record.issue.severity === 'error')
  ));

  if (!groups.length) {
    return {
      tone: 'ok',
      Icon: CircleCheck,
      title: 'Pack conforme',
      subtitle: 'Aucun problème automatique ou manuel détecté.',
      listenCount,
      fixCount,
    };
  }
  if (hasBlocking) {
    return {
      tone: 'listen',
      Icon: TriangleAlert,
      title: 'Pack à vérifier avant export',
      subtitle: 'Certains points demandent une vérification manuelle.',
      listenCount,
      fixCount,
    };
  }
  // Audio saturé : défaut de qualité que la correction ne résout pas → on ne
  // promet jamais « corrigeable en un clic », on conseille de repartir d'une
  // source propre.
  if (saturatedCount > 0) {
    return {
      tone: 'quality',
      Icon: TriangleAlert,
      title: fixCount > 0 ? 'Pack corrigeable, mais audio déjà saturé' : 'Audio déjà saturé',
      subtitle: fixCount > 0
        ? "Le reste sera corrigé ; l'audio saturé doit être repris depuis une source propre."
        : 'Nous conseillons de refaire le pack depuis une source audio propre.',
      listenCount,
      fixCount,
    };
  }
  if (listenCount > 0) {
    return {
      tone: 'listen',
      Icon: Info,
      title: listenCount === 1
        ? 'Pack corrigeable, avec un fichier à écouter'
        : `Pack corrigeable, avec ${listenCount} fichiers à écouter`,
      subtitle: 'Le reste peut être corrigé automatiquement.',
      listenCount,
      fixCount,
    };
  }
  return {
    tone: 'fix',
    Icon: Wrench,
    title: 'Pack corrigeable en un clic',
    subtitle: 'Aucun point manuel détecté.',
    listenCount,
    fixCount,
  };
}

function categoryStats(summary) {
  const total = summary?.total ?? 0;
  const ok = summary?.ok ?? 0;
  return {
    total,
    ok,
    needsFix: Math.max(0, total - ok),
  };
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

function SplitStat({ ok, needsFix }) {
  return (
    <div className="checker-split-stat">
      <span className="checker-split-stat-ok"><strong>{ok}</strong> OK</span>
      <span className={`checker-split-stat-fix ${needsFix === 0 ? 'is-clean' : ''}`}>
        <strong>{needsFix}</strong> à corriger
      </span>
    </div>
  );
}

function SummaryTiles({ report, saturatedCount = 0 }) {
  const audio = categoryStats(report.audioSummary);
  const images = categoryStats(report.imageSummary);
  const title = categoryStats(report.titleSummary);
  const titleOk = title.total > 0 && title.needsFix === 0;
  const structureOk = report.structureSummary?.luniiCompatible && report.structureSummary?.storyStudioEditable;
  const nightMode = Boolean(report.nightMode?.detected);
  return (
    <div className="checker-summary-tiles" aria-label="Résumé du pack">
      <SummaryTile title="Audio" Icon={Music} tone={saturatedCount > 0 ? 'danger' : (audio.needsFix > 0 ? 'fix' : 'ok')}>
        <SplitStat ok={audio.ok} needsFix={audio.needsFix} />
      </SummaryTile>
      <SummaryTile title="Images" Icon={Image} tone={images.needsFix ? 'fix' : 'ok'}>
        <SplitStat ok={images.ok} needsFix={images.needsFix} />
      </SummaryTile>
      <SummaryTile title="Nom du pack" Icon={FilePen} tone={titleOk ? 'ok' : 'fix'}>
        <div className="checker-single-stat">
          <strong>{titleOk ? 'Valide' : 'À corriger'}</strong>
          <span>{titleOk ? 'Convention OK' : 'Métadonnées'}</span>
        </div>
      </SummaryTile>
      <SummaryTile title="Structure" Icon={Network} tone={structureOk ? 'ok' : 'listen'}>
        <div className="checker-single-stat">
          <strong>{structureOk ? 'Correcte' : 'Vérification manuelle'}</strong>
          <span>{report.structureSummary?.stageCount ?? 0} étapes</span>
        </div>
      </SummaryTile>
      <SummaryTile title="Mode nuit" Icon={Moon} tone={nightMode ? 'ok' : 'neutral'}>
        <div className="checker-single-stat">
          <strong>{nightMode ? 'Disponible' : 'Absent'}</strong>
          <span>{nightMode ? 'Détecté dans le pack' : 'Non bloquant'}</span>
        </div>
      </SummaryTile>
    </div>
  );
}

function TechnicalDetail({ record }) {
  const item = record.item;
  return (
    <div className="checker-tech-detail">
      <div>
        <div className="checker-tech-title">Mesures</div>
        {record.kind === 'audio' ? (
          audioMeasureRows(item).map((row) => (
            <Measure
              key={row.key}
              label={row.label}
              value={row.value}
              status={hasMeasureIssue(record, row.key) ? 'bad' : 'ok'}
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
            <Measure label="Attendu" value="320×240" status={expectedImageOk(item) ? 'ok' : 'bad'} />
          </>
        ) : (
          <Measure label="Catégorie" value={record.issue.category} status={record.issue.severity === 'ok' ? 'ok' : 'bad'} />
        )}
      </div>
      <div>
        <div className="checker-tech-title">Ce qu'on va faire</div>
        {record.issues.map((issue, index) => (
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

function ProblemGroupCard({ group, expanded, onToggle, countValue = group.count, countLabel = null }) {
  const [openFile, setOpenFile] = useState(null);
  const Icon = group.Icon;
  const displayedCountLabel = countLabel || (countValue > 1 ? 'fichiers' : 'fichier');
  return (
    <div className={`checker-group checker-group--${group.bucket} checker-group--${group.id} ${expanded ? 'is-expanded' : ''}`}>
      <button type="button" className="checker-group-head" onClick={onToggle}>
        <span className="checker-group-icon"><IconFrame Icon={Icon} /></span>
        <span className="checker-group-copy">
          <span className="checker-group-title-row">
            <strong>{group.title}</strong>
            <span className="checker-group-badge">{group.badge}</span>
          </span>
          <span>{group.bucket === 'fix' ? group.action : group.explanation}</span>
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
              <MiniFile
                key={record.id}
                record={record}
                open={openFile === record.id}
                onToggle={() => setOpenFile(openFile === record.id ? null : record.id)}
              />
            ))}
          </div>
          {group.bucket === 'listen' ? (
            <div className="checker-group-help">
              <IconFrame Icon={Info} />
              Ces fichiers ne sont pas corrigés automatiquement.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FixableCorrectionsList({ report }) {
  const groups = useMemo(
    () => buildProblemGroups(report).filter((group) => group.bucket === 'fix'),
    [report],
  );

  if (!groups.length) {
    return (
      <div className="checker-empty checker-empty--success">
        <IconFrame Icon={Check} />
        Aucune correction automatique à appliquer.
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
          countValue={group.fixCount}
          countLabel={group.fixCount > 1 ? 'corrections' : 'correction'}
        />
      ))}
    </div>
  );
}

export function ReportView({ report, busy, canFix, onExportReport, onFixPack, onStartFix, showFixButton = true }) {
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
          <strong>{summary.title}</strong>
          <span>{summary.subtitle}</span>
        </div>
        <div className="checker-report-callout">
          <Info className="checker-icon" aria-hidden="true" />
          <span><strong>{summary.listenCount}</strong> à écouter · <strong>{summary.fixCount}</strong> corrections proposées</span>
        </div>
      </div>

      <SummaryTiles report={report} saturatedCount={saturatedCount} />

      {groups.length === 0 ? (
        <div className="checker-empty checker-empty--success">
          <IconFrame Icon={Check} />
          Tout est conforme dans ce rapport.
        </div>
      ) : (
        <div className="checker-groups">
          {groups.map((group) => (
            <ProblemGroupCard
              key={group.id}
              group={group}
              expanded={expanded === group.id}
              onToggle={() => setExpanded(expanded === group.id ? null : group.id)}
            />
          ))}
        </div>
      )}

      <ConformingSection report={report} />

      <div className="checker-report-footer">
        <span><strong>{summary.fixCount}</strong> corrections prêtes.</span>
        <Button size="sm" onClick={() => onExportReport('report')}>
          <Download className="checker-button-icon" aria-hidden="true" />
          Exporter le rapport
        </Button>
        {showFixButton ? (
          <button
            type="button"
            className="chrome-toolbar-cta checker-correction-cta"
            onClick={startFixFlow}
            disabled={!canFix || busy}
          >
            {busy ? 'Correction...' : 'Corriger le pack'}
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
  if (!report) return null;
  return (
    <details className="checker-log">
      <summary>Journal technique</summary>
      <div className="checker-log-actions">
        <Button size="sm" onClick={onCopyLog}>Copier le log</Button>
        <Button size="sm" onClick={() => onExportLog('log')}>Exporter le log</Button>
        <Button size="sm" onClick={() => onExportJson('json')}>Exporter JSON</Button>
      </div>
      <pre>{(report.technicalLog || []).join('\n')}</pre>
    </details>
  );
}

export function ProcessLog({ status, lines }) {
  const linesRef = useRef(null);
  useEffect(() => {
    const node = linesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  if (!lines?.length) return null;
  const title = status === 'fixing'
    ? 'Correction en cours'
    : status === 'analyzing'
      ? 'Analyse en cours'
      : 'Dernières opérations';
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
