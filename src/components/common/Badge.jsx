import './Badge.css';

const BADGE_STYLES = {
  root: { bg: '#EEEDFE', color: '#3C3489', label: 'Racine' },
  menu: { bg: '#E1F5EE', color: '#085041', label: 'Menu' },
  story: { bg: '#E6F1FB', color: '#0C447C', label: 'Histoire' },
  zip: { bg: '#FAEEDA', color: '#633806', label: 'ZIP' },
};

export function Badge({ type }) {
  const style = BADGE_STYLES[type] || BADGE_STYLES.root;
  return (
    <span
      className="badge"
      style={{ background: style.bg, color: style.color }}
    >
      {style.label}
    </span>
  );
}

export function StatusDot({ status }) {
  return <span className={`status-dot ${status}`} />;
}
