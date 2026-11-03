// Section « Ce qui est conforme » : miroir vert des cartes de problemes.
// Toute la donnee vient deja du rapport (report.audioItems / imageItems avec
// leur `status`, et les resumes pack-level) : aucun appel backend.

import { useState } from 'react';
import { useCheckerTranslation } from '../../i18n/useCheckerTranslation.js';
import { translateChecker as t } from '../../i18n/checkerPresentation.js';
import {
  Check,
  ChevronDown,
  FilePen,
  Image,
  Moon,
  Music,
  Network,
} from '../icons/LucideLocal';
import {
  Measure,
  audioMeasureRows,
  cleanLabel,
  formatLufs,
  formatSeconds,
  imageMeasureRows,
  isConforming,
  structureConforming,
  titleConforming,
} from './packCheckerMeasures';

function IconFrame({ Icon }) {
  return <Icon className="checker-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />;
}

function fileSummary(kind, item) {
  if (kind === 'audio') {
    return t('checker:conform.audio.summary', { leading: formatSeconds(item.leadingSilenceSecs), trailing: formatSeconds(item.trailingSilenceSecs), loudness: formatLufs(item.integratedLufs) });
  }
  const dimensions = item.width && item.height ? `${item.width}×${item.height}` : t('checker:conform.dimensions.unknown');
  return `${dimensions} · ${item.format || t('checker:conform.format.unknown')}`;
}

// Construit au rendu : les libellés suivent la langue active.
function buildConformingGroups(report) {
  if (!report) return [];
  const groups = [];

  const audioFiles = (report.audioItems || []).filter((item) => isConforming(item.status));
  if (audioFiles.length) {
    groups.push({
      id: 'audio',
      title: t('checker:conform.audio.title'),
      subtitle: t('checker:conform.audio.subtitle'),
      Icon: Music,
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
      Icon: Image,
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
      Icon: FilePen,
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
      Icon: Network,
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
    Icon: Moon,
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

function ConformingMeasures({ rows, title = t('checker:detail.measures.title') }) {
  return (
    <div className="checker-tech-detail checker-tech-detail--facts">
      <div>
        <div className="checker-tech-title">{title}</div>
        {rows.map((row) => (
          <Measure key={row.key} label={row.label} value={row.value} status="ok" />
        ))}
      </div>
    </div>
  );
}

function ConformingFile({ kind, item, open, onToggle }) {
  const rows = kind === 'audio'
    ? audioMeasureRows(item)
    : [...imageMeasureRows(item), { key: 'expected', label: t('checker:detail.expected.label'), value: '320×240' }];
  const summary = fileSummary(kind, item);
  return (
    <div className="checker-mini-file">
      <button type="button" className="checker-mini-file-button" onClick={onToggle}>
        <span className="checker-role">{kind === 'audio' ? t('checker:file.role.audio') : t('checker:file.role.image')}</span>
        <span className="checker-mini-name" title={item.filePath || item.label}>{cleanLabel(item.label)}</span>
        <span className="checker-mini-problem" title={summary}>{summary}</span>
        <span className="checker-mini-severity checker-mini-severity--ok">{t('checker:severity.ok.label')}</span>
        <ChevronDown className={`checker-mini-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open ? <ConformingMeasures rows={rows} /> : null}
    </div>
  );
}

function ConformingGroupCard({ group, expanded, onToggle }) {
  const [openFile, setOpenFile] = useState(null);
  const Icon = group.Icon;
  return (
    <div className={`checker-group checker-group--ok checker-group--${group.id} ${expanded ? 'is-expanded' : ''}`}>
      <button type="button" className="checker-group-head" onClick={onToggle}>
        <span className="checker-group-icon"><IconFrame Icon={Icon} /></span>
        <span className="checker-group-copy">
          <span className="checker-group-title-row">
            <strong>{group.title}</strong>
            <span className="checker-group-badge">{t('checker:conform.badge')}</span>
          </span>
          <span>{group.subtitle}</span>
        </span>
        <span className="checker-group-count">
          <strong>{group.metricStrong}</strong>
          <small>{group.metricSmall}</small>
        </span>
        <ChevronDown className="checker-group-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="checker-group-body">
          {group.mode === 'files' ? (
            <div className="checker-mini-list">
              {group.files.map((item) => {
                const fileId = item.filePath || item.label;
                return (
                  <ConformingFile
                    key={fileId}
                    kind={group.kind}
                    item={item}
                    open={openFile === fileId}
                    onToggle={() => setOpenFile(openFile === fileId ? null : fileId)}
                  />
                );
              })}
            </div>
          ) : (
            <ConformingMeasures rows={group.facts} title={t('checker:detail.facts.title')} />
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ConformingSection({ report }) {
  useCheckerTranslation();
  const groups = buildConformingGroups(report);
  const [expanded, setExpanded] = useState(null);
  if (!groups.length) return null;
  return (
    <div className="checker-conform">
      <div className="checker-conform-head">
        <IconFrame Icon={Check} />
        {t('checker:conform.section.title')}
      </div>
      <div className="checker-groups">
        {groups.map((group) => (
          <ConformingGroupCard
            key={group.id}
            group={group}
            expanded={expanded === group.id}
            onToggle={() => setExpanded(expanded === group.id ? null : group.id)}
          />
        ))}
      </div>
    </div>
  );
}
