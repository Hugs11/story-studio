import { useEffect, useRef } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { Wrench } from '../icons/LucideLocal';
import { formatPackAudioEdgeSilence } from '../../config/audioProcessing';
import './PackOptionsPopover.css';

const EDGE_SILENCE_LABEL = formatPackAudioEdgeSilence();
const SILENCE_MODE_OPTIONS = [
  ['normalize', `Calcul ${EDGE_SILENCE_LABEL}`, `Mesure les silences de début/fin et les ramène à exactement ${EDGE_SILENCE_LABEL} (coupe si trop long, complète si trop court).`],
  ['add', `Ajoute ${EDGE_SILENCE_LABEL}`, `Ajoute ${EDGE_SILENCE_LABEL} à chaque bord sans mesurer l'existant — le silence déjà présent s'additionne.`],
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
  onOpenPreferences,
  preferencesShortcut = '',
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

  function handleOpenPreferences() {
    onOpenChange?.(false);
    onOpenPreferences?.();
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
            <div className="pack-options-well">
              <div className="pack-options-well-title">Traitement audio du pack</div>
              <Tooltip text={HARMONIZE_LOUDNESS_HELP} wrap className="pack-options-row-tip">
                <div className="pack-options-control-row">
                  <span className="pack-options-control-copy">
                    <span className="pack-options-control-title">Harmoniser le volume</span>
                  </span>
                  <span className="pack-options-control-end">
                    <Toggle
                      on={globalOptions.harmonizeLoudness !== false}
                      onChange={(value) => updateOption('harmonizeLoudness', value)}
                      ariaLabel="Harmoniser le volume des audios vers -14 LUFS à la génération."
                    />
                  </span>
                </div>
              </Tooltip>
              <div className="pack-options-control-row pack-options-control-row--stack">
                <span className="pack-options-control-copy">
                  <span className="pack-options-control-title">Silence début / fin</span>
                </span>
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

              <div className="pack-options-well-sep" />

              <div className="pack-options-well-title">Lecture <span>· global</span></div>
              <Tooltip
                text="Enchaîne automatiquement les histoires et ignore les messages, scénarios et retours de fin tant que l'option est active."
                wrap
                className="pack-options-row-tip"
              >
                <div className={`pack-options-control-row ${isSimpleProject ? 'is-disabled' : ''}`}>
                  <span className="pack-options-control-copy">
                    <span className="pack-options-control-title">Auto-next</span>
                    <span className="pack-options-control-hint">Enchaîne la lecture des nœuds</span>
                  </span>
                  <span className="pack-options-control-end">
                    <Toggle
                      on={!!globalOptions.autoNext}
                      onChange={(value) => updateOption('autoNext', value)}
                      disabled={isSimpleProject}
                      ariaLabel="Auto-next. Enchaîne automatiquement les histoires et ignore les fins configurées."
                    />
                  </span>
                </div>
              </Tooltip>
            </div>

            {onOpenPreferences ? (
              <>
                <div className="pack-options-rule" />
                <button
                  type="button"
                  className="pack-options-gateway pack-options-gateway--app"
                  onClick={handleOpenPreferences}
                >
                  <span className="pack-options-gateway-icon pack-options-gateway-icon--app">
                    <Wrench strokeWidth={2} absoluteStrokeWidth />
                  </span>
                  <span className="pack-options-gateway-copy">
                    <span className="pack-options-gateway-title">Préférences de l’application</span>
                    <span className="pack-options-gateway-subtitle">Thème, dossiers de travail, audio, raccourcis.</span>
                  </span>
                  <span className="pack-options-gateway-end">
                    {preferencesShortcut ? <span className="pack-options-shortcut">{preferencesShortcut}</span> : null}
                  </span>
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
