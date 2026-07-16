const OPTION_GROUPS = [
  {
    label: 'Général',
    items: [
      { id: 'save', label: 'Enregistrement' },
      { id: 'interface', label: 'Interface' },
      { id: 'projects-media', label: 'Projets et médias' },
    ],
  },
  {
    label: 'Intelligence artificielle',
    items: [
      { id: 'xtts', label: 'Voix locale' },
      { id: 'comfyui', label: 'Images IA' },
    ],
  },
  {
    label: 'Avancé',
    items: [
      { id: 'youtube', label: 'YouTube (yt-dlp)' },
      { id: 'diagnostic', label: 'Diagnostic' },
    ],
  },
];

export const OPTION_SECTION_IDS = OPTION_GROUPS.flatMap((group) => group.items.map((item) => item.id));

export function OptionsSectionNav({ activeSectionId, onNavigate }) {
  return (
    <nav className="opts-nav" aria-label="Sections des préférences">
      {OPTION_GROUPS.map((group) => (
        <div className="opts-nav-group" key={group.label}>
          <div className="opts-nav-group-title">{group.label}</div>
          <div className="opts-nav-items">
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`opts-nav-item${activeSectionId === item.id ? ' is-active' : ''}`}
                onClick={() => onNavigate(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
