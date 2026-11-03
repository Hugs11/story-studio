import { useTreeTranslation } from '../../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../../i18n/treePresentation.js';
import { Focus, IterationCcw, SquareStack } from '../../icons/LucideLocal';

export function DiagramViewToggles({
  showReturns,
  onShowReturnsChange,
  focusMode,
  onFocusModeToggle,
  canFocusBranch,
  hasExpandedStoryGroups,
  onCollapseAllStories,
}) {
  useTreeTranslation();
  return (
    <div className="fd-complete-viewbar" aria-label={t("tree:diagram.view.aria")}>
      <button
        type="button"
        className={`fd-diagram-option ${showReturns ? 'is-active' : ''}`}
        aria-label={t("tree:diagram.returns.show")}
        aria-pressed={showReturns}
        title={t("tree:diagram.returns.show")}
        onClick={() => onShowReturnsChange(!showReturns)}
      >
        <IterationCcw />
        <span className="fd-ctrl-label">{t("tree:diagram.legend.returns")}</span>
      </button>
      <button
        type="button"
        className={`fd-diagram-option ${focusMode ? 'is-active' : ''}`}
        aria-label={canFocusBranch ? t("tree:diagram.focus.selected") : t("tree:diagram.focus.choose")}
        aria-pressed={focusMode}
        title={canFocusBranch ? t("tree:diagram.focus.selected") : t("tree:diagram.focus.choose")}
        disabled={!canFocusBranch}
        onClick={onFocusModeToggle}
      >
        <Focus />
        <span className="fd-ctrl-label fd-ctrl-label--full">{t("tree:diagram.focus.branch")}</span>
        <span className="fd-ctrl-label fd-ctrl-label--short">{t("tree:diagram.focus.short")}</span>
      </button>
      {hasExpandedStoryGroups ? (
        <button
          type="button"
          className="fd-diagram-option"
          aria-label={t("tree:diagram.stories.collapseAll")}
          title={t("tree:diagram.stories.collapseHint")}
          onClick={onCollapseAllStories}
        >
          <SquareStack />
          <span className="fd-ctrl-label fd-ctrl-label--full">{t("tree:diagram.stories.collapseAll")}</span>
          <span className="fd-ctrl-label fd-ctrl-label--short">{t("tree:diagram.stories.collapseShort")}</span>
        </button>
      ) : null}
    </div>
  );
}
