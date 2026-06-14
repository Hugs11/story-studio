import { useMemo, useState } from 'react';
import { Button } from '../common/Button';
import {
  CircleCheck,
  CircleX,
  ChevronRight,
  Info,
  Loader2,
  Package,
  TriangleAlert,
} from '../icons/LucideLocal';
import { useCommunityPackChecker } from './useCommunityPackChecker';
import './CommunityPackChecker.css';

const CATEGORY_LABELS = {
  audio: 'Audio',
  image: 'Images',
  structure: 'Structure',
  title: 'Titre',
  nightMode: 'Mode nuit',
  metadata: 'Métadonnées',
};

const FILTERS = [
  { id: 'all', label: 'Tous' },
  { id: 'error', label: 'Erreurs' },
  { id: 'warning', label: 'Avertissements' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Images' },
  { id: 'structure', label: 'Structure' },
];

const ISSUE_GROUPS = [
  {
    id: 'audioSilenceShort',
    category: 'audio',
    tone: 'warning',
    label: 'fichiers audios ont un silence trop court',
    match: (issue) => issue.category === 'audio' && issue.message.includes('silence') && issue.message.includes('trop court'),
  },
  {
    id: 'audioSilenceLong',
    category: 'audio',
    tone: 'warning',
    label: 'fichiers audios ont un silence trop long',
    match: (issue) => issue.category === 'audio' && issue.message.includes('silence') && issue.message.includes('trop long'),
  },
  {
    id: 'audioSilenceUnknown',
    category: 'audio',
    tone: 'warning',
    label: 'fichiers audios ont un silence non mesurable',
    match: (issue) => issue.category === 'audio' && issue.message.includes('silence') && issue.message.includes('pas pu être mesuré'),
  },
  {
    id: 'imageFormat',
    category: 'image',
    tone: 'warning',
    label: 'images sont au mauvais format',
    match: (issue) => issue.category === 'image' && issue.autoFixAvailable,
  },
  {
    id: 'audioVolume',
    category: 'audio',
    tone: 'warning',
    label: 'fichiers audios ont un volume à corriger',
    match: (issue) => issue.category === 'audio' && issue.message.includes('volume'),
  },
  {
    id: 'audioFormat',
    category: 'audio',
    tone: 'error',
    label: 'fichiers audios ne sont pas au format Lunii',
    match: (issue) => issue.category === 'audio' && (
      issue.message.includes('format')
      || issue.message.includes('fréquence')
      || issue.message.includes('mono')
    ),
  },
  {
    id: 'missingRefs',
    category: 'structure',
    tone: 'error',
    label: 'références de fichiers sont cassées',
    match: (issue) => issue.category === 'structure' && issue.message.includes('absent'),
  },
  {
    id: 'structure',
    category: 'structure',
    tone: 'warning',
    label: 'points de structure sont à vérifier',
    match: (issue) => issue.category === 'structure' && !issue.message.includes('absent'),
  },
  {
    id: 'title',
    category: 'title',
    tone: 'warning',
    label: 'points de titre sont à vérifier',
    match: (issue) => issue.category === 'title' && issue.severity !== 'ok',
  },
];

function IconFrame({ Icon }) {
  return <Icon className="checker-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function verdictCopy(verdict) {
  switch (verdict) {
    case 'valid':
      return {
        title: 'Pack conforme',
        tone: 'ok',
        Icon: CircleCheck,
      };
    case 'validWithWarnings':
      return {
        title: 'Pack validable avec avertissements',
        tone: 'warning',
        Icon: TriangleAlert,
      };
    case 'needsFix':
      return {
        title: 'Pack à corriger avant validation',
        tone: 'error',
        Icon: TriangleAlert,
      };
    case 'invalid':
      return {
        title: 'Pack invalide ou illisible',
        tone: 'error',
        Icon: CircleX,
      };
    default:
      return {
        title: 'Pack à analyser',
        tone: 'info',
        Icon: Info,
      };
  }
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

function formatSeconds(value) {
  return typeof value === 'number' ? `${value.toFixed(2)} s` : 'Non mesuré';
}

function formatLufs(value) {
  return typeof value === 'number' ? `${value.toFixed(1)} LUFS` : 'Non mesuré';
}

function formatPeak(value) {
  return typeof value === 'number' ? `${value.toFixed(1)} dBTP` : 'Non mesuré';
}

function VerdictPanel({ report }) {
  if (!report) return null;
  const copy = verdictCopy(report.verdict);
  return (
    <div className={`checker-verdict checker-verdict--${copy.tone}`}>
      <div className="checker-verdict-main">
        <div className="checker-verdict-icon"><IconFrame Icon={copy.Icon} /></div>
        <div className="checker-verdict-text">
          <div className="checker-pack-name" title={report.packName}>{report.packName}</div>
          <div className="checker-verdict-title">{copy.title}</div>
        </div>
      </div>
      <div className="checker-verdict-stats">
        <span>{report.summary.errors} erreurs</span>
        <span>{report.summary.warnings} avertissements</span>
        <span>{report.summary.ok} conformes</span>
        <span>{report.correctionsAvailable} corrections</span>
      </div>
    </div>
  );
}

function uniqueIssueKey(issue) {
  return issue.filePath || `${issue.category}:${issue.label}:${issue.message}`;
}

function buildProblemGroups(report) {
  const issues = (report?.issues || []).filter((issue) => (
    issue.severity === 'error' || issue.severity === 'warning'
  ));
  const used = new Set();
  const groups = ISSUE_GROUPS.map((definition) => {
    const matching = issues.filter((issue) => definition.match(issue));
    const unique = [];
    const seen = new Set();
    for (const issue of matching) {
      const key = uniqueIssueKey(issue);
      used.add(issue);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(issue);
      }
    }
    return {
      ...definition,
      issues: matching,
      unique,
      count: unique.length,
    };
  }).filter((group) => group.count > 0);

  const other = [];
  const seen = new Set();
  for (const issue of issues) {
    if (used.has(issue)) continue;
    const key = uniqueIssueKey(issue);
    if (!seen.has(key)) {
      seen.add(key);
      other.push(issue);
    }
  }
  if (other.length > 0) {
    groups.push({
      id: 'other',
      tone: other.some((issue) => issue.severity === 'error') ? 'error' : 'warning',
      label: 'autres points sont à vérifier',
      issues: other,
      unique: other,
      count: other.length,
    });
  }
  return groups;
}

function IssueRow({ issue, compact = false }) {
  return (
    <div className={`checker-issue checker-issue--${issue.severity} ${compact ? 'checker-issue--compact' : ''}`}>
      <div className="checker-issue-main">
        <span className="checker-severity">{severityLabel(issue.severity)}</span>
        <div className="checker-issue-text">
          <strong>{issue.label}</strong>
          <span>{issue.message}</span>
        </div>
      </div>
      <div className="checker-issue-meta">
        <span>{CATEGORY_LABELS[issue.category] || issue.category}</span>
        {issue.itemType ? <span>{issue.itemType}</span> : null}
        {issue.filePath ? <span title={issue.filePath}>{issue.filePath}</span> : null}
      </div>
      {issue.technicalDetails ? <div className="checker-issue-detail">{issue.technicalDetails}</div> : null}
      {issue.autoFixDescription ? <div className="checker-issue-fix">{issue.autoFixDescription}</div> : null}
    </div>
  );
}

function issuesByFilePath(report) {
  const map = new Map();
  for (const issue of report?.issues || []) {
    if (!issue.filePath) continue;
    if (!map.has(issue.filePath)) {
      map.set(issue.filePath, []);
    }
    map.get(issue.filePath).push(issue);
  }
  return map;
}

function itemDiagnostics(item, issueMap) {
  return issueMap.get(item.filePath) || [];
}

function diagnosticText(issues) {
  if (!issues.length) return 'Aucun diagnostic.';
  return issues
    .map((issue) => {
      const detail = issue.technicalDetails ? ` ${issue.technicalDetails}` : '';
      return `${severityLabel(issue.severity)} : ${issue.message}${detail}`;
    })
    .join('\n');
}

function DiagnosticCell({ issues }) {
  if (!issues.length) {
    return <span className="checker-diagnostic checker-diagnostic--ok">OK</span>;
  }
  const highest = issues.some((issue) => issue.severity === 'error') ? 'error' : 'warning';
  const short = issues
    .slice(0, 2)
    .map((issue) => issue.message)
    .join(' · ');
  const suffix = issues.length > 2 ? ` +${issues.length - 2}` : '';
  return (
    <span className={`checker-diagnostic checker-diagnostic--${highest}`} title={diagnosticText(issues)}>
      {short}{suffix}
    </span>
  );
}

function QuickReport({ report, onExportLog, onExportReport, onFixPack, canFix, busy }) {
  const groups = useMemo(() => buildProblemGroups(report), [report]);
  if (!report) return null;
  return (
    <div className="checker-quick">
      <div className="checker-quick-head">
        <div>
          <div className="checker-section-title">Résumé rapide</div>
          <div className="checker-quick-sub">
            {report.summary.errors} erreurs · {report.summary.warnings} avertissements · {report.summary.ok} éléments conformes
          </div>
        </div>
        <div className="checker-quick-actions">
          <Button size="sm" onClick={() => onExportLog('log')}>Exporter les logs</Button>
          <Button size="sm" onClick={() => onExportReport('report')}>Exporter le rapport</Button>
          <Button size="sm" variant="primary" onClick={onFixPack} disabled={!canFix || busy}>
            {busy ? 'Correction...' : 'Corriger le pack'}
          </Button>
        </div>
      </div>

      <div className="checker-quick-lines">
        {groups.length === 0 ? (
          <div className="checker-quick-line checker-quick-line--ok">
            <span>✓</span>
            <strong>Aucun problème bloquant ou avertissement détecté</strong>
          </div>
        ) : groups.map((group) => (
          <div key={group.id} className={`checker-quick-line checker-quick-line--${group.tone}`}>
            <span>{group.tone === 'error' ? '×' : '!'}</span>
            <strong>{group.count}</strong>
            <span>{group.label}</span>
          </div>
        ))}
        <div className="checker-quick-line checker-quick-line--ok">
          <span>✓</span>
          <span>Mode nuit {report.nightMode?.detected ? 'disponible' : 'absent'}</span>
        </div>
        <div className={`checker-quick-line checker-quick-line--${report.structureSummary?.storyStudioEditable ? 'ok' : 'warning'}`}>
          <span>{report.structureSummary?.storyStudioEditable ? '✓' : '!'}</span>
          <span>Édition Story Studio {report.structureSummary?.storyStudioEditable ? 'possible' : 'non supportée ou à vérifier'}</span>
        </div>
      </div>

      {groups.length === 0 ? null : (
        <div className="checker-accused-list">
          {groups.map((group) => (
            <div key={group.id} className="checker-accused-group">
              <div className="checker-accused-title">
                {group.count} {group.label}
              </div>
              <div className="checker-accused-items">
                {group.unique.map((issue, index) => (
                  <div key={`${group.id}-${uniqueIssueKey(issue)}-${index}`} className="checker-accused-item">
                    <strong>{issue.label}</strong>
                    {issue.filePath ? <span title={issue.filePath}>{issue.filePath}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AudioDetails({ items, issueMap }) {
  if (!items?.length) return <div className="checker-empty">Aucun audio référencé détecté.</div>;
  return (
    <div className="checker-table-wrap">
      <table className="checker-table">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Type</th>
            <th>Format</th>
            <th>Silence début</th>
            <th>Silence fin</th>
            <th>Volume</th>
            <th>Statut</th>
            <th>Diagnostic</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const diagnostics = itemDiagnostics(item, issueMap);
            return (
              <tr key={item.filePath}>
                <td title={item.filePath}>{item.label}</td>
                <td>{item.itemType}</td>
                <td>{item.codec || 'Inconnu'} · {item.channels || 'canaux ?'} · {item.sampleRate ? `${item.sampleRate} Hz` : 'Hz ?'}</td>
                <td>{formatSeconds(item.leadingSilenceSecs)}</td>
                <td>{formatSeconds(item.trailingSilenceSecs)}</td>
                <td>{formatLufs(item.integratedLufs)} · {formatPeak(item.truePeakDb)}</td>
                <td>
                  <span className={`checker-status checker-status--${item.status}`} title={diagnosticText(diagnostics)}>
                    {severityLabel(item.status)}
                  </span>
                </td>
                <td><DiagnosticCell issues={diagnostics} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ImageDetails({ items, issueMap }) {
  if (!items?.length) return <div className="checker-empty">Aucune image référencée détectée.</div>;
  return (
    <div className="checker-image-list">
      {items.map((item) => {
        const diagnostics = itemDiagnostics(item, issueMap);
        return (
          <div className="checker-image-row" key={item.filePath}>
            <div>
              <strong>{item.label}</strong>
              <span title={item.filePath}>{item.filePath}</span>
            </div>
            <div>{item.width && item.height ? `${item.width}×${item.height}` : 'Dimensions inconnues'}</div>
            <div>{item.format || 'Format inconnu'}</div>
            <div>
              <span className={`checker-status checker-status--${item.status}`} title={diagnosticText(diagnostics)}>
                {severityLabel(item.status)}
              </span>
            </div>
            <DiagnosticCell issues={diagnostics} />
          </div>
        );
      })}
    </div>
  );
}

function AllFilesDetails({ report }) {
  const [filter, setFilter] = useState('all');
  const issueMap = useMemo(() => issuesByFilePath(report), [report]);
  const audioItems = useMemo(() => {
    if (!report) return [];
    if (filter === 'image' || filter === 'structure') return [];
    return (report.audioItems || []).filter((item) => (
      filter === 'all' || filter === 'audio' || item.status === filter
    ));
  }, [filter, report]);
  const imageItems = useMemo(() => {
    if (!report) return [];
    if (filter === 'audio' || filter === 'structure') return [];
    return (report.imageItems || []).filter((item) => (
      filter === 'all' || filter === 'image' || item.status === filter
    ));
  }, [filter, report]);
  const generalIssues = useMemo(() => {
    if (!report) return [];
    return (report.issues || []).filter((issue) => {
      if (issue.filePath) return false;
      return filter === 'all' || filter === 'structure' || issue.severity === filter || issue.category === filter;
    });
  }, [filter, report]);

  if (!report) return null;
  return (
    <details className="checker-disclosure">
      <summary>
        <IconFrame Icon={ChevronRight} />
        <span>Tous les fichiers et diagnostics</span>
        <small>{(report.audioItems || []).length + (report.imageItems || []).length} fichier(s)</small>
      </summary>
      <div className="checker-filters" role="tablist" aria-label="Filtres du rapport">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`checker-filter ${filter === item.id ? 'is-active' : ''}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="checker-subsection">
        <div className="checker-subtitle">Audio</div>
        <AudioDetails items={audioItems} issueMap={issueMap} />
      </div>
      <div className="checker-subsection">
        <div className="checker-subtitle">Images</div>
        <ImageDetails items={imageItems} issueMap={issueMap} />
      </div>
      {generalIssues.length > 0 ? (
        <div className="checker-subsection">
          <div className="checker-subtitle">Diagnostics généraux</div>
          <div className="checker-issue-list checker-issue-list--compact">
            {generalIssues.map((issue, index) => (
              <IssueRow key={`${filter}-${issue.category}-${issue.label}-${index}`} issue={issue} compact />
            ))}
          </div>
        </div>
      ) : null}
      {audioItems.length === 0 && imageItems.length === 0 && generalIssues.length === 0 ? (
        <div className="checker-empty">Aucun élément pour ce filtre.</div>
      ) : null}
    </details>
  );
}

function TechnicalLog({ report, onCopyLog, onExportLog, onExportJson, onExportReport }) {
  if (!report) return null;
  return (
    <details className="checker-log">
      <summary>Journal technique</summary>
      <div className="checker-log-actions">
        <Button size="sm" onClick={onCopyLog}>Copier le log</Button>
        <Button size="sm" onClick={() => onExportLog('log')}>Exporter le log</Button>
        <Button size="sm" onClick={() => onExportJson('json')}>Exporter JSON</Button>
        <Button size="sm" onClick={() => onExportReport('report')}>Exporter le rapport</Button>
      </div>
      <pre>{(report.technicalLog || []).join('\n')}</pre>
    </details>
  );
}

export function CommunityPackChecker() {
  const checker = useCommunityPackChecker();
  const busy = checker.status === 'analyzing' || checker.status === 'fixing';
  const canFix = checker.report?.correctionsAvailable > 0 && checker.status !== 'fixing';

  function handleDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    const path = file?.path || file?.webkitRelativePath;
    if (path) {
      checker.analyzePath(path);
    }
  }

  return (
    <div className="checker-root">
      <div
        className="checker-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="checker-drop-main">
          <div className="checker-drop-icon"><IconFrame Icon={Package} /></div>
          <div>
            <div className="checker-drop-title">Vérifier un pack communautaire</div>
            <div className="checker-drop-sub">
              Analyse un ZIP existant et affiche un rapport clair pour la validation.
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

      <VerdictPanel report={checker.report} />
      <QuickReport
        report={checker.report}
        onExportLog={checker.exportReport}
        onExportReport={checker.exportReport}
        onFixPack={checker.fixPack}
        canFix={canFix}
        busy={busy}
      />
      <AllFilesDetails report={checker.report} />
      <TechnicalLog
        report={checker.report}
        onCopyLog={checker.copyLog}
        onExportLog={checker.exportReport}
        onExportJson={checker.exportReport}
        onExportReport={checker.exportReport}
      />
    </div>
  );
}
