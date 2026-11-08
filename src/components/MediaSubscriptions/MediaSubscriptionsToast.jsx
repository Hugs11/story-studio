import { NotificationToast } from '../common/NotificationToast.jsx';
import { translateMedia as t } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

export function notificationLabel(notification) {
  const count = Number(notification.count) || 0;
  if (notification.source === 'youtube') return t('media:subscriptions.newVideos.count', { count });
  return t('media:subscriptions.newEpisodes.count', { count });
}

export function MediaSubscriptionsToast({ toast, onOpenNotification, onCloseToast, onOpenPreferences }) {
  useMediaTranslation();
  const reminder = toast?.kind === 'startup-reminder';
  return <NotificationToast visible={Boolean(toast)} title={reminder ? t('media:subscriptions.reminder.title') : toast?.title}
    detail={reminder ? t('media:subscriptions.reminder.count', { count: toast.count }) : toast ? `${toast.projectName} · ${notificationLabel(toast)}` : null}
    actionLabel={reminder ? t('media:subscriptions.reminder.action') : t('media:subscriptions.open.action')} closeLabel={t('media:toolResult.close.ariaLabel')}
    onAction={() => {
      if (reminder) {
        onCloseToast?.();
        onOpenPreferences?.({ section: 'media-subscriptions' });
      } else onOpenNotification?.(toast.id);
    }} onClose={() => onCloseToast?.()} />;
}
