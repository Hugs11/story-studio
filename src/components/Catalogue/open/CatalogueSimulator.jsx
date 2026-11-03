import { useEffect, useRef } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { useEscapeKey } from '../../../hooks/useEscapeKey.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { exemplarRow } from '../../../store/catalogue/detailsRow.js';
import { AppModalPortal } from '../../common/AppModalPortal.jsx';
import { TechnicalDetail } from '../../common/UserMessage.jsx';
import { FloatingSimulator } from '../../FloatingSimulator/FloatingSimulator.jsx';
import './CatalogueOpen.css';

/** Source réellement simulée : format et nom de l'exemplaire. */
function sourceParams(t, cell, exemplar) {
  if (!exemplar) return { format: '', name: '' };
  const row = exemplarRow(exemplar);
  return { format: t(row.formatKey), name: cell(row.name) };
}

/**
 * Le simulateur au-dessus du catalogue, pour une consultation : préparation
 * annulable, erreur présentable avec relance ou nouveau choix, puis écoute.
 * Une seule simulation à la fois ; la fermeture rend la main au catalogue
 * (sa fiche ou sa carte d'origine reprend le focus).
 */
export function CatalogueSimulator({ consultation, onChooseAgain }) {
  const { t, cell } = useCatalogueTranslation();
  const { state, visible, close, relaunch } = consultation;
  const primary = useRef(null);
  const status = visible ? state.status : null;
  useEscapeKey(status === 'preparing' || status === 'failed', close);
  useEffect(() => { primary.current?.focus(); }, [status, state.token]);
  if (!visible) return null;
  const source = sourceParams(t, cell, state.target?.exemplar);

  if (status === 'ready') {
    return <AppModalPortal className="modal-overlay catalogue-simulator-overlay">
      <div className="catalogue-simulator-host" role="dialog" aria-modal="true" aria-label={t('catalogue:simulate.dialog.label', source)}>
        <p className="catalogue-simulator-source">{t('catalogue:simulate.source.label', source)}</p>
        <FloatingSimulator
          consultation={{ graph: state.handle.flatGraph, media: state.handle.media, key: state.token }}
          hostSelector=".catalogue-simulator-host"
          onClose={close}
        />
      </div>
    </AppModalPortal>;
  }

  return <AppModalPortal className="modal-overlay catalogue-simulator-overlay">
    <SimulatorNotice state={state} source={source} primary={primary} onClose={close} onRelaunch={relaunch} onChooseAgain={onChooseAgain} />
  </AppModalPortal>;
}

/**
 * Préparation (annulable) ou échec (message du moteur, relance ou nouveau
 * choix selon la cause) d'une simulation du catalogue.
 */
export function SimulatorNotice({ state, source, primary = null, onClose, onRelaunch, onChooseAgain }) {
  const { t } = useCatalogueTranslation();
  const failed = state.status === 'failed';
  const presented = failed ? presentCatalogueError(state.error) : null;
  return <div className="catalogue-simulator-notice" role="dialog" aria-modal="true" aria-labelledby="catalogue-simulator-title" aria-busy={failed ? undefined : 'true'}>
      <h2 id="catalogue-simulator-title">{failed ? t('catalogue:simulate.failed.title') : t('catalogue:simulate.preparing.message', source)}</h2>
      {failed
        ? <div role="alert">{presented.message}<TechnicalDetail value={presented.technicalDetail} /></div>
        : <p role="status">{t('catalogue:simulate.source.label', source)}</p>}
      <div className="catalogue-simulator-actions">
        {failed && state.retry === 'relaunch' && <button type="button" ref={primary} onClick={onRelaunch}>{t('catalogue:simulate.failed.relaunch')}</button>}
        {failed && state.retry === 'choose' && <button type="button" ref={primary} onClick={() => onChooseAgain(state)}>{t('catalogue:simulate.failed.choose')}</button>}
        <button type="button" ref={failed && state.retry ? undefined : primary} onClick={onClose}>
          {failed ? t('catalogue:simulate.failed.close') : t('catalogue:simulate.preparing.cancel')}
        </button>
      </div>
    </div>;
}
