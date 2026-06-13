import './Badge.css';

const BADGE_LABELS = {
  root: 'Racine',
  menu: 'Menu',
  story: 'Histoire',
  zip: 'ZIP',
};

export function Badge({ type }) {
  const normalizedType = BADGE_LABELS[type] ? type : 'root';

  return (
    <span className={`badge badge--${normalizedType}`}>
      {BADGE_LABELS[normalizedType]}
    </span>
  );
}
