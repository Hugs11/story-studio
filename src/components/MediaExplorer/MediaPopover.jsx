import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocalFile } from '../../store/useLocalFile';
import './MediaPopover.css';

function fmt(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '--:--';
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function waveHeights(name, bars = 28) {
  const heights = [];
  for (let i = 0; i < bars; i++) {
    const c = name.charCodeAt(i % name.length) || 65;
    heights.push(4 + ((c * 7 + i * 13) % 14));
  }
  return heights;
}

function tagHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  return (h * 137.5) % 360;
}
function tagStyle(name) {
  return { background: `hsl(${Math.round(tagHue(name))},55%,45%)`, color: '#fff' };
}

function PopoverAudioPlayer({ path, name }) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(null);
  const audioRef = useRef(null);
  const url = useLocalFile(path);
  const heights = waveHeights(name);
  const progress = duration ? Math.min(1, current / duration) : 0;

  useEffect(() => {
    const a = audioRef.current;
    if (!a || !url) return;
    a.src = url;
    a.load();
    a.play().catch(() => {});
    return () => { a.pause(); a.src = ''; };
  }, [url]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); } else { a.play().catch(() => {}); }
  }

  function handleWaveClick(e) {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    a.currentTime = ratio * duration;
  }

  return (
    <div className="mp-audio-player">
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
      />
      <div className="mp-waveform" onClick={handleWaveClick} title="Cliquer pour chercher">
        {heights.map((h, i) => (
          <span
            key={i}
            className={`mp-wave-bar${i / heights.length < progress ? ' is-played' : ''}`}
            style={{ height: h }}
          />
        ))}
        <div className="mp-waveform-progress" style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="mp-transport">
        <button className="mp-play-btn" type="button" onClick={toggle} title={playing ? 'Pause' : 'Lire'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="mp-timer">{fmt(current)} / {duration != null ? fmt(duration) : '--:--'}</span>
      </div>
    </div>
  );
}

function TagEditor({ path, itemTags, allProjectTags, onAddMediaTag, onRemoveMediaTag }) {
  const [newTag, setNewTag] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const t = newTag.trim();
    if (t) { onAddMediaTag(path, t); setNewTag(''); }
  }

  return (
    <div className="mp-tag-section">
      <div className="mp-tag-chips">
        {itemTags.map((tag) => (
          <span key={tag} className="mp-tag-chip" style={tagStyle(tag)}>
            {tag}
            <button
              type="button"
              className="mp-tag-remove"
              onClick={() => onRemoveMediaTag(path, tag)}
              title={`Retirer le tag "${tag}"`}
            >×</button>
          </span>
        ))}
        {allProjectTags.filter((t) => !itemTags.includes(t)).map((tag) => (
          <button
            key={tag}
            type="button"
            className="mp-tag-available"
            style={{ borderColor: tagStyle(tag).background, color: tagStyle(tag).background }}
            onClick={() => onAddMediaTag(path, tag)}
            title={`Ajouter le tag "${tag}"`}
          >
            + {tag}
          </button>
        ))}
      </div>
      <form className="mp-tag-form" onSubmit={handleSubmit}>
        <input
          className="mp-tag-input"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="+ Nouveau tag"
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
    </div>
  );
}

export function MediaPopover({
  item, anchorRect, getMeta, onSelectNode, onOpenAiQueue, onClose,
  itemTags = [], allProjectTags = [], onAddMediaTag, onRemoveMediaTag,
}) {
  const popRef = useRef(null);
  const imageUrl = useLocalFile(item.kind === 'image' ? item.path : null);
  const meta = getMeta ? getMeta(item.path) : null;
  const [pos, setPos] = useState(null);

  // Calculate position after first paint (needs rendered dimensions)
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop || !anchorRect) return;
    const { width: pw, height: ph } = pop.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchorRect.left + anchorRect.width / 2 - pw / 2;
    let top = anchorRect.top - ph - 10;
    if (top < 8) top = anchorRect.bottom + 10;
    left = Math.max(8, Math.min(vw - pw - 8, left));
    top = Math.max(8, Math.min(vh - ph - 8, top));
    setPos({ left, top });
  }, [anchorRect]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    function onDown(e) {
      if (popRef.current && !popRef.current.contains(e.target)) onClose();
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  const firstUsage = item.usages.find((u) => u.entryId) ?? null;

  function handleGoTo() {
    if (firstUsage?.entryId && onSelectNode) onSelectNode(firstUsage.entryId);
    onClose();
  }

  const hasTagActions = onAddMediaTag && onRemoveMediaTag;

  const style = pos
    ? { position: 'fixed', left: pos.left, top: pos.top, opacity: 1 }
    : { position: 'fixed', left: -9999, top: -9999, opacity: 0 };

  return createPortal(
    <div ref={popRef} className="media-popover" style={style} role="dialog" aria-modal="true">
      <div className="mp-header">
        <span className="mp-filename" title={item.path}>{item.name}</span>
        <button className="mp-close-btn" type="button" onClick={onClose} title="Fermer">×</button>
      </div>

      {item.kind === 'image' && (
        <>
          <div className="mp-image-preview">
            {imageUrl
              ? <img src={imageUrl} alt={item.name} draggable={false} />
              : <div className="mp-image-placeholder" />}
          </div>
          {meta?.width ? (
            <div className="mp-meta-row">{meta.width} × {meta.height} px</div>
          ) : null}
        </>
      )}

      {item.kind === 'audio' && (
        <>
          <PopoverAudioPlayer path={item.path} name={item.name} />
          {firstUsage?.entryId && onSelectNode ? (
            <button className="btn mp-action-btn mp-action-btn--goto" type="button" onClick={handleGoTo}>
              → Aller vers « {firstUsage.label} »
            </button>
          ) : null}
        </>
      )}

      {hasTagActions && (
        <>
          <div className="mp-sep" />
          <TagEditor
            path={item.path}
            itemTags={itemTags}
            allProjectTags={allProjectTags}
            onAddMediaTag={onAddMediaTag}
            onRemoveMediaTag={onRemoveMediaTag}
          />
        </>
      )}
    </div>,
    document.body,
  );
}
