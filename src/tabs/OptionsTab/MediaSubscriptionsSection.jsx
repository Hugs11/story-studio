import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import { MediaSubscriptionsPanel } from '../../components/MediaSubscriptions/MediaSubscriptionsPanel.jsx';

export function MediaSubscriptionsSection({ className, sectionRef, subscriptions }) {
  const { t } = useMediaTranslation();
  return <section id="media-subscriptions" className={className} ref={sectionRef}>
    <div className="opts-card-title">{t('media:subscriptions.section.title')}</div>
    <MediaSubscriptionsPanel {...subscriptions} />
  </section>;
}
