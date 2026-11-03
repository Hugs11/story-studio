import { useTreeTranslation } from '../../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../../i18n/treePresentation.js';
export function StructureFocusBar({ focus, pinned, onClear }) {
  useTreeTranslation();
  if (!focus) return null;
  return (
    <div className={`fd-structure-focus-bar ${pinned ? 'is-pinned' : ''}`} role="status">
      <div className="fd-structure-focus-main">
        <span className="fd-structure-focus-depth">{t('tree:node.folder.depthBadge', { level: focus.targetDepth })}</span>
        <span className="fd-structure-focus-relation">
          {focus.parentLabel}
          <span aria-hidden="true">→</span>
          {focus.targetLabel}
        </span>
      </div>
      <div className="fd-structure-focus-breadcrumb" title={focus.breadcrumb.join(' › ')}>
        {focus.breadcrumb.join(' › ')}
      </div>
      {pinned ? (
        <button type="button" className="fd-structure-focus-clear" onClick={onClear} title={t("tree:diagram.structure.release")}>
          ×
        </button>
      ) : (
        <span className="fd-structure-focus-hint">{t("tree:diagram.structure.pin")}</span>
      )}
    </div>
  );
}
