import { Toggle } from '../common/Toggle';

function playbackSummaryText(summary) {
  if (summary.total === 0) {
    return 'Le réglage s’appliquera aux histoires du pack.';
  }
  if (summary.mode === 'mixed') {
    const stays = summary.stays ? ` · ${summary.stays} restent sur le message` : '';
    return `${summary.waitingOk} histoires attendent un appui sur OK · ${summary.autoPlay} continuent automatiquement${stays}`;
  }
  if (summary.mode === 'wait') {
    return `${summary.total} histoire${summary.total > 1 ? 's attendent' : ' attend'} un appui sur OK.`;
  }
  return `${summary.total} histoire${summary.total > 1 ? 's continuent' : ' continue'} automatiquement.`;
}

function playbackExplanationText(mode) {
  if (mode === 'mixed') {
    return 'Certaines histoires continuent automatiquement, d’autres attendent un appui sur OK.';
  }
  if (mode === 'wait') {
    return 'L’enfant reste sur le message de fin tant qu’il n’a pas appuyé sur OK.';
  }
  return 'La destination suivante s’ouvre dès la fin du message.';
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
          Automatiquement
        </button>
        <Toggle
          on={waitForOk}
          mixed={mixed}
          onChange={(nextWaitForOk) => onChange?.(!nextWaitForOk)}
          ariaLabel={mixed
            ? 'Réglage mixte importé ; cliquer pour faire attendre un appui sur OK à toutes les histoires'
            : 'Attendre un appui sur OK après le message de fin'}
        />
        <button
          type="button"
          className={`end-message-playback-label${summary.mode === 'wait' ? ' is-active' : ''}`}
          onClick={() => onChange?.(false)}
        >
          Après appui sur OK
        </button>
      </div>
      <div className="end-message-playback-explanation">
        {playbackExplanationText(summary.mode)}
      </div>
      <div className={`end-message-playback-summary${mixed ? ' is-mixed' : ''}`}>
        {mixed ? <strong>Réglage mixte importé</strong> : null}
        <span>{playbackSummaryText(summary)}</span>
      </div>
    </div>
  );
}
