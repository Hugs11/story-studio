import { translateImport as t } from '../../i18n/importPresentation.js';
import './FollowedImportSource.css';

export function FollowedSourceNotice({ followed, onManage }) {
  return <div className="followed-source-notice">
    <strong role="status">{followed.state === 'paused' ? t('import:media.follow.alreadyPaused') : t('import:media.follow.already')}</strong>
    {onManage
      ? <button type="button" onClick={onManage}>{t('import:media.follow.manageButton')}</button>
      : <p>{t('import:media.follow.manage')}</p>}
  </div>;
}

export function FollowedSourceChoices({ sources, onChoose, disabled = false, id }) {
  if (sources.length < 2) return null;
  return <div className="followed-source-choices">
    <p id={id}>{t('import:media.follow.sources')}</p>
    <ul aria-labelledby={id}>{sources.map((source) => <li key={source.id}>
      <button type="button" disabled={disabled} onClick={() => onChoose(source.url)}>{source.title || source.url}</button>
    </li>)}</ul>
  </div>;
}
