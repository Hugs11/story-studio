import { presentStoredError } from '../../i18n/userMessage.js';
import { translateMedia as t } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import { useEffect, useRef, useState } from 'react';
import './MediaSubscriptionsPanel.css';

function sourceLabel(source) {
  // Marques invariables ; seul le repli générique est traduit.
  return source === 'youtube' ? 'YouTube' : source === 'podcast' ? 'Podcast' : source || t('media:subscriptions.source.fallback');
}

function notificationLabel(notification) {
  const count = Number(notification.count) || 0;
  if (notification.source === 'youtube') return t('media:subscriptions.newVideos.count', { count });
  return t('media:subscriptions.newEpisodes.count', { count });
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

function triggerLabel(count) {
  return count > 0 ? t('media:subscriptions.notifications.count', { count }) : t('media:subscriptions.notifications.title');
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
  toast,
  onCloseToast,
  storageError = null,
  youtubeTools = null,
  onUpdateTools,
  home = true,
}) {
  useMediaTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  // Un suivi suspendu doit garder son accès à la gestion pour pouvoir être repris.
  const visible = subscriptions.length > 0 || notifications.length > 0 || Boolean(storageError);
  const count = notifications.length;

  useEffect(() => {
    if (!home) setOpen(false);
  }, [home]);

  function closePanel() {
    setOpen(false);
    trigger.current?.focus();
  }

  // Écouté sur le conteneur : Échap ferme aussi depuis le bouton, où reste le
  // focus juste après l'ouverture.
  function handleKeyDown(event) {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      closePanel();
    }
  }

  return (
    <>
      {home && visible && (
        <div
          className="media-subscriptions"
          onKeyDown={handleKeyDown}
        >
          <button
            ref={trigger}
            type="button"
            className="media-subscriptions-trigger"
            aria-expanded={open}
            aria-controls="media-subscriptions-panel"
            aria-label={triggerLabel(count)}
            onClick={() => setOpen((previous) => !previous)}
          >
            {t('media:subscriptions.notifications.title')}{count > 0 && <span className="media-subscriptions-count">{count}</span>}
          </button>
          {open && (
            <section id="media-subscriptions-panel" className="media-subscriptions-panel" aria-label={t('media:subscriptions.panel.ariaLabel')}>
              <div className="media-subscriptions-heading">
                <h2>{t('media:subscriptions.panel.title')}</h2>
                <button type="button" className="media-subscriptions-close" onClick={closePanel} aria-label={t('media:subscriptions.panel.close')}>×</button>
              </div>
              {storageError && <p className="media-subscriptions-error" role="alert">{storageError}</p>}
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
            </section>
          )}
        </div>
      )}
      {/* Région annoncée montée en permanence : seul son contenu change. */}
      <div className="media-subscriptions-toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="media-subscriptions-toast">
            <div className="media-subscriptions-item-text">
              <strong>{toast.title}</strong>
              <span>{toast.projectName} · {notificationLabel(toast)}</span>
            </div>
            <button type="button" onClick={() => onOpenNotification?.(toast.id)}>{t('media:subscriptions.open.action')}</button>
            <button type="button" className="media-subscriptions-close" onClick={() => onCloseToast?.()} aria-label={t('media:toolResult.close.ariaLabel')}>×</button>
          </div>
        )}
      </div>
    </>
  );
}

export default MediaSubscriptionsPanel;
