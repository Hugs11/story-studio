import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import '../MediaSubscriptions/MediaSubscriptionsPanel.css';
import './NotificationToast.css';

/** Shared presentation only: callers own persistence, actions and dismissal. */
export function NotificationToast({ title, detail, actionLabel, onAction, onClose, visible, closeLabel, longDetail = false }) {
  const { t } = useTranslation('common');
  const titleId = useId();
  const [host, setHost] = useState(null);
  useEffect(() => {
    // One layer for all notices: simultaneous episode/release notices stack.
    // It lives as long as the app document, independently of either caller.
    let layer = document.getElementById('notification-toast-stack');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'notification-toast-stack';
      layer.className = 'notification-toast-stack';
      document.body.appendChild(layer);
    }
    setHost(layer);
  }, []);
  const content = <div className="media-subscriptions-toast-region" role="status" aria-live="polite">
    {visible && <div className={`media-subscriptions-toast${longDetail ? ' notification-toast-long-detail' : ''}`}>
      <div className="media-subscriptions-item-text">
        <strong id={longDetail ? titleId : undefined}>{title}</strong>
        {detail && <span className={longDetail ? 'notification-toast-detail' : undefined}
          tabIndex={longDetail ? 0 : undefined} role={longDetail ? 'region' : undefined}
          aria-labelledby={longDetail ? titleId : undefined}>{detail}</span>}
      </div>
      {onAction && <button type="button" onClick={onAction}>{actionLabel}</button>}
      <button type="button" className="media-subscriptions-close" onClick={onClose} aria-label={closeLabel || t('common:dialog.close.label')}>×</button>
    </div>}
  </div>;
  return host ? createPortal(content, host) : content;
}
