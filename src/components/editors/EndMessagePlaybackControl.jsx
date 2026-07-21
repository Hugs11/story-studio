import { Toggle } from '../common/Toggle';

function playbackSummaryText(summary) {
  if (summary.total === 0) {
    return 'Le réglage s’appliquera aux histoires du pack.';
  }
  if (summary.mode === 'mixed') {
    const stays = summary.stays ? ` · ${summary.stays} restent sur le message` : '';
    return `${summary.waitingOk} attendent OK · ${summary.autoPlay} enchaînent automatiquement${stays}`;
  }
  if (summary.mode === 'wait') {
    return `${summary.total} histoire${summary.total > 1 ? 's attendent' : ' attend'} une confirmation.`;
  }
  return `${summary.total} histoire${summary.total > 1 ? 's enchaînent' : ' enchaîne'} automatiquement.`;
}

export function EndMessagePlaybackControl({ summary, onChange }) {
  const waitForOk = summary.mode === 'wait';
  const mixed = summary.mode === 'mixed';

  return (
    <div className="end-message-playback-control">
      <div className="end-message-playback-choice">
        <button
          type="button"
          className={`end-message-playback-label${summary.mode === 'auto' ? ' is-active' : ''}`}
          onClick={() => onChange?.(true)}
        >
          Automatique
        </button>
        <Toggle
          on={waitForOk}
          mixed={mixed}
          onChange={(nextWaitForOk) => onChange?.(!nextWaitForOk)}
          ariaLabel={mixed
            ? 'Réglage mixte ; cliquer pour faire attendre toutes les histoires'
            : 'Attendre une confirmation après le message de fin'}
        />
        <button
          type="button"
          className={`end-message-playback-label${summary.mode === 'wait' ? ' is-active' : ''}`}
          onClick={() => onChange?.(false)}
        >
          Attendre OK
        </button>
      </div>
      <div className={`end-message-playback-summary${mixed ? ' is-mixed' : ''}`}>
        {mixed ? <strong>Réglage mixte importé</strong> : null}
        <span>{playbackSummaryText(summary)}</span>
      </div>
    </div>
  );
}
