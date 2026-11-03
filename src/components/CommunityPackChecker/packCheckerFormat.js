// Helpers purs (sans React) partages par l'UI du verificateur et l'export du
// rapport : formatteurs de mesures, construction des lignes audio/image, et
// predicats de conformite. Garde l'export texte independant de tout JSX.
// Les libelles sont resolus a l'appel (affichage ou export), dans la langue active.

import { checkerDecimalSeparator, translateChecker as t } from '../../i18n/checkerPresentation.js';

function formatNumber(value, digits = 1) {
  return typeof value === 'number' ? value.toFixed(digits).replace('.', checkerDecimalSeparator()) : null;
}

// Unites techniques (s, LUFS, dBTP, kHz) : invariantes, hors catalogue.
export function formatSeconds(value) {
  const formatted = formatNumber(value, 2);
  return formatted ? `${formatted} s` : t('checker:measure.value.unmeasured');
}

export function formatLufs(value) {
  const formatted = formatNumber(value, 1);
  return formatted ? `${formatted} LUFS` : t('checker:measure.value.unmeasured');
}

export function formatPeak(value) {
  const formatted = formatNumber(value, 1);
  return formatted ? `${formatted} dBTP` : t('checker:measure.value.unmeasured');
}

export function cleanLabel(label) {
  return (label || t('checker:file.label.fallback'))
    .replace(/\.mp3 (item|Stage node)$/i, '')
    .replace(/\.png$/i, '')
    .replace(/ node$/i, '');
}

export function expectedImageOk(item) {
  return item?.width === 320 && item?.height === 240;
}

// Lignes de mesure audio. Les `key` servent aussi, cote problemes, a reperer
// quelle mesure est en defaut (voir hasMeasureIssue).
export function audioMeasureRows(item) {
  return [
    { key: 'format', label: t('checker:measure.format.label'), value: `${item?.codec || t('checker:measure.codec.unknown')} · ${item?.channels || t('checker:measure.channels.unknown')}` },
    { key: 'sampleRate', label: t('checker:measure.sampleRate.label'), value: item?.sampleRate ? `${formatNumber(item.sampleRate / 1000, 1)} kHz` : t('checker:measure.value.unmeasured') },
    { key: 'silenceStart', label: t('checker:measure.silenceStart.label'), value: formatSeconds(item?.leadingSilenceSecs) },
    { key: 'silenceEnd', label: t('checker:measure.silenceEnd.label'), value: formatSeconds(item?.trailingSilenceSecs) },
    { key: 'volume', label: t('checker:measure.volume.label'), value: formatLufs(item?.integratedLufs) },
    { key: 'peak', label: t('checker:measure.peak.label'), value: formatPeak(item?.truePeakDb) },
  ];
}

export function imageMeasureRows(item) {
  return [
    { key: 'dimensions', label: t('checker:measure.dimensions.label'), value: item?.width && item?.height ? `${item.width}×${item.height}` : t('checker:measure.value.unmeasured') },
    { key: 'imageFormat', label: t('checker:measure.format.label'), value: item?.format || t('checker:measure.value.unmeasured') },
  ];
}

// Un fichier est conforme s'il n'a ni erreur ni avertissement : complement
// exact de ce qui apparait dans les cartes de problemes.
export function isConforming(status) {
  return status !== 'error' && status !== 'warning';
}

export function titleConforming(report) {
  const total = report?.titleSummary?.total ?? 0;
  const ok = report?.titleSummary?.ok ?? 0;
  return total > 0 && total - ok === 0;
}

export function structureConforming(report) {
  return Boolean(report?.structureSummary?.luniiCompatible && report?.structureSummary?.storyStudioEditable);
}
