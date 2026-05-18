import { useState } from 'react';
import { FilePen, MonitorPlay, Network, Wrench } from '../icons/LucideLocal';
import { DEFAULT_SHORTCUT_LABELS } from '../../store/keyboardShortcuts';

const ITEMS = [
  {
    id: 'edit',
    label: 'Éditeur',
    shortcutId: 'tabEdit',
    Icon: FilePen,
  },
  {
    id: 'emu',
    label: 'Simulateur',
    shortcutId: 'tabEmulator',
    Icon: MonitorPlay,
  },
  {
    id: 'diagram',
    label: 'Diagramme',
    shortcutId: 'tabDiagram',
    Icon: Network,
  },
  {
    id: 'opts',
    label: 'Préférences',
    shortcutId: 'tabOptions',
    Icon: Wrench,
  },
];

function RailIcon({ Icon }) {
  return (
    <Icon
      className="chrome-icon chrome-rail-icon"
      aria-hidden="true"
      strokeWidth={2.1}
      absoluteStrokeWidth
    />
  );
}

export function PanelRail({ activeTab, onChange, shortcutLabels = DEFAULT_SHORTCUT_LABELS }) {
  const [hoveredId, setHoveredId] = useState(null);

  return (
    <nav className="chrome-rail" aria-label="Navigation principale">
      {ITEMS.map((item) => {
        const shortcut = item.shortcutId ? shortcutLabels[item.shortcutId] : null;
        const title = shortcut ? `${item.label} (${shortcut})` : item.label;
        return (
        <div
          key={item.id}
          className="chrome-rail-item"
          onMouseEnter={() => setHoveredId(item.id)}
          onMouseLeave={() => setHoveredId((current) => (current === item.id ? null : current))}
        >
          <button
            className={`chrome-rail-btn ${activeTab === item.id ? 'is-active' : ''}`}
            onClick={() => onChange(item.id)}
            aria-label={title}
            onFocus={() => setHoveredId(item.id)}
            onBlur={() => setHoveredId((current) => (current === item.id ? null : current))}
          >
            <RailIcon Icon={item.Icon} />
            <span className="sr-only">{item.label}</span>
          </button>
          {hoveredId === item.id ? (
            <div className="chrome-rail-flyout" aria-hidden="true">
              {title}
              <div className="chrome-rail-flyout-arrow" />
            </div>
          ) : null}
        </div>
      );})}
    </nav>
  );
}
