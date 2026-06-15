import { useEffect, useMemo, useState } from 'react';
import { Button } from '../common/Button';
import { AppModalPortal } from '../common/AppModalPortal';
import {
  Check,
  ChevronDown,
  CircleCheck,
  Download,
  Image,
  Info,
  Loader2,
  Moon,
  Music,
  Network,
  Package,
  Scissors,
  Square,
  TriangleAlert,
  Wrench,
  X,
} from '../icons/LucideLocal';
import { useCommunityPackChecker } from './useCommunityPackChecker';
import './CommunityPackChecker.css';

const PROBLEM_SECTIONS = [
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
    action: 'On ajuste le silence vers 0,75 s.',
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
    id: 'structure',
    title: 'Structure à vérifier',
    badge: 'Manuel',
    bucket: 'listen',
    Icon: Network,
    explanation: 'Un lien, une référence ou un champ du pack demande une vérification.',
    action: 'Vérifie la navigation ou les fichiers référencés.',
    match: (issue) => issue.category === 'structure' || issue.category === 'title',
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

function formatNumber(value, digits = 1) {
  return typeof value === 'number' ? value.toFixed(digits).replace('.', ',') : null;
}

function formatSeconds(value) {
  const formatted = formatNumber(value, 2);
  return formatted ? `${formatted} s` : 'Non mesuré';
}

function formatLufs(value) {
  const formatted = formatNumber(value, 1);
  return formatted ? `${formatted} LUFS` : 'Non mesuré';
}

function formatPeak(value) {
  const formatted = formatNumber(value, 1);
  return formatted ? `${formatted} dBTP` : 'Non mesuré';
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
      return `Niveau sonore = ${formatLufs(item?.integratedLufs)}`;
    }
    if (lower.includes('fréquence')) {
      return `${message} (${item?.sampleRate ? `${item.sampleRate} Hz` : 'non mesuré'})`;
    }
    if (lower.includes('mono')) {
      return `${message} (${item?.channels || 'canaux non mesurés'})`;
    }
    if (lower.includes('format')) {
      return `${message} (${item?.codec || 'format non mesuré'})`;
    }
  }
  if (kind === 'image') {
    const dimensions = item?.width && item?.height ? `${item.width}×${item.height}` : 'dimensions non mesurées';
    const format = item?.format || 'format non mesuré';
    return `Image = ${dimensions} · ${format}`;
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
  if (record.kind === 'audio') {
    const silenceIssues = record.issues.filter((issue) => (issue.message || '').toLowerCase().includes('silence'));
    if (silenceIssues.length > 0) {
      const parts = silenceSummaryParts(silenceIssues, record.item);
      if (parts.length > 0) return parts.join(' | ');
    }

    if (record.issues.some((issue) => (issue.message || '').toLowerCase().includes('volume'))) {
      return `Niveau sonore = ${formatLufs(record.item?.integratedLufs)}`;
    }
  }

  if (record.kind === 'image') {
    const dimensions = record.item?.width && record.item?.height
      ? `${record.item.width}×${record.item.height}`
      : 'dimensions non mesurées';
    const format = record.item?.format || 'format non mesuré';
    return `Image = ${dimensions} · ${format}`;
  }

  return record.issues
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

function expectedImageOk(item) {
  return item?.width === 320 && item?.height === 240;
}

function cleanLabel(label) {
  return (label || 'Fichier')
    .replace(/\.mp3 (item|Stage node)$/i, '')
    .replace(/\.png$/i, '')
    .replace(/ node$/i, '');
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
      records.push({
        id: `${section.id}:${key}`,
        issue,
        issues: issue.filePath ? (issuesByFilePath(report).get(issue.filePath) || [issue]) : [issue],
        item: itemEntry?.item || null,
        kind: itemEntry?.kind || issue.category,
      });
    }
    return {
      ...section,
      records,
      count: records.length,
      fixCount: records.reduce((sum, record) => (
        sum + record.issues.filter((issue) => issue.autoFixAvailable).length
      ), 0),
    };
  }).filter((group) => group.count > 0);
}

function summarizeGroups(groups, report) {
  const listenCount = groups
    .filter((group) => group.bucket === 'listen')
    .reduce((sum, group) => sum + group.count, 0);
  const fixCount = groups
    .filter((group) => group.bucket === 'fix')
    .reduce((sum, group) => sum + group.fixCount, 0);
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
  if (listenCount > 0) {
    return {
      tone: 'listen',
      Icon: Info,
      title: 'Pack corrigeable, avec quelques fichiers à écouter',
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
      <span className="checker-split-stat-fix"><strong>{needsFix}</strong> à corriger</span>
    </div>
  );
}

function SummaryTiles({ report }) {
  const audio = categoryStats(report.audioSummary);
  const images = categoryStats(report.imageSummary);
  const structureOk = report.structureSummary?.luniiCompatible && report.structureSummary?.storyStudioEditable;
  const nightMode = Boolean(report.nightMode?.detected);
  return (
    <div className="checker-summary-tiles" aria-label="Résumé du pack">
      <SummaryTile title="Audio" Icon={Music} tone={audio.needsFix ? 'fix' : 'ok'}>
        <SplitStat ok={audio.ok} needsFix={audio.needsFix} />
      </SummaryTile>
      <SummaryTile title="Images" Icon={Image} tone={images.needsFix ? 'fix' : 'ok'}>
        <SplitStat ok={images.ok} needsFix={images.needsFix} />
      </SummaryTile>
      <SummaryTile title="Structure" Icon={Network} tone={structureOk ? 'ok' : 'listen'}>
        <div className="checker-single-stat">
          <strong>{structureOk ? 'Correcte' : 'À vérifier'}</strong>
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
          <>
            <Measure label="Format" value={`${item?.codec || 'Inconnu'} · ${item?.channels || 'canaux ?'}`} status={hasMeasureIssue(record, 'format') ? 'bad' : 'ok'} />
            <Measure label="Échantillonnage" value={item?.sampleRate ? `${formatNumber(item.sampleRate / 1000, 1)} kHz` : 'Non mesuré'} status={hasMeasureIssue(record, 'sampleRate') ? 'bad' : 'ok'} />
            <Measure label="Silence début" value={formatSeconds(item?.leadingSilenceSecs)} status={hasMeasureIssue(record, 'silenceStart') ? 'bad' : 'ok'} />
            <Measure label="Silence fin" value={formatSeconds(item?.trailingSilenceSecs)} status={hasMeasureIssue(record, 'silenceEnd') ? 'bad' : 'ok'} />
            <Measure label="Volume" value={formatLufs(item?.integratedLufs)} status={hasMeasureIssue(record, 'volume') ? 'bad' : 'ok'} />
            <Measure label="Crête vraie" value={formatPeak(item?.truePeakDb)} status={hasMeasureIssue(record, 'peak') ? 'bad' : 'ok'} />
          </>
        ) : record.kind === 'image' ? (
          <>
            <Measure label="Dimensions" value={item?.width && item?.height ? `${item.width}×${item.height}` : 'Non mesuré'} status={hasMeasureIssue(record, 'dimensions') ? 'bad' : 'ok'} />
            <Measure label="Format" value={item?.format || 'Non mesuré'} status={hasMeasureIssue(record, 'imageFormat') ? 'bad' : 'ok'} />
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

function Measure({ label, value, status = 'ok' }) {
  const StatusIcon = status === 'bad' ? X : CircleCheck;
  return (
    <div className={`checker-measure checker-measure--${status}`}>
      <span>
        <StatusIcon className="checker-measure-icon" aria-hidden="true" />
        {label}
      </span>
      <strong>{value}</strong>
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

function ProblemGroupCard({ group, expanded, onToggle }) {
  const [openFile, setOpenFile] = useState(null);
  const Icon = group.Icon;
  return (
    <div className={`checker-group checker-group--${group.bucket} ${expanded ? 'is-expanded' : ''}`}>
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
          <strong>{group.count}</strong>
          <small>{group.count > 1 ? 'fichiers' : 'fichier'}</small>
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

function ReportView({ report, busy, canFix, onExportReport, onFixPack }) {
  const groups = useMemo(() => buildProblemGroups(report), [report]);
  const summary = useMemo(() => summarizeGroups(groups, report), [groups, report]);
  const [expanded, setExpanded] = useState(groups[0]?.id || null);
  const [confirmFix, setConfirmFix] = useState(false);
  if (!report) return null;
  const SummaryIcon = summary.Icon;

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
          <span><strong>{summary.listenCount}</strong> à écouter · <strong>{summary.fixCount}</strong> corrections auto</span>
        </div>
      </div>

      <SummaryTiles report={report} />

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

      <div className="checker-report-footer">
        <span><strong>{summary.fixCount}</strong> corrections automatiques prêtes.</span>
        <Button size="sm" onClick={() => onExportReport('report')}>
          <Download className="checker-button-icon" aria-hidden="true" />
          Exporter le rapport
        </Button>
        <button
          type="button"
          className="chrome-toolbar-cta checker-correction-cta"
          onClick={() => setConfirmFix(true)}
          disabled={!canFix || busy}
        >
          {busy ? 'Correction...' : 'Corriger le pack'}
        </button>
      </div>

      {confirmFix ? (
        <div className="checker-fix-sheet">
          <div className="checker-fix-card">
            <div className="checker-fix-head">
              <strong>Corriger le pack ?</strong>
              <span>Story Studio crée une copie corrigée. Le ZIP d'origine n'est jamais modifié.</span>
            </div>
            <div className="checker-fix-list">
              {groups.filter((group) => group.bucket === 'fix').map((group) => (
                <div className="checker-fix-row" key={group.id}>
                  <span className="checker-group-icon"><IconFrame Icon={group.Icon} /></span>
                  <div>
                    <strong>{group.action}</strong>
                    <span>{group.title}</span>
                  </div>
                  <em>{group.count}</em>
                </div>
              ))}
              {summary.listenCount > 0 ? (
                <div className="checker-listen-note">
                  <IconFrame Icon={Info} />
                  <span><strong>{summary.listenCount} fichiers</strong> resteront à vérifier manuellement.</span>
                </div>
              ) : null}
            </div>
            <div className="checker-fix-actions">
              <Button onClick={() => setConfirmFix(false)}>Annuler</Button>
              <button
                type="button"
                className="chrome-toolbar-cta checker-correction-cta"
                onClick={() => {
                  setConfirmFix(false);
                  onFixPack();
                }}
                disabled={!canFix || busy}
              >
                Créer le pack corrigé
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TechnicalLog({ report, onCopyLog, onExportLog, onExportJson }) {
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

function CheckerWorkspace({ checker, maximized, onMaximizeToggle, onClose }) {
  const busy = checker.status === 'analyzing' || checker.status === 'fixing';
  const canFix = checker.report?.correctionsAvailable > 0 && checker.status !== 'fixing';

  function handleDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    const path = file?.path || file?.webkitRelativePath;
    if (path) checker.analyzePath(path);
  }

  return (
    <div className={`checker-modal-shell ${maximized ? 'is-maximized' : ''}`} role="dialog" aria-modal="true" aria-label="Vérifier un pack">
      <header className="checker-modal-header">
        <div className="checker-modal-title">
          <span className="checker-drop-icon"><IconFrame Icon={Package} /></span>
          <div>
            <strong>Vérifier un pack</strong>
            <span title={checker.zipPath || undefined}>{checker.zipPath || 'Aucun ZIP sélectionné'}</span>
          </div>
        </div>
        <div className="checker-modal-window-actions">
          <button
            type="button"
            className="checker-modal-close"
            onClick={onMaximizeToggle}
            aria-label={maximized ? 'Réduire la fenêtre' : 'Maximiser la fenêtre'}
            title={maximized ? 'Réduire la fenêtre' : 'Maximiser la fenêtre'}
          >
            <Square className="checker-icon" aria-hidden="true" />
          </button>
          <button type="button" className="checker-modal-close" onClick={onClose} aria-label="Fermer">
            <X className="checker-icon" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="checker-modal-body">
        <div
          className="checker-drop checker-drop--modal"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="checker-drop-main">
            <div className="checker-drop-icon"><IconFrame Icon={Package} /></div>
            <div>
              <div className="checker-drop-title">Vérifier un pack communautaire</div>
              <div className="checker-drop-sub">
                Analyse un ZIP existant et classe les corrections par type.
              </div>
              {checker.zipPath ? <div className="checker-path" title={checker.zipPath}>{checker.zipPath}</div> : null}
            </div>
          </div>
          <div className="checker-actions">
            <Button onClick={checker.pickPack} disabled={busy}>
              Choisir un ZIP
            </Button>
            <Button onClick={() => checker.analyzePath(checker.zipPath)} disabled={busy || !checker.zipPath}>
              {checker.status === 'analyzing' ? 'Analyse...' : 'Relancer'}
            </Button>
          </div>
        </div>

        {busy ? (
          <div className="checker-loading">
            <IconFrame Icon={Loader2} />
            <span>{checker.status === 'fixing' ? 'Création du ZIP corrigé...' : 'Analyse du pack...'}</span>
          </div>
        ) : null}

        {checker.error ? <div className="info-box warn">{checker.error}</div> : null}
        {checker.exportNotice ? <div className="info-box">{checker.exportNotice}</div> : null}
        {checker.fixedResult ? (
          <div className="checker-fixed">
            <span>ZIP corrigé créé : <strong>{checker.fixedResult.fixedZipPath}</strong></span>
            <Button size="sm" onClick={checker.openFixedLocation}>Ouvrir</Button>
          </div>
        ) : null}

        <ReportView
          report={checker.report}
          busy={busy}
          canFix={canFix}
          onExportReport={checker.exportReport}
          onFixPack={checker.fixPack}
        />
        <TechnicalLog
          report={checker.report}
          onCopyLog={checker.copyLog}
          onExportLog={checker.exportReport}
          onExportJson={checker.exportReport}
        />
      </div>
    </div>
  );
}

export function CommunityPackChecker() {
  const checker = useCommunityPackChecker();
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const busy = checker.status === 'analyzing' || checker.status === 'fixing';

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  async function handlePickFromEntry() {
    setOpen(true);
    await checker.pickPack();
  }

  return (
    <div className="checker-root">
      <div className="checker-entry">
        <div className="checker-entry-main">
          <div className="checker-drop-icon"><IconFrame Icon={Package} /></div>
          <div>
            <div className="checker-drop-title">Vérifier un pack communautaire</div>
            <div className="checker-drop-sub">
              Ouvre une fenêtre dédiée pour analyser, corriger et exporter le rapport.
            </div>
            {checker.zipPath ? <div className="checker-path" title={checker.zipPath}>{checker.zipPath}</div> : null}
          </div>
        </div>
        <div className="checker-actions">
          <Button onClick={() => setOpen(true)} disabled={busy}>
            Ouvrir
          </Button>
          <Button variant="primary" onClick={handlePickFromEntry} disabled={busy}>
            Choisir un ZIP
          </Button>
        </div>
      </div>

      {open ? (
        <AppModalPortal
          className="checker-modal-backdrop"
        >
          <div
            className="checker-modal-click-layer"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <CheckerWorkspace
              checker={checker}
              maximized={maximized}
              onMaximizeToggle={() => setMaximized((value) => !value)}
              onClose={() => setOpen(false)}
            />
          </div>
        </AppModalPortal>
      ) : null}
    </div>
  );
}
