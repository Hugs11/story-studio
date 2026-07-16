import { fmtSize, fmtHz } from '../../hooks/useMediaMetadata';
import { stripWindowsLongPathPrefix } from '../../utils/fileUtils';

export const cleanPath = stripWindowsLongPathPrefix;

export function formatDuration(secs) {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function tagHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  return (h * 137.5) % 360;
}

export function tagStyle(name) {
  return { background: `hsl(${Math.round(tagHue(name))},55%,45%)`, color: '#fff' };
}

export function waveHeights(name, bars = 18) {
  const heights = [];
  for (let i = 0; i < bars; i++) {
    const c = name.charCodeAt(i % name.length) || 65;
    heights.push(4 + ((c * 7 + i * 13) % 14));
  }
  return heights;
}

export function kindLabel(kind) {
  if (kind === 'image') return 'Image';
  if (kind === 'audio') return 'Son';
  if (kind === 'archive') return 'Archive';
  return 'Fichier';
}

export function getMetaDisplay(item, m, duration) {
  if (!item.exists) return { size: '—', dim: '—', dur: '—', fmt: item.ext.toUpperCase() };
  const size = m ? fmtSize(m.size_bytes) : '…';
  let dim = '…';
  let dur = '…';
  let fmt = item.ext.toUpperCase();
  if (item.kind === 'image') {
    dim = m ? (m.width ? `${m.width}×${m.height}` : '—') : '…';
    dur = '—';
  } else if (item.kind === 'audio') {
    dim = '—';
    dur = duration || (m?.duration_secs != null ? formatDuration(m.duration_secs) : (m ? '—' : '…'));
    if (m) {
      const codec = (m.codec || item.ext).toUpperCase();
      const hz = m.sample_rate ? ` · ${fmtHz(m.sample_rate)}` : '';
      fmt = `${codec}${hz}`;
    }
  } else {
    dim = m ? '—' : '…';
    dur = '—';
  }
  return { size, dim, dur, fmt };
}
