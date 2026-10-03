// Le badge d'usage d'un média. `known` à faux n'est pas « zéro » : c'est
// « on ne sait pas ». Afficher ×0 dans ce cas serait une affirmation, et un
// auteur supprime un fichier sur la foi d'un ×0.
export function UsageBadge({ count, known = true }) {
  if (!known) {
    return (
      <span
        className="media-usage-badge is-unknown"
        title="Usages non calculés : ouvre l’éditeur du projet pour les établir."
      >?</span>
    );
  }
  return <span className={`media-usage-badge${count === 0 ? ' is-zero' : ''}`}>×{count}</span>;
}
