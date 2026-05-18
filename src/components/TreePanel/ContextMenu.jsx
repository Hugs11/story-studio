import { useEffect, useRef } from 'react';
import './ContextMenu.css';

export function ContextMenu({ x, y, onClose, actions }) {
  const ref = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    // Délai pour éviter que le mousedown du clic droit ne referme le menu immédiatement
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
    }, 100);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const itemCount = actions.filter(a => a !== 'sep' && a?.type !== 'sep' && a?.type !== 'node').length;
  const sepCount = actions.filter(a => a === 'sep' || a?.type === 'sep').length;
  const nodeCount = actions.filter(a => a?.type === 'node').length;
  const menuH = itemCount * 30 + sepCount * 9 + nodeCount * 120 + 8;
  const left = Math.min(x, window.innerWidth - 204);
  const top = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top }}>
      {actions.map((action, i) =>
        action === 'sep' || action?.type === 'sep'
          ? <div key={i} className="ctx-sep" />
          : action?.type === 'node'
          ? <div key={i} className="ctx-node-item">{action.render()}</div>
          : (
            <button key={i} className={`ctx-item${action.danger ? ' danger' : ''}`} onClick={() => { action.fn(); onClose(); }}>
              <span className="ctx-icon">{action.icon}</span>
              {action.label}
            </button>
          )
      )}
    </div>
  );
}
