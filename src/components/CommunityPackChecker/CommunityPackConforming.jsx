// Section « Ce qui est conforme » : miroir vert des cartes de problemes.
// Toute la donnee vient deja du rapport (report.audioItems / imageItems avec
// leur `status`, et les resumes pack-level) : aucun appel backend.

import { useMemo, useState } from 'react';
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
    return `Silence ${formatSeconds(item.leadingSilenceSecs)} / ${formatSeconds(item.trailingSilenceSecs)} · ${formatLufs(item.integratedLufs)}`;
  }
  const dimensions = item.width && item.height ? `${item.width}×${item.height}` : 'dimensions ?';
  return `${dimensions} · ${item.format || 'format ?'}`;
}

function buildConformingGroups(report) {
  if (!report) return [];
  const groups = [];

  const audioFiles = (report.audioItems || []).filter((item) => isConforming(item.status));
  if (audioFiles.length) {
    groups.push({
      id: 'audio',
      title: 'Audio conforme',
      subtitle: 'Silence, volume, format et crête dans les clous.',
      Icon: Music,
      mode: 'files',
      kind: 'audio',
      files: audioFiles,
      metricStrong: String(audioFiles.length),
      metricSmall: audioFiles.length > 1 ? 'fichiers' : 'fichier',
    });
  }

  const imageFiles = (report.imageItems || []).filter((item) => isConforming(item.status));
  if (imageFiles.length) {
    groups.push({
      id: 'image',
      title: 'Images conformes',
      subtitle: 'Dimensions et format conformes.',
      Icon: Image,
      mode: 'files',
      kind: 'image',
      files: imageFiles,
      metricStrong: String(imageFiles.length),
      metricSmall: imageFiles.length > 1 ? 'fichiers' : 'fichier',
    });
  }

  if (titleConforming(report)) {
    groups.push({
      id: 'title',
      title: 'Nom du pack',
      subtitle: 'Nom et convention valides.',
      Icon: FilePen,
      mode: 'facts',
      metricStrong: 'Valide',
      metricSmall: 'Convention OK',
      facts: [
        { key: 'name', label: 'Nom', value: report.packName || '—' },
        { key: 'title', label: 'Titre', value: report.packTitle || '—' },
        { key: 'version', label: 'Version', value: String(report.packVersion ?? '—') },
      ],
    });
  }

  if (structureConforming(report)) {
    const structure = report.structureSummary || {};
    groups.push({
      id: 'structure',
      title: 'Structure',
      subtitle: 'Navigation et références cohérentes.',
      Icon: Network,
      mode: 'facts',
      metricStrong: 'Correcte',
      metricSmall: `${structure.stageCount ?? 0} étapes`,
      facts: [
        { key: 'lunii', label: 'Compatible Lunii', value: structure.luniiCompatible ? 'Oui' : 'Non' },
        { key: 'editable', label: 'Éditable Story Studio', value: structure.storyStudioEditable ? 'Oui' : 'Non' },
        { key: 'stories', label: 'Histoires', value: String(structure.storyCount ?? 0) },
        { key: 'stages', label: 'Étapes', value: String(structure.stageCount ?? 0) },
        { key: 'actions', label: 'Actions', value: String(structure.actionCount ?? 0) },
        { key: 'refAudio', label: 'Audios référencés', value: String(structure.referencedAudioCount ?? 0) },
        { key: 'refImage', label: 'Images référencées', value: String(structure.referencedImageCount ?? 0) },
      ],
    });
  }

  const nightDetected = Boolean(report.nightMode?.detected);
  groups.push({
    id: 'night',
    title: 'Mode nuit',
    subtitle: nightDetected ? 'Piste nuit détectée dans le pack.' : 'Aucune piste nuit (non requis).',
    Icon: Moon,
    mode: 'facts',
    metricStrong: nightDetected ? 'Disponible' : 'Absent',
    metricSmall: 'Non bloquant',
    facts: [
      { key: 'detected', label: 'Mode nuit', value: nightDetected ? 'Disponible' : 'Absent' },
      { key: 'blocking', label: 'Bloquant', value: 'Non' },
    ],
  });

  return groups;
}

function ConformingMeasures({ rows, title = 'Mesures' }) {
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
    : [...imageMeasureRows(item), { key: 'expected', label: 'Attendu', value: '320×240' }];
  const summary = fileSummary(kind, item);
  return (
    <div className="checker-mini-file">
      <button type="button" className="checker-mini-file-button" onClick={onToggle}>
        <span className="checker-role">{kind === 'audio' ? 'Audio' : 'Image'}</span>
        <span className="checker-mini-name" title={item.filePath || item.label}>{cleanLabel(item.label)}</span>
        <span className="checker-mini-problem" title={summary}>{summary}</span>
        <span className="checker-mini-severity checker-mini-severity--ok">OK</span>
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
            <span className="checker-group-badge">Conforme</span>
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
            <ConformingMeasures rows={group.facts} title="Détails" />
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ConformingSection({ report }) {
  const groups = useMemo(() => buildConformingGroups(report), [report]);
  const [expanded, setExpanded] = useState(null);
  if (!groups.length) return null;
  return (
    <div className="checker-conform">
      <div className="checker-conform-head">
        <IconFrame Icon={Check} />
        Ce qui est conforme
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
