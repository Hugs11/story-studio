import { useTranslation } from 'react-i18next';

const OPTION_GROUPS = [
  {
    labelKey: 'settings:navigation.general.label',
    items: [
      { id: 'save', labelKey: 'settings:navigation.save.label' },
      { id: 'interface', labelKey: 'settings:interface.section.title' },
      { id: 'catalogue', labelKey: 'catalogue:screen.title.label' },
      { id: 'media-subscriptions', labelKey: 'media:subscriptions.section.title' },
      { id: 'projects-media', labelKey: 'settings:navigation.projectsMedia.label' },
    ],
  },
  {
    labelKey: 'settings:navigation.ai.label',
    items: [
      { id: 'xtts', labelKey: 'settings:navigation.xtts.label' },
      { id: 'comfyui', labelKey: 'settings:navigation.comfyui.label' },
    ],
  },
  {
    labelKey: 'settings:navigation.advanced.label',
    items: [
      { id: 'advanced', labelKey: 'settings:navigation.silences.label' },
      { id: 'youtube', labelKey: 'settings:navigation.youtube.label' },
      { id: 'diagnostic', labelKey: 'settings:navigation.diagnostic.label' },
    ],
  },
];

export const OPTION_SECTION_IDS = OPTION_GROUPS.flatMap((group) => group.items.map((item) => item.id));

export function OptionsSectionNav({ activeSectionId, onNavigate }) {
  const { t } = useTranslation('settings');
  return (
    <nav className="opts-nav" aria-label={t('settings:navigation.sections.label')}>
      {OPTION_GROUPS.map((group) => (
        <div className="opts-nav-group" key={group.labelKey}>
          <div className="opts-nav-group-title">{t(group.labelKey)}</div>
          <div className="opts-nav-items">
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`opts-nav-item${activeSectionId === item.id ? ' is-active' : ''}`}
                onClick={() => onNavigate(item.id)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
