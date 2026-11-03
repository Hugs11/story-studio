import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

// Le badge d'usage d'un média. `known` à faux n'est pas « zéro » : c'est
// « on ne sait pas ». Afficher ×0 dans ce cas serait une affirmation, et un
// auteur supprime un fichier sur la foi d'un ×0.
export function UsageBadge({ count, known = true }) {
  const { t } = useMediaTranslation();
  if (!known) {
    return (
      <span
        className="media-usage-badge is-unknown"
        title={t('media:explorer.usage.unknownTooltip')}
      >?</span>
    );
  }
  return <span className={`media-usage-badge${count === 0 ? ' is-zero' : ''}`}>×{count}</span>;
}
