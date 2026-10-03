import { useEffect, useRef } from 'react';
import './ContextMenu.css';

// Le menu contextuel partagé : l'arbre et le diagramme du Libre, et la
// surface avancée.
//
// Le clavier a été ajouté ici plutôt que dans un menu propre au graphe. Un menu
// contextuel doit être utilisable au clavier, avec Échap, clic extérieur et focus
// restauré ; ces mécanismes manquaient au composant commun, et en fabriquer une
// seconde version pour le graphe aurait laissé le Libre sans. Les trois
// surfaces y gagnent ensemble.
export function ContextMenu({ x, y, onClose, actions }) {
  const ref = useRef(null);
  // L'élément qui avait le focus avant l'ouverture. Le menu le lui rend à la
  // fermeture : sans cela, fermer par Échap laissait le focus sur le corps du
  // document, et le parcours clavier repartait du début de la page.
  const restoreTo = useRef(null);

  // `onClose` est souvent une flèche recréée à chaque rendu. La lire par une
  // référence garde les écouteurs posés une fois pour toutes : dépendre
  // d'elle les retirait et relançait le délai à chaque rendu du parent, et un
  // panneau qui se redessine vite ne se refermait plus au clic extérieur.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // `pointerdown` en capture : le document l'entend avant tout le reste. Un
    // `mousedown` à la remontée se perdait sur les surfaces qui consomment le
    // pointeur — le canvas du graphe annule l'événement souris qui suit —, et
    // seul Échap fermait alors le menu.
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onCloseRef.current();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    }
    // Délai pour éviter que le clic droit qui ouvre le menu ne le referme aussitôt
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
    }, 100);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Le focus entre dans le menu à l'ouverture, sur le premier élément
  // actionnable, et repart d'où il venait à la fermeture.
  useEffect(() => {
    const active = document.activeElement;
    restoreTo.current = active instanceof HTMLElement ? active : null;
    const first = ref.current?.querySelector('.ctx-item:not([aria-disabled="true"])');
    if (first instanceof HTMLElement) first.focus();
    return () => {
      const target = restoreTo.current;
      // Ne rendre le focus que s'il est resté dans le menu : si l'auteur a
      // cliqué ailleurs entre-temps, le lui reprendre serait un vol de focus.
      if (target?.isConnected && !ref.current?.contains(document.activeElement)) return;
      if (target?.isConnected) target.focus();
    };
  }, []);

  // Les flèches parcourent les éléments actionnables, comme un menu ordinaire.
  // Tab reste disponible et n'est pas piégé : le menu se ferme au clic
  // extérieur et à Échap, il n'a pas à retenir le parcours.
  function onMenuKeyDown(event) {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const items = [...(ref.current?.querySelectorAll('.ctx-item:not([aria-disabled="true"])') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next = current === -1
      ? (step > 0 ? 0 : items.length - 1)
      : (current + step + items.length) % items.length;
    items[next].focus();
  }

  const itemCount = actions.filter(a => a !== 'sep' && a?.type !== 'sep' && a?.type !== 'node').length;
  const sepCount = actions.filter(a => a === 'sep' || a?.type === 'sep').length;
  const nodeCount = actions.filter(a => a?.type === 'node').length;
  const disabledHintCount = actions.filter((action) => action?.disabledReason).length;
  const menuH = itemCount * 30 + disabledHintCount * 24 + sepCount * 9 + nodeCount * 120 + 8;
  const left = Math.min(x, window.innerWidth - 204);
  const top = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left, top }}
      role="menu"
      onKeyDown={onMenuKeyDown}
    >
      {actions.map((action, i) =>
        action === 'sep' || action?.type === 'sep'
          ? <div key={i} className="ctx-sep" />
          : action?.type === 'node'
          ? <div key={i} className="ctx-node-item">{action.render()}</div>
          : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`ctx-item${action.danger ? ' danger' : ''}${action.disabledReason ? ' is-disabled' : ''}`}
              aria-disabled={action.disabledReason ? 'true' : undefined}
              aria-label={action.disabledReason ? `${action.label}. ${action.disabledReason}` : undefined}
              title={action.disabledReason || undefined}
              onClick={() => {
                if (action.disabledReason) return;
                action.fn();
                onClose();
              }}
            >
              <span className="ctx-icon">{action.icon}</span>
              <span className="ctx-item-label">{action.label}</span>
              {/* La touche qui fait la même chose, telle que l'auteur l'a
                  configurée : le menu enseigne le clavier. */}
              {action.shortcut ? <kbd className="ctx-shortcut">{action.shortcut}</kbd> : null}
              {action.disabledReason ? <span className="ctx-disabled-hint">{action.disabledReason}</span> : null}
            </button>
          )
      )}
    </div>
  );
}
