import { useReleaseConsent } from '../../hooks/useReleaseConsent.js';
import { writeReleaseConsent } from '../../store/releaseNotice.js';
import { Select } from '../../components/common/Select.jsx';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_LANGUAGES, changeUiLanguage } from '../../i18n/language';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';
import { useSelectionOpensSettings } from '../../hooks/useSelectionOpensSettings';
import { writeSelectionOpensSettings } from '../../store/selectionOpensSettings';
import { THEME_OPTIONS } from '../../store/themePreference';

const LANGUAGE_LABEL_KEYS = {
  fr: 'settings:interface.language.french',
  en: 'settings:interface.language.english',
  it: 'settings:interface.language.italian',
  pseudo: 'settings:interface.language.pseudo',
};

export function InterfaceSection({
  className,
  sectionRef,
  themePreference,
  onThemePreferenceChange,
  onOpenShortcuts,
}) {
  const { t, i18n } = useTranslation('settings');
  const releaseConsent = useReleaseConsent();
  const selectionOpensSettings = useSelectionOpensSettings();
  const languageCount = AVAILABLE_LANGUAGES.filter((language) => language !== 'pseudo').length;
  return (
    <section id="interface" className={className} ref={sectionRef}>
      <div className="opts-card-title">{t('settings:interface.section.title')}</div>
      {AVAILABLE_LANGUAGES.length > 1 && (
        <div className="opts-row">
          <div className="opts-row-info">
            <label className="opts-row-label" htmlFor="ui-language">{t('settings:interface.language.label')}</label>
            <div className="opts-row-sub">{t('settings:interface.language.availableCount', { count: languageCount })}</div>
          </div>
          <Select id="ui-language" className="xtts-input opts-select" value={i18n.language}
            onChange={changeUiLanguage}
            aria-label={t('settings:interface.language.label')}
            options={AVAILABLE_LANGUAGES.map(language => ({ value: language, label: t(LANGUAGE_LABEL_KEYS[language]) }))}
          />
        </div>
      )}
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:interface.theme.label')}</div>
          <div className="opts-row-sub">{t('settings:interface.theme.description')}</div>
        </div>
        <Select
          className="xtts-input opts-select"
          value={themePreference}
          onChange={value => onThemePreferenceChange?.(value)}
          aria-label={t('settings:interface.theme.label')}
          options={THEME_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
        />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:interface.selection.label')}</div>
          <div className="opts-row-sub">{t('settings:interface.selection.description')}</div>
        </div>
        <Toggle
          on={selectionOpensSettings}
          onChange={writeSelectionOpensSettings}
          ariaLabel={t('settings:interface.selection.label')}
        />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:interface.shortcuts.label')}</div>
          <div className="opts-row-sub">{t('settings:interface.shortcuts.description')}</div>
        </div>
        <Button onClick={onOpenShortcuts}>
          {t('common:action.edit.label')}
        </Button>
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">{t('settings:releaseCheck.label')}</div>
          <div className="opts-row-sub">{t('settings:releaseCheck.description')}</div>
        </div>
        <Toggle on={releaseConsent === true} onChange={writeReleaseConsent}
          ariaLabel={t('settings:releaseCheck.label')} />
      </div>
    </section>
  );
}
