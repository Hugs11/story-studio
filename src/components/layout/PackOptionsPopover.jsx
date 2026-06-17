import { useEffect, useRef } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { formatPackAudioEdgeSilence } from '../../config/audioProcessing';
import './PackOptionsPopover.css';

const SILENCE_MODE_OPTIONS = [
  ['normalize', 'Calcul 0,5 s', `Mesure les silences de début/fin et les ramène à exactement ${formatPackAudioEdgeSilence()} (coupe si trop long, complète si trop court).`],
  ['add', 'Ajoute 0,5 s', `Ajoute ${formatPackAudioEdgeSilence()} à chaque bord sans mesurer l'existant — le silence déjà présent s'additionne.`],
  ['off', 'Off', 'Ne touche pas aux silences de début et de fin.'],
];

const HARMONIZE_LOUDNESS_HELP = "Aligne le volume de toutes les histoires sur un même niveau (-14 LUFS) à la génération (recommandé si vos fichiers audio ne sont pas déjà préparés pour la Lunii). Un son quasi-muet ou impossible à corriger sans saturer bloque la génération. Si désactivé : le volume d'origine de chaque fichier est conservé.";

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
              <Tooltip text={HARMONIZE_LOUDNESS_HELP} wrap className="pack-options-row-tip">
                <div className="pack-options-row">
                  <span className="pack-options-label">Harmoniser le volume</span>
                  <Toggle
                    on={globalOptions.harmonizeLoudness !== false}
                    onChange={(value) => updateOption('harmonizeLoudness', value)}
                    ariaLabel="Harmoniser le volume des audios vers -14 LUFS à la génération."
                  />
                </div>
              </Tooltip>
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
