import { useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../i18n/treePresentation.js";
import { Toggle } from '../common/Toggle';

function playbackSummaryText(summary) {
  if (summary.total === 0) {
    return t("tree:endPlayback.empty.summary");
  }
  if (summary.mode === 'mixed') {
    const stays = summary.stays ? t("tree:endPlayback.mixed.stays", { count: summary.stays }) : "";
    return t("tree:endPlayback.mixed.summary", { waiting: t("tree:endPlayback.mixed.waiting", { count: summary.waitingOk }), auto: t("tree:endPlayback.mixed.auto", { count: summary.autoPlay }), stays });
  }
  if (summary.mode === 'wait') {
    return t("tree:endPlayback.wait.summary", { count: summary.total });
  }
  return t("tree:endPlayback.auto.summary", { count: summary.total });
}

function playbackExplanationText(mode) {
  if (mode === 'mixed') {
    return t("tree:endPlayback.mixed.explanation");
  }
  if (mode === 'wait') {
    return t("tree:endPlayback.wait.explanation");
  }
  return t("tree:endPlayback.auto.explanation");
}

export function EndMessagePlaybackControl({ summary, onChange }) {
  useTreeTranslation();
  const waitForOk = summary.mode === 'wait';
  const mixed = summary.mode === 'mixed';

  return (
    <div className="end-message-playback-control">
      <div className="end-message-playback-choice">
        <button
          type="button"
          className={`end-message-playback-label${summary.mode === 'auto' ? ' is-active' : ''}`}
          onClick={() => onChange?.(true)}
        >{t("tree:endPlayback.auto.action")}</button>
        <Toggle
          on={waitForOk}
          mixed={mixed}
          onChange={(nextWaitForOk) => onChange?.(!nextWaitForOk)}
          ariaLabel={mixed
            ? t("tree:endPlayback.mixed.aria")
            : t("tree:endPlayback.wait.aria")}
        />
        <button
          type="button"
          className={`end-message-playback-label${summary.mode === 'wait' ? ' is-active' : ''}`}
          onClick={() => onChange?.(false)}
        >{t("tree:endPlayback.wait.action")}</button>
      </div>
      <div className="end-message-playback-explanation">
        {playbackExplanationText(summary.mode)}
      </div>
      <div className={`end-message-playback-summary${mixed ? ' is-mixed' : ''}`}>
        {mixed ? <strong>{t("tree:endPlayback.mixed.badge")}</strong> : null}
        <span>{playbackSummaryText(summary)}</span>
      </div>
    </div>
  );
}
