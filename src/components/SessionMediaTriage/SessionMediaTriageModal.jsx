import { useState } from 'react';
import { AppModalPortal } from '../common/AppModalPortal';
import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { pathKey } from '../../utils/fileUtils';
import './SessionMediaTriageModal.css';

// Sous-dossier de session d'origine (voix-generees, enregistrements…) : aide à
// reconnaître une prise IA d'un import. Dernier segment de dossier du chemin.
function parentFolderHint(path) {
  const segments = String(path).replace(/\\/g, '/').split('/');
  return segments.length >= 2 ? segments[segments.length - 2] : '';
}

/**
 * Tri des médias de session non utilisés à la promotion.
 * Tout est coché par défaut ; « Conserver la sélection » copie les cochés dans
 * le workspace, « Tout abandonner » les laisse partir avec la session.
 * Escape et clic hors de la boîte valent « Conserver la sélection » (choix sûr).
 */
export function SessionMediaTriageModal({ items, onResolve }) {
  const [checkedKeys, setCheckedKeys] = useState(() => new Set(items.map((item) => pathKey(item.path))));

  function toggle(path) {
    const key = pathKey(path);
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function confirmKeepSelection() {
    onResolve({ keptPaths: items.filter((item) => checkedKeys.has(pathKey(item.path))).map((item) => item.path) });
  }

  useEscapeKey(true, confirmKeepSelection);

  return (
    <AppModalPortal className="session-triage-overlay">
      <div className="session-triage-backdrop" onClick={confirmKeepSelection}>
        <div className="modal-box session-triage-box" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>Médias non utilisés</span>
          </div>
          <div className="session-triage-body">
            <p className="session-triage-intro">
              {items.length === 1
                ? '1 média de ta session n’est utilisé par aucune histoire.'
                : `${items.length} médias de ta session ne sont utilisés par aucune histoire.`}
              {' '}Coche ceux à conserver avec le projet ; les autres seront supprimés avec la session.
            </p>
            <ul className="session-triage-list">
              {items.map((item) => (
                <li key={item.path}>
                  <label className="session-triage-item">
                    <input
                      type="checkbox"
                      checked={checkedKeys.has(pathKey(item.path))}
                      onChange={() => toggle(item.path)}
                    />
                    <span className="session-triage-name" title={item.path}>{item.filename}</span>
                    {parentFolderHint(item.path) && (
                      <span className="session-triage-hint">{parentFolderHint(item.path)}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div className="session-triage-footer">
            <Button variant="danger-outline" onClick={() => onResolve({ keptPaths: [] })}>
              Tout abandonner
            </Button>
            <Button variant="primary" onClick={confirmKeepSelection}>
              Conserver la sélection
            </Button>
          </div>
        </div>
      </div>
    </AppModalPortal>
  );
}
