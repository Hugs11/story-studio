import { useTranslation } from 'react-i18next';
import { presentStoredError, presentUserMessage } from '../../i18n/userMessage.js';
import { useEffect, useRef, useState } from 'react';

import { AdvancedDialog } from './AdvancedDialog.jsx';
import { useProjectContext } from '../../store/ProjectContext';
import { batchTitleVoice, isTtsAvailable } from '../../store/xttsSettings.js';
import { exampleMediaPlan } from '../../store/advancedExamples/media.js';
import { Button } from '../common/Button';
import { Toggle } from '../common/Toggle';
import { TechnicalDetail, UserMessage } from '../common/UserMessage';
import './Examples.css';

// Langue parlée par l'exemple : nom de la langue dans sa propre langue,
// comme le sélecteur de voix (clés `ai`).
const LANGUAGE_KEYS = Object.freeze({ fr: 'ai:voice.language.fr', en: 'ai:voice.language.en', it: 'ai:voice.language.it' });

// Détail technique d'une cause imbriquée dans une erreur de média : replié,
// seulement quand la cause n'a pas de message traduit dédié.
function nestedDetail(error, options) {
  const cause = error?.params?.error;
  if (!cause || typeof cause !== 'object' || !Object.hasOwn(cause, 'userMessage')) return '';
  const presented = presentUserMessage(cause.userMessage, options);
  return presented.fallback ? presented.technicalDetail : '';
}

export function ExampleDialog({ state, replacesInitialRoot, disabled, onCancel, onConfirm, onStop }) {
  const { t, i18n } = useTranslation('examples');
  const { xttsSettings } = useProjectContext();
  const [images, setImages] = useState(true);
  const audioAvailable = isTtsAvailable(xttsSettings) && !!batchTitleVoice(xttsSettings);
  const [audios, setAudios] = useState(audioAvailable);
  const plan = exampleMediaPlan(state.example);
  const created = state.inserted;
  // eslint-disable-next-line i18next/no-literal-string -- Noms de moteurs TTS (marques invariables).
  const engine = xttsSettings?.backend === 'xtts' ? 'XTTS' : 'Piper';
  const voice = state.voice;
  // Voix absente : aucun téléchargement sans choix explicite de l'auteur.
  const choosingVoice = !created && audios && !!state.voiceChoice && voice?.status === 'missing';
  // Présentation de l'exemple dans la langue de l'interface ; son contenu reste
  // celui de la langue capturée au choix.
  const title = state.example.titleKey ? t(state.example.titleKey) : state.example.title;
  const description = state.example.descriptionKey ? t(state.example.descriptionKey) : state.example.description;
  const screens = (count) => t('examples:count.screens.label', { count });
  const lists = (count) => t('examples:count.choiceLists.label', { count });
  // « Arrêter les médias » disparaît avec la génération : le focus passe à
  // « Fermer », redevenu actif, au lieu de tomber sur la page.
  const closeRef = useRef(null);
  useEffect(() => {
    if (state.stopped && !state.busy) closeRef.current?.focus();
  }, [state.stopped, state.busy]);
  let footer = null;
  if (state.busy && created) {
    // Seule la génération des médias s'arrête : le graphe est déjà inséré.
    footer = <Button onClick={onStop}>{t('examples:dialog.media.stop')}</Button>;
  } else if (choosingVoice) {
    footer = (
      <>
        <Button onClick={() => onConfirm({ images, audios: false })} disabled={disabled || state.busy}>
          {t('examples:dialog.voice.skipAudio')}
        </Button>
        <Button variant="primary" onClick={() => onConfirm({ images, audios: true, installVoice: true })} disabled={disabled || state.busy}>
          {t('examples:dialog.voice.install')}
        </Button>
      </>
    );
  }
  return (
    <AdvancedDialog
      title={title}
      description={description}
      onCancel={onCancel} onConfirm={created || choosingVoice ? null : () => onConfirm({ images, audios })}
      confirmLabel={replacesInitialRoot ? t('examples:dialog.confirm.create') : t('examples:dialog.confirm.add')}
      cancelLabel={created ? t('common:dialog.close.label') : t('common:dialog.cancel.label')}
      confirmDisabled={disabled || (audios && !audioAvailable)} busy={state.busy}
      cancelRef={closeRef}
      footer={footer}
    >
      {!created && (
        <>
          <p className="advanced-example-explanation">
            {replacesInitialRoot
              ? t('examples:dialog.replace.explanation')
              : t('examples:dialog.add.explanation')}
          </p>
          <fieldset className="advanced-example-media" disabled={state.busy}>
            <legend>{t('examples:dialog.media.legend')}</legend>
            <label className="advanced-example-toggle">
              <span>{t('examples:dialog.images.label')} <small>{t('examples:dialog.images.count', { count: plan.images.length })}</small></span>
              <Toggle on={images} onChange={setImages} ariaLabel={t('examples:dialog.images.toggle')} />
            </label>
            <label className="advanced-example-toggle">
              <span>{t('examples:dialog.audio.label')} <small>{t('examples:dialog.audio.count', { count: plan.audios.length, engine })}</small></span>
              <Toggle on={audios} onChange={setAudios} disabled={!audioAvailable} ariaLabel={t('examples:dialog.audio.toggle')} />
            </label>
            {!audioAvailable && <p className="advanced-example-explanation">{t('examples:dialog.audio.unavailable')}</p>}
            {audioAvailable && voice?.voice && (
              <p className="advanced-example-explanation advanced-example-voice">
                {t('examples:dialog.voice.summary', { language: t(LANGUAGE_KEYS[voice.language]), voice: voice.voice })}
                {voice.adapted && <><br />{t('examples:dialog.voice.adapted')}</>}
                {audios && voice.status === 'missing' && <><br />{t('examples:dialog.voice.missing')}</>}
              </p>
            )}
          </fieldset>
          {state.voiceError && (
            <div className="advanced-example-error advanced-example-voice" role="alert">
              <p>{t('examples:dialog.voice.installFailed')}</p>
              <div><UserMessage value={state.voiceError} /></div>
            </div>
          )}
          <p className="advanced-example-explanation">
            {t('examples:dialog.gaps.summary', { count: plan.withoutImage, withoutAudio: plan.withoutAudio })}
            {' '}{t('examples:dialog.gaps.note')}
          </p>
        </>
      )}
      {state.progress && (
        <div className="advanced-example-progress" role="status" aria-live="polite">
          {state.progress.total > 0 && <progress max={state.progress.total} value={state.progress.completed} />}
          <span>{state.progress.label ? presentStoredError(state.progress.label) : t('examples:dialog.progress.preparing')}</span>
        </div>
      )}
      {state.result && (
        <div className="advanced-example-explanation" role="status">
          <p>{state.report.replacedInitialRoot
            ? t('examples:dialog.result.created', { screens: screens(state.example.stages.length), lists: lists(state.example.actions.length) })
            : t('examples:dialog.result.added', { screens: screens(state.example.stages.length), lists: lists(state.example.actions.length) })}</p>
          <p>{t('examples:dialog.result.media', {
            images: t('examples:dialog.result.images', { count: state.result.imageCount }),
            audios: t('examples:dialog.result.audios', { count: state.result.audioCount }),
          })}</p>
          {state.result.audioCount > 0 && <p>{t('examples:dialog.result.followUp')}</p>}
        </div>
      )}
      {state.stopped && (
        <p className="advanced-example-explanation" role="status">
          {t('examples:dialog.stopped.message')}
        </p>
      )}
      {state.error && <div className="advanced-example-error" role="alert"><UserMessage value={state.error} /></div>}
      {state.result?.errors.length > 0 && (
        <div className="advanced-example-error" role="alert">
          <p>{t('examples:dialog.errors.intro')}</p>
          <ul>{state.result.errors.map((error, rank) => (
            <li key={rank}>
              {presentStoredError(error)}
              <TechnicalDetail value={nestedDetail(error, { t, language: i18n.resolvedLanguage ?? 'fr' })} />
            </li>
          ))}</ul>
        </div>
      )}
    </AdvancedDialog>
  );
}
