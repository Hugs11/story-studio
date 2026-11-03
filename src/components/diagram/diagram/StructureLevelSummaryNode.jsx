import { Trans } from 'react-i18next';
import { useTreeTranslation } from '../../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../../i18n/treePresentation.js';
import { SquareStack } from '../../icons/LucideLocal';

export function StructureLevelSummaryNode({ entry, onExpand }) {
  useTreeTranslation();
  return (
    <button
      type="button"
      className="fd-complete-node fd-structure-summary-node"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onExpand?.(entry.id);
      }}
      title={t("tree:diagram.stories.expandCount", { count: entry.storyCount })}
    >
      <span className="fd-structure-summary-visual" aria-hidden="true">
        <SquareStack className="fd-structure-summary-icon" />
        <span className="fd-structure-summary-meta">
          <Trans
            i18nKey="tree:diagram.stories.unit"
            count={entry.storyCount}
            components={{
              number: <span className="fd-structure-summary-count" />,
              unit: <span className="fd-structure-summary-label" />,
            }}
          />
        </span>
      </span>
      <span className="fd-structure-summary-action">{t("tree:diagram.stories.expand")}</span>
    </button>
  );
}
