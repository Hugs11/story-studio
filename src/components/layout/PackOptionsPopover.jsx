import { useEffect, useRef } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { formatPackAudioEdgeSilence } from '../../config/audioProcessing';
import './PackOptionsPopover.css';

const SILENCE_MODE_OPTIONS = [
  ['normalize', 'Normaliser', `Mesure les bords et pose ${formatPackAudioEdgeSilence()} de silence.`],
  ['add', 'Ajouter', `Ajoute ${formatPackAudioEdgeSilence()} sans mesurer les bords existants.`],
  ['off', 'Off', 'Ne modifie pas les silences de début et de fin.'],
];

export function PackOptionsPopover({
  open,
  trigger,
  projectType,
  globalOptions = {},
  onOpenChange,
  onUpdateOption,
}) {
  const wrapRef = useRef(null);
  const closeTimerRef = useRef(null);
  const isSimpleProject = projectType === 'simple';

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) onOpenChange?.(false);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') onOpenChange?.(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  function updateOption(key, value) {
    onUpdateOption?.(key, value);
  }

  function openPopover() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    onOpenChange?.(true);
  }

  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onOpenChange?.(false), 140);
  }

  return (
    <div
      className={`pack-options-wrap ${open ? 'is-open' : ''}`}
      ref={wrapRef}
      onPointerEnter={openPopover}
      onPointerLeave={scheduleClose}
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClose}
      onFocus={openPopover}
    >
      {trigger}

      {open ? (
        <>
          <div className="pack-options-hover-bridge" aria-hidden="true" />
          <div className="pack-options-popover" role="dialog" aria-label="Options du pack">
            <div className="pack-options-head">
              <span className="pack-options-title">Options du pack</span>
              <span className="pack-options-subtitle">Appliquées lors de la génération du pack.</span>
            </div>

            <div className="pack-options-section">
              <div className="pack-options-section-title">Traitement audio du pack</div>
              <div className="pack-options-row pack-options-row-stack">
                <span className="pack-options-label">Silence début / fin</span>
                <div className="pack-options-segmented" role="group" aria-label="Mode de silence début et fin">
                  {SILENCE_MODE_OPTIONS.map(([mode, label, help]) => (
                    <Tooltip key={mode} text={help} wrap>
                      <button
                        type="button"
                        className={`pack-options-segment ${globalOptions.silenceMode === mode ? 'is-active' : ''}`}
                        aria-pressed={globalOptions.silenceMode === mode}
                        onClick={() => updateOption('silenceMode', mode)}
                      >
                        {label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
            </div>

            <div className="pack-options-section">
              <div className="pack-options-section-title">Comportement de lecture global</div>
              <Tooltip
                text="Enchaîne automatiquement les histoires et ignore les messages, scénarios et retours de fin tant que l'option est active."
                wrap
                className="pack-options-row-tip"
              >
                <div className={`pack-options-row ${isSimpleProject ? 'is-disabled' : ''}`}>
                  <span className="pack-options-label">Auto-next</span>
                  <Toggle
                    on={!!globalOptions.autoNext}
                    onChange={(value) => updateOption('autoNext', value)}
                    disabled={isSimpleProject}
                    ariaLabel="Auto-next. Enchaîne automatiquement les histoires et ignore les fins configurées."
                  />
                </div>
              </Tooltip>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
