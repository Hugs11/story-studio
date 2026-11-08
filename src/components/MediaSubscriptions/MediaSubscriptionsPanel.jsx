import { presentStoredError } from '../../i18n/userMessage.js';
import { translateMedia as t } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import { notificationLabel } from './MediaSubscriptionsToast.jsx';
import './MediaSubscriptionsPanel.css';

function sourceLabel(source) {
  // Marques invariables ; seul le repli générique est traduit.
  return source === 'youtube' ? 'YouTube' : source === 'podcast' ? 'Podcast' : source || t('media:subscriptions.source.fallback');
}

// Pause (choix de l'utilisateur) et projet introuvable (état constaté) sont
// deux informations distinctes, affichées ensemble si besoin.
function subscriptionStateLabel(subscription) {
  const state = subscription.enabled ? t('media:subscriptions.state.active') : t('media:subscriptions.state.paused');
  return subscription.status === 'missing' ? `${state} · ${t('media:subscriptions.project.missing')}` : state;
}

function YoutubeToolsNotice({ tools, onUpdate }) {
  const action = tools.missing ? t('media:subscriptions.tools.install') : t('media:subscriptions.tools.update');
  return (
    <div className="media-subscriptions-tools">
      <p>{tools.missing ? t('media:subscriptions.tools.missing') : t('media:subscriptions.tools.outdated')}</p>
      <button type="button" onClick={() => onUpdate?.()} disabled={tools.updating}>
        {tools.updating ? t('media:subscriptions.tools.updating') : action}
      </button>
      {tools.error && <p className="media-subscriptions-error" role="alert">{tools.error}</p>}
    </div>
  );
}

export function MediaSubscriptionsPanel({
  subscriptions = [],
  notifications = [],
  checking = false,
  onCheck,
  onOpenNotification,
  onDismissNotification,
  onToggleSubscription,
  onRemoveSubscription,
  onRelocateSubscription,
  storageError = null,
  youtubeTools = null,
  onUpdateTools,
}) {
  useMediaTranslation();
  const count = notifications.length;
  return (
    <div className="media-subscriptions">
      <div className="media-subscriptions-section">
        <h3>{t('media:subscriptions.notifications.title')}</h3>
        {count === 0 ? <p className="media-subscriptions-empty">{t('media:subscriptions.notifications.empty')}</p> : (
          <ul>
            {notifications.map((notification) => (
              <li key={notification.id} className="media-subscriptions-item">
                <div className="media-subscriptions-item-text">
                  <strong>{notification.title}</strong>
                  <span>{notification.projectName} · {notificationLabel(notification)}</span>
                </div>
                <div className="media-subscriptions-actions">
                  <button type="button" onClick={() => onOpenNotification?.(notification.id)}>{t('media:subscriptions.open.action')}</button>
                  <button type="button" onClick={() => onDismissNotification?.(notification.id)} aria-label={t('media:subscriptions.notification.remove', { title: notification.title })}>{t('common:dialog.delete.label')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {storageError && <p className="media-subscriptions-error" role="alert">{storageError}</p>}
      <div className="media-subscriptions-section">
        <div className="media-subscriptions-section-heading">
          <h3>{t('media:subscriptions.list.title')}</h3>
          <button type="button" onClick={() => onCheck?.()} disabled={checking || !subscriptions.some((subscription) => subscription.enabled)}>
            {checking ? t('media:subscriptions.check.progress') : t('media:subscriptions.check.action')}
          </button>
        </div>
        {youtubeTools && <YoutubeToolsNotice tools={youtubeTools} onUpdate={onUpdateTools} />}
        {subscriptions.length === 0 ? <p className="media-subscriptions-empty">{t('media:subscriptions.list.empty')}</p> : (
          <ul>
            {subscriptions.map((subscription) => (
              <li key={subscription.id} className="media-subscriptions-item">
                <div className="media-subscriptions-item-text">
                  <strong>{subscription.title}</strong>
                  <span>{subscription.projectName} · {sourceLabel(subscription.source)} · {subscriptionStateLabel(subscription)}</span>
                  {subscription.error && <span className="media-subscriptions-error" role="status">{presentStoredError(subscription.error)}</span>}
                </div>
                <div className="media-subscriptions-actions">
                  {subscription.status === 'missing' && <button type="button" onClick={() => onRelocateSubscription?.(subscription.id)}>{t('media:subscriptions.project.relocate')}</button>}
                  <button type="button" onClick={() => onToggleSubscription?.(subscription.id)}>{subscription.enabled ? t('media:subscriptions.pause.action') : t('media:subscriptions.resume.action')}</button>
                  <button type="button" onClick={() => onRemoveSubscription?.(subscription.id)} aria-label={t('media:subscriptions.follow.remove', { title: subscription.title })}>{t('common:dialog.delete.label')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default MediaSubscriptionsPanel;
