import {
  audioMeasureRows,
  cleanLabel,
  imageMeasureRows,
  isConforming,
  structureConforming,
  titleConforming,
} from './packCheckerFormat';

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

function verdictLabel(verdict) {
  switch (verdict) {
    case 'valid':
      return 'Pack conforme';
    case 'validWithWarnings':
      return 'Pack validable avec avertissements';
    case 'needsFix':
      return 'Pack à corriger avant validation';
    case 'invalid':
      return 'Pack invalide ou illisible';
    default:
      return 'Pack analysé';
  }
}

export function reportBaseName(report) {
  return String(report?.packName || 'rapport-pack')
    .replace(/\.(zip|7z)$/i, '')
    .replace(/[<>:"/\\|?*\[\]+]/g, '_')
    .trim() || 'rapport-pack';
}

export function formatTechnicalLog(report) {
  return (report?.technicalLog || []).join('\n');
}

export function formatDiagnosticJson(report) {
  return JSON.stringify(report, null, 2);
}

export function formatReadableReport(report) {
  if (!report) return '';
  const lines = [];
  lines.push(`# Vérification du pack`);
  lines.push('');
  lines.push(`Pack analysé : ${report.packName}`);
  lines.push(`Verdict : ${verdictLabel(report.verdict)}`);
  lines.push('');
  lines.push(`- Erreurs : ${report.summary?.errors ?? 0}`);
  lines.push(`- Avertissements : ${report.summary?.warnings ?? 0}`);
  lines.push(`- Informations : ${report.summary?.infos ?? 0}`);
  lines.push(`- Éléments conformes : ${report.summary?.ok ?? 0}`);
  lines.push(`- Corrections automatiques disponibles : ${report.correctionsAvailable ?? 0}`);
  lines.push('');
  lines.push(`## Résumé`);
  lines.push('');
  lines.push(`- Audio : ${report.audioSummary?.ok ?? 0}/${report.audioSummary?.total ?? 0} conformes`);
  lines.push(`- Images : ${report.imageSummary?.ok ?? 0}/${report.imageSummary?.total ?? 0} conformes`);
  lines.push(`- Structure Lunii : ${report.structureSummary?.luniiCompatible ? 'valide' : 'à corriger'}`);
  lines.push(`- Édition Story Studio : ${report.structureSummary?.storyStudioEditable ? 'supportée' : 'non supportée ou à vérifier'}`);
  lines.push(`- Mode nuit : ${report.nightMode?.detected ? 'détecté' : 'absent'}`);
  lines.push('');
  lines.push(`## Problèmes et points à vérifier`);
  lines.push('');
  const issues = report.issues || [];
  if (issues.length === 0) {
    lines.push('Aucun problème détecté.');
  } else {
    for (const issue of issues) {
      lines.push(`- ${severityLabel(issue.severity)} · ${issue.label} : ${issue.message}`);
      if (issue.filePath) lines.push(`  Fichier : ${issue.filePath}`);
      if (issue.technicalDetails) lines.push(`  Détail : ${issue.technicalDetails}`);
      if (issue.autoFixDescription) lines.push(`  Correction : ${issue.autoFixDescription}`);
    }
  }
  lines.push('');
  lines.push(`## Ce qui est conforme`);
  lines.push('');
  const conformingAudio = (report.audioItems || []).filter((item) => isConforming(item.status));
  if (conformingAudio.length) {
    lines.push(`### Audio conforme (${conformingAudio.length})`);
    for (const item of conformingAudio) {
      const measures = audioMeasureRows(item).map((row) => `${row.label} : ${row.value}`).join(' · ');
      lines.push(`- ${cleanLabel(item.label)} — ${measures}`);
    }
    lines.push('');
  }
  const conformingImages = (report.imageItems || []).filter((item) => isConforming(item.status));
  if (conformingImages.length) {
    lines.push(`### Images conformes (${conformingImages.length})`);
    for (const item of conformingImages) {
      const measures = imageMeasureRows(item).map((row) => `${row.label} : ${row.value}`).join(' · ');
      lines.push(`- ${cleanLabel(item.label)} — ${measures}`);
    }
    lines.push('');
  }
  if (titleConforming(report)) {
    lines.push(`### Nom du pack`);
    lines.push(`- Nom : ${report.packName || '—'}`);
    lines.push(`- Titre : ${report.packTitle || '—'}`);
    lines.push(`- Version : ${report.packVersion ?? '—'}`);
    lines.push('');
  }
  if (structureConforming(report)) {
    const structure = report.structureSummary || {};
    lines.push(`### Structure`);
    lines.push(`- Compatible Lunii : ${structure.luniiCompatible ? 'oui' : 'non'}`);
    lines.push(`- Éditable Story Studio : ${structure.storyStudioEditable ? 'oui' : 'non'}`);
    lines.push(`- Histoires : ${structure.storyCount ?? 0}`);
    lines.push(`- Étapes : ${structure.stageCount ?? 0}`);
    lines.push(`- Actions : ${structure.actionCount ?? 0}`);
    lines.push(`- Audios référencés : ${structure.referencedAudioCount ?? 0}`);
    lines.push(`- Images référencées : ${structure.referencedImageCount ?? 0}`);
    lines.push('');
  }
  lines.push(`### Mode nuit`);
  lines.push(`- Mode nuit : ${report.nightMode?.detected ? 'disponible' : 'absent'}`);
  lines.push(`- Bloquant : non`);
  lines.push('');
  lines.push(`## Journal technique`);
  lines.push('');
  lines.push('```text');
  lines.push(formatTechnicalLog(report));
  lines.push('```');
  return lines.join('\n');
}
