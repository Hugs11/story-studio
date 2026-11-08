import { useState } from 'react';
import { useHomeTranslation } from '../../i18n/useHomeTranslation.js';
import { KEYS, read, write } from '../../store/persistentSettings.js';
import { ImportNoticeToast } from '../common/ImportNoticeToast.jsx';

/** Only a retained legacy French preference schedules this announcement. */
export function LanguageAnnouncement({ onOpenPreferences }) {
  const { t } = useHomeTranslation();
  const [visible, setVisible] = useState(() => read(KEYS.UI_LANGUAGE_ANNOUNCEMENT) === 'pending');
  const dismiss = () => {
    write(KEYS.UI_LANGUAGE_ANNOUNCEMENT, 'dismissed');
    setVisible(false);
  };
  if (!visible) return null;
  return <ImportNoticeToast message={t('home:languageAnnouncement.message')}
    actionLabel={t('home:languageAnnouncement.change')} onClose={dismiss}
    onAction={() => { dismiss(); onOpenPreferences?.({ section: 'interface', focus: 'ui-language' }); }} />;
}
