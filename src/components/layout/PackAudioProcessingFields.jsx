import { useId, useState } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { Pencil } from '../icons/LucideLocal';
import {
  PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS,
  formatPackAudioEdgeSilence,
  getPackAudioEdgeSilenceSettings,
  parsePackAudioEdgeSilenceOverride,
  resolvePackAudioEdgeSilence,
} from '../../config/audioProcessing';
import { translateMedia as t } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import './PackAudioProcessingFields.css';

function silenceModePresentation(leadingSeconds, trailingSeconds) {
  const leadingLabel = formatPackAudioEdgeSilence(leadingSeconds);
  const trailingLabel = formatPackAudioEdgeSilence(trailingSeconds);

  return {
    durationSummary: leadingSeconds === trailingSeconds
      ? leadingLabel
      : `${leadingLabel} / ${trailingLabel}`,
    // Libellés résolus à chaque rendu, dans la langue active.
    options: [
      ['normalize', t('media:packAudio.normalize.label'), t('media:packAudio.normalize.ariaLabel'), t('media:packAudio.normalize.help', { leading: leadingLabel, trailing: trailingLabel })],
      ['add', t('media:packAudio.add.label'), t('media:packAudio.add.ariaLabel', { leading: leadingLabel, trailing: trailingLabel }), t('media:packAudio.add.help', { leading: leadingLabel, trailing: trailingLabel })],
      ['off', t('media:packAudio.off.label'), t('media:packAudio.off.ariaLabel'), t('media:packAudio.off.help')],
    ],
  };
}


function durationText(seconds) {
  return formatPackAudioEdgeSilence(seconds).replace(/\s*s$/u, '');
}

function durationInputValue(override, inherited) {
  if (override == null) return durationText(inherited);
  if (typeof override === 'number') return durationText(override);
  return String(override);
}

// Une saisie vidée n'est pas une personnalisation : elle reprend la préférence.
function isCustomized(override) {
  return override != null && String(override).trim() !== '';
}

// Appelée comme une fonction, sans hook : les deux saisies restent dans l'arbre
// rendu par la fiche.
function durationField({ id, label, override, inherited, preference, noteId, onChange }) {
  const invalid = parsePackAudioEdgeSilenceOverride(override) === undefined;
  const errorId = `${id}-error`;
  return (
    <div className="pack-meta-audio-duration-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="pack-meta-audio-duration-input"
        type="text"
        inputMode="decimal"
        value={durationInputValue(override, inherited)}
        // Visible seulement quand le champ est vidé : la valeur reprise des
        // Préférences, celle qui partira à la génération.
        placeholder={durationText(preference)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${errorId} ${noteId}` : noteId}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid && (
        <span id={errorId} className="pack-meta-audio-duration-error">
          {t('media:packAudio.duration.error', { max: PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS })}
        </span>
      )}
    </div>
  );
}

export function PackAudioProcessingFields({ values, onChange }) {
  useMediaTranslation();
  const preferences = getPackAudioEdgeSilenceSettings();
  const { leading, trailing } = resolvePackAudioEdgeSilence(values, preferences);
  const { durationSummary, options } = silenceModePresentation(leading, trailing);
  const activeMode = values.silenceMode;
  const activeHelp = (options.find(([mode]) => mode === activeMode) ?? options[0])[3];
  const leadingOverride = values.leadingSilenceSec;
  const trailingOverride = values.trailingSilenceSec;
  const hasOverrides = isCustomized(leadingOverride) || isCustomized(trailingOverride);
  const hasInvalidDuration = [leadingOverride, trailingOverride]
    .some((override) => parsePackAudioEdgeSilenceOverride(override) === undefined);
  const [editingDurations, setEditingDurations] = useState(false);
  // Identifiants stables par instance : le stylo pointe le groupe qu'il ouvre.
  const baseId = useId();
  const editorId = `${baseId}-durations`;
  const noteId = `${baseId}-durations-note`;

  function updateField(field, value) {
    onChange?.(field, value);
  }

  function resetDurations() {
    updateField('leadingSilenceSec', null);
    updateField('trailingSilenceSec', null);
  }

  return (
    <section className="pack-meta-audio" aria-label={t('media:packAudio.section.ariaLabel')}>
      <span className="pack-meta-cover-label">{t('media:packAudio.section.title')}</span>

      <Tooltip text={t('media:packAudio.loudness.help')} wrap className="pack-meta-audio-volume-tooltip">
        <div className="pack-meta-audio-volume-row">
          <span className="pack-meta-audio-control-title">{t('media:packAudio.loudness.title')}</span>
          <Toggle
            on={values.harmonizeLoudness}
            onChange={(value) => updateField('harmonizeLoudness', value)}
            ariaLabel={t('media:packAudio.loudness.ariaLabel')}
          />
        </div>
      </Tooltip>

      <div className="pack-meta-audio-silence">
        <div className="pack-meta-audio-silence-heading">
          <span className="pack-meta-audio-control-title">{t('media:packAudio.silence.title')}</span>
          <span className="pack-meta-audio-duration">{durationSummary}</span>
          <span className="pack-meta-audio-duration-scope">
            {hasOverrides ? t('media:packAudio.scope.custom') : t('media:packAudio.scope.default')}
          </span>
          <Tooltip text={editingDurations ? t('media:packAudio.durations.closeTooltip') : t('media:packAudio.durations.edit')} asChild>
            <Button
              size="sm"
              variant="icon"
              className="pack-meta-audio-duration-edit"
              aria-label={editingDurations ? t('media:packAudio.durations.closeAriaLabel') : t('media:packAudio.durations.edit')}
              aria-expanded={editingDurations}
              aria-controls={editorId}
              onClick={() => setEditingDurations((current) => !current)}
            >
              <Pencil />
            </Button>
          </Tooltip>
        </div>
        {hasInvalidDuration && !editingDurations && (
          <span className="pack-meta-audio-duration-invalid-hint" role="status">
            {t('media:packAudio.durations.invalid')}
          </span>
        )}
        {/* Le groupe reste dans le DOM, masqué : `aria-controls` doit toujours
            désigner un élément existant. */}
        <div
          id={editorId}
          className="pack-meta-audio-duration-editor"
          role="group"
          aria-label={t('media:packAudio.durations.groupAriaLabel')}
          hidden={!editingDurations}
        >
          {editingDurations && (
            <>
              <div className="pack-meta-audio-duration-fields">
                {durationField({
                  id: `${baseId}-leading`,
                  label: t('media:packAudio.duration.leading'),
                  override: leadingOverride,
                  inherited: leading,
                  preference: preferences.leading,
                  noteId,
                  onChange: (value) => updateField('leadingSilenceSec', value),
                })}
                {durationField({
                  id: `${baseId}-trailing`,
                  label: t('media:packAudio.duration.trailing'),
                  override: trailingOverride,
                  inherited: trailing,
                  preference: preferences.trailing,
                  noteId,
                  onChange: (value) => updateField('trailingSilenceSec', value),
                })}
              </div>
              <span id={noteId} className="pack-meta-audio-duration-note">
                {t('media:packAudio.duration.note', { max: PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS })}
              </span>
              <div className="pack-meta-audio-duration-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  className="pack-meta-audio-duration-reset"
                  disabled={!hasOverrides}
                  onClick={resetDurations}
                >
                  {t('media:packAudio.durations.reset')}
                </Button>
              </div>
            </>
          )}
        </div>
        <div className="pack-meta-audio-options" role="group" aria-label={t('media:packAudio.silence.modeAriaLabel')}>
          {options.map(([mode, label, ariaLabel, help]) => (
            <Tooltip key={mode} text={help} wrap className="pack-meta-audio-segment-tooltip">
              <button
                type="button"
                className={`pack-meta-age-chip pack-meta-audio-segment ${activeMode === mode ? 'is-active' : ''}`}
                aria-pressed={activeMode === mode}
                aria-label={ariaLabel}
                onClick={() => updateField('silenceMode', mode)}
              >
                <span className="pack-meta-audio-option-dot" aria-hidden="true" />
                <span>{label}</span>
              </button>
            </Tooltip>
          ))}
        </div>
        <span className="pack-meta-audio-help">{activeHelp}</span>
      </div>
    </section>
  );
}
